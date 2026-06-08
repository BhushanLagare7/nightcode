/**
 * @file InputBar component with file mention and command menu support.
 *
 * Provides a rich textarea input that supports:
 * - `@mention` file/directory completion with fuzzy fallback search
 * - `/command` menu for executing built-in actions
 * - Keyboard layer management for nested UI interactions
 * - Mode toggling between BUILD and PLAN modes
 */

import { Mode } from "@nightcode/database/enums";
import {
  ScrollBoxRenderable,
  TextAttributes,
  type KeyBinding,
  type TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useNavigate } from "react-router";
import { useDialog } from "../providers/dialog";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { usePromptConfig } from "../providers/prompt-config";
import { useTheme } from "../providers/theme";
import { useToast } from "../providers/toast";
import { EmptyBorder } from "./border";
import { CommandMenu } from "./command-menu";
import type { Command } from "./command-menu/types";
import { useCommandMenu } from "./command-menu/use-command-menu";
import { StatusBar } from "./status-bar";

/** Maximum number of mention candidates visible in the dropdown at one time. */
const MAX_VISIBLE_MENTIONS = 8;

/** The working directory at process startup, used to scope file lookups. */
const CURRENT_DIRECTORY = process.cwd();

/**
 * Maximum number of candidates returned by the recursive fallback search
 * when no direct matches are found in the immediate directory.
 */
const MAX_FALLBACK_MENTION_CANDIDATES = 32;

/**
 * Characters that are valid within a mention query path segment.
 * Matches alphanumerics plus `.`, `_`, `/`, and `-`.
 */
const MENTION_QUERY_CHARACTER = /[A-Za-z0-9._/-]/;

/**
 * Directory names that are unconditionally skipped during recursive
 * fallback mention searches to avoid traversing large dependency trees.
 */
const RECURSIVE_MENTION_IGNORED_DIRECTORIES = new Set(["node_modules"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Represents the position and content of an active `@mention` token found
 * within the textarea text at the current cursor position.
 */
type MentionMatch = {
  /** Inclusive index of the `@` character within the full textarea string. */
  start: number;
  /** Exclusive index of the last character of the mention token. */
  end: number;
  /** The raw query string that follows the `@` character. */
  query: string;
};

/**
 * A single file-system entry that can be inserted as a mention completion.
 */
type MentionCandidate = {
  /**
   * Path relative to the current working directory.
   * Directories always end with a trailing `/`.
   */
  path: string;
  /** Whether this entry represents a directory or a regular file. */
  kind: "file" | "directory";
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `targetPath` is the current working directory itself
 * or is nested beneath it, preventing the mention picker from escaping the
 * project root via `../` sequences.
 *
 * @param targetPath - Absolute path to test.
 */
function isWithinCurrentDirectory(targetPath: string) {
  const relativePath = relative(CURRENT_DIRECTORY, targetPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

/**
 * Returns `true` when `character` is a valid mention-query character (i.e.
 * it can appear as part of a file path following the `@` sigil).
 *
 * @param character - Single character to test.
 */
function isMentionQueryCharacter(character: string) {
  return MENTION_QUERY_CHARACTER.test(character);
}

/**
 * Scans `text` around `cursorOffset` to locate an active `@mention` token.
 *
 * Algorithm:
 * 1. Expand outward from the cursor to find the surrounding non-whitespace
 *    token boundaries.
 * 2. Locate the last `@` within that token that is not immediately preceded
 *    by a mention-query character (which would make it part of a path, not a
 *    sigil).
 * 3. Verify the cursor lies within the mention extent.
 *
 * @param text         - Full textarea content.
 * @param cursorOffset - Current caret position (character index).
 * @returns A {@link MentionMatch} when the cursor is inside an `@mention`, or
 *   `null` otherwise.
 */
function findActiveMention(
  text: string,
  cursorOffset: number,
): MentionMatch | null {
  // Clamp the offset to a valid range.
  const safeOffset = Math.max(0, Math.min(cursorOffset, text.length));

  // Walk left to the start of the surrounding non-whitespace token.
  let start = safeOffset;
  while (start > 0 && !/\s/.test(text[start - 1]!)) {
    start -= 1;
  }

  // Walk right to the end of the surrounding non-whitespace token.
  let end = safeOffset;
  while (end < text.length && !/\s/.test(text[end]!)) {
    end += 1;
  }

  const token = text.slice(start, end);
  const relativeCursor = safeOffset - start;

  // Find the last `@` at or before the cursor within this token.
  const mentionStart = token.lastIndexOf("@", relativeCursor);
  if (mentionStart === -1) {
    return null;
  }

  // Reject if the `@` is preceded by a path character (not a sigil).
  const previousCharacter = token[mentionStart - 1];
  if (previousCharacter && isMentionQueryCharacter(previousCharacter)) {
    return null;
  }

  // Extend the mention to the right while path characters continue.
  let mentionEnd = mentionStart + 1;
  while (
    mentionEnd < token.length &&
    isMentionQueryCharacter(token[mentionEnd]!)
  ) {
    mentionEnd += 1;
  }

  // Confirm the cursor is actually inside the mention span.
  if (relativeCursor < mentionStart || relativeCursor > mentionEnd) {
    return null;
  }

  return {
    start: start + mentionStart,
    end: start + mentionEnd,
    query: token.slice(mentionStart + 1, mentionEnd),
  };
}

/**
 * Resolves a list of file-system candidates that match the given mention
 * `query` string.
 *
 * Resolution strategy:
 * 1. Absolute paths and paths that escape the project root are rejected
 *    immediately.
 * 2. The query is split into a directory prefix and a name prefix.
 * 3. The immediate directory is listed; entries whose names start with the
 *    name prefix are returned, sorted directories-first then lexicographically.
 * 4. When the immediate listing yields no matches **and** the query has no
 *    explicit directory prefix, a bounded recursive search is performed across
 *    the entire project tree (skipping {@link RECURSIVE_MENTION_IGNORED_DIRECTORIES}).
 *
 * @param query - The raw text following the `@` sigil (e.g. `"src/comp"`).
 * @returns Sorted array of matching {@link MentionCandidate} entries, or an
 *   empty array when no matches exist or the query is out-of-scope.
 */
async function getMentionCandidates(
  query: string,
): Promise<MentionCandidate[]> {
  // Normalize a leading `./` so both forms resolve identically.
  const normalizedQuery = query.startsWith("./") ? query.slice(2) : query;

  // Absolute paths are not supported.
  if (normalizedQuery.startsWith("/")) {
    return [];
  }

  const hasTrailingSlash = normalizedQuery.endsWith("/");
  const lastSlashIndex = hasTrailingSlash
    ? normalizedQuery.length - 1
    : normalizedQuery.lastIndexOf("/");

  // Split the query into the directory portion and the filename prefix.
  const directoryPart = hasTrailingSlash
    ? normalizedQuery.slice(0, -1)
    : lastSlashIndex === -1
      ? ""
      : normalizedQuery.slice(0, lastSlashIndex);

  const namePrefix = hasTrailingSlash
    ? ""
    : lastSlashIndex === -1
      ? normalizedQuery
      : normalizedQuery.slice(lastSlashIndex + 1);

  // Guard against path traversal outside the project root.
  const absoluteDirectory = resolve(CURRENT_DIRECTORY, directoryPart || ".");
  if (!isWithinCurrentDirectory(absoluteDirectory)) {
    return [];
  }

  try {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    const lowercasePrefix = namePrefix.toLowerCase();

    // Only show dot-files when the user has explicitly typed a leading `.`.
    const showHiddenEntries = namePrefix.startsWith(".");

    const directMatches = entries
      .filter((entry) => showHiddenEntries || !entry.name.startsWith("."))
      .filter((entry) => {
        return (
          lowercasePrefix === "" ||
          entry.name.toLowerCase().startsWith(lowercasePrefix)
        );
      })
      .sort((left, right) => {
        // Directories sort before files; ties are broken alphabetically.
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      })
      .map((entry) => {
        const path = directoryPart
          ? `${directoryPart}/${entry.name}`
          : entry.name;
        const kind: MentionCandidate["kind"] = entry.isDirectory()
          ? "directory"
          : "file";
        return {
          // Directories receive a trailing slash to invite further narrowing.
          path: kind === "directory" ? `${path}/` : path,
          kind,
        };
      });

    // Return direct matches when they exist, or when we already know the
    // directory/name split, so a recursive search would not add value.
    if (directMatches.length > 0 || directoryPart !== "" || namePrefix === "") {
      return directMatches;
    }

    // Fallback: recursively walk the whole project tree, collecting up to
    // MAX_FALLBACK_MENTION_CANDIDATES entries whose names match the prefix.
    const fallbackMatches: MentionCandidate[] = [];

    const visit = async (
      absoluteDirectory: string,
      directoryPart: string,
    ): Promise<void> => {
      const entries = await readdir(absoluteDirectory, { withFileTypes: true });

      for (const entry of entries) {
        if (!showHiddenEntries && entry.name.startsWith(".")) {
          continue;
        }

        // Skip blocklisted directories (e.g. node_modules).
        if (
          entry.isDirectory() &&
          RECURSIVE_MENTION_IGNORED_DIRECTORIES.has(entry.name)
        ) {
          continue;
        }

        const path = directoryPart
          ? `${directoryPart}/${entry.name}`
          : entry.name;
        const kind: MentionCandidate["kind"] = entry.isDirectory()
          ? "directory"
          : "file";

        if (entry.name.toLowerCase().startsWith(lowercasePrefix)) {
          fallbackMatches.push({
            path: kind === "directory" ? `${path}/` : path,
            kind,
          });

          // Stop early once the candidate cap is reached.
          if (fallbackMatches.length >= MAX_FALLBACK_MENTION_CANDIDATES) {
            return;
          }
        }

        // Recurse into subdirectories.
        if (entry.isDirectory()) {
          await visit(resolve(absoluteDirectory, entry.name), path);
          if (fallbackMatches.length >= MAX_FALLBACK_MENTION_CANDIDATES) {
            return;
          }
        }
      }
    };

    await visit(CURRENT_DIRECTORY, "");

    return fallbackMatches.sort((left, right) =>
      left.path.localeCompare(right.path),
    );
  } catch {
    // Any I/O error (e.g. permission denied) silently returns an empty list.
    return [];
  }
}

// ---------------------------------------------------------------------------
// FileMentionMenu component
// ---------------------------------------------------------------------------

/** Props for the {@link FileMentionMenu} dropdown. */
type FileMentionMenuProps = {
  /** Ordered list of file-system entries to display. */
  candidates: MentionCandidate[];
  /** Zero-based index of the currently highlighted row. */
  selectedIndex: number;
  /** Ref forwarded to the inner scroll box for programmatic scrolling. */
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  /**
   * Called when the pointer hovers over a row, passing the row's index so the
   * caller can update `selectedIndex` without committing a selection.
   */
  onSelect: (index: number) => void;
  /**
   * Called when a row is clicked (mouse-down) or the user presses Enter,
   * passing the index of the candidate to insert.
   */
  onExecute: (index: number) => void;
};

/**
 * Dropdown menu that lists file and directory candidates for `@mention`
 * completion.
 *
 * - Renders a placeholder when `candidates` is empty.
 * - Highlights the selected row using the theme's selection color.
 * - Integrates a scroll box so that lists longer than
 *   {@link MAX_VISIBLE_MENTIONS} entries remain navigable.
 */
function FileMentionMenu({
  candidates,
  selectedIndex,
  scrollRef,
  onSelect,
  onExecute,
}: FileMentionMenuProps) {
  const { colors } = useTheme();
  const visibleHeight = Math.min(candidates.length, MAX_VISIBLE_MENTIONS);

  if (candidates.length === 0) {
    return (
      <box paddingX={1}>
        <text attributes={TextAttributes.DIM}>
          No matching files or folders
        </text>
      </box>
    );
  }

  return (
    <scrollbox ref={scrollRef} height={visibleHeight}>
      {candidates.map((candidate, index) => {
        const isSelected = index === selectedIndex;

        return (
          <box
            key={candidate.path}
            backgroundColor={isSelected ? colors.selection : undefined}
            flexDirection="row"
            height={1}
            overflow="hidden"
            paddingX={1}
            onMouseDown={() => onExecute(index)}
            onMouseMove={() => onSelect(index)}
          >
            {/* Path label — grows to fill available width */}
            <box flexGrow={1} flexShrink={1} overflow="hidden">
              <text fg={isSelected ? "black" : "white"} selectable={false}>
                {candidate.path}
              </text>
            </box>

            {/* Kind badge ("File" / "Folder") — fixed width, right-aligned */}
            <box alignItems="flex-end" flexShrink={0} width={8}>
              <text fg={isSelected ? "black" : "gray"} selectable={false}>
                {candidate.kind === "directory" ? "Folder" : "File"}
              </text>
            </box>
          </box>
        );
      })}
    </scrollbox>
  );
}

// ---------------------------------------------------------------------------
// InputBar component
// ---------------------------------------------------------------------------

/** Props accepted by the {@link InputBar} component. */
type InputBarProps = {
  /**
   * Callback invoked with the trimmed textarea content whenever the user
   * submits the prompt (Enter without Shift, or Enter when no overlay menu
   * is active).
   */
  onSubmit: (text: string) => void;
  /**
   * When `true`, all keyboard interactions and submission are suppressed and
   * the textarea loses focus.  Defaults to `false`.
   */
  disabled?: boolean;
};

/**
 * Key bindings injected into the underlying `<textarea>` element.
 *
 * - Plain Enter / Return → triggers the `"submit"` action.
 * - Shift+Enter / Shift+Return → inserts a literal newline.
 */
export const TEXTAREA_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "enter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "enter", shift: true, action: "newline" },
];

/**
 * Primary prompt input component.
 *
 * Responsibilities:
 * - Renders a bordered multi-line textarea with a {@link StatusBar}.
 * - Detects `@mention` tokens as the user types and shows a
 *   {@link FileMentionMenu} overlay populated from the local file system.
 * - Shows a {@link CommandMenu} overlay when the text begins with `/`.
 * - Manages a layered keyboard system so that overlay navigation keys
 *   (↑ ↓ Escape) are captured before they reach the underlying textarea.
 * - Forwards submission to the `onSubmit` prop after clearing the textarea.
 * - Toggles prompt mode (BUILD ↔ PLAN) on Tab.
 * - Clears the textarea on Ctrl+C (via the `"base"` keyboard layer responder).
 *
 * @example
 * ```tsx
 * <InputBar onSubmit={(text) => sendMessage(text)} />
 * ```
 */
export function InputBar({ onSubmit, disabled = false }: InputBarProps) {
  const { mode, toggleMode, setMode, setModel } = usePromptConfig();

  /** Ref to the raw textarea node for imperative text manipulation. */
  const textareaRef = useRef<TextareaRenderable>(null);

  /**
   * Stable ref holding the latest submit handler so the textarea's
   * `onSubmit` callback (registered once) always calls current logic.
   */
  const onSubmitRef = useRef<() => void>(() => {});

  /**
   * Ref mirror of `activeMention` state, kept in sync so async callbacks
   * always read the latest value without triggering re-renders.
   */
  const activeMentionRef = useRef<MentionMatch | null>(null);

  /** Ref forwarded to the mention dropdown's scroll box. */
  const mentionScrollRef = useRef<ScrollBoxRenderable>(null);

  /** The currently active mention token, or `null` when no mention is open. */
  const [activeMention, setActiveMention] = useState<MentionMatch | null>(null);

  /** Resolved file-system candidates for the active mention query. */
  const [mentionCandidates, setMentionCandidates] = useState<
    MentionCandidate[]
  >([]);

  /** Zero-based index of the highlighted row in the mention dropdown. */
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);

  const renderer = useRenderer();
  const toast = useToast();
  const dialog = useDialog();
  const { isTopLayer, setResponder, push, pop } = useKeyboardLayer();
  const { colors } = useTheme();
  const navigate = useNavigate();

  const {
    commandQuery,
    handleContentChange,
    resolveCommand,
    setSelectedIndex,
    selectedIndex,
    showCommandMenu,
    scrollRef,
  } = useCommandMenu();

  /** Derived flag: whether the mention dropdown should be visible. */
  const showMentionMenu = activeMention !== null;

  /**
   * Tears down the mention dropdown: clears state, ref, and removes the
   * `"mention"` keyboard layer so normal key handling resumes.
   */
  const closeMentionMenu = useCallback(() => {
    activeMentionRef.current = null;
    setActiveMention(null);
    setMentionCandidates([]);
    pop("mention");
  }, [pop]);

  /**
   * Reconciles the mention dropdown with the current textarea content and
   * cursor position.
   *
   * - Closes the menu when no mention token is detected.
   * - Pushes the `"mention"` keyboard layer (idempotent) when a token is
   *   found so overlay navigation keys are captured first.
   * - Resets the scroll position and selected index when the token changes.
   *
   * @param text         - Current full text content of the textarea.
   * @param cursorOffset - Current caret position within `text`.
   */
  const syncMentionMenu = useCallback(
    (text: string, cursorOffset: number) => {
      const nextMention = findActiveMention(text, cursorOffset);
      const previousMention = activeMentionRef.current;

      const mentionChanged =
        previousMention?.start !== nextMention?.start ||
        previousMention?.end !== nextMention?.end ||
        previousMention?.query !== nextMention?.query;

      if (!nextMention) {
        if (previousMention) {
          closeMentionMenu();
        }
        return;
      }

      activeMentionRef.current = nextMention;
      setActiveMention(nextMention);

      // Push the mention layer so overlay keys are handled before base keys.
      push("mention", () => {
        closeMentionMenu();
        return true;
      });

      if (mentionChanged) {
        setMentionSelectedIndex(0);
        mentionScrollRef.current?.scrollTo(0);
      }
    },
    [closeMentionMenu, push],
  );

  /**
   * Handles `onContentChange` events from the textarea.
   *
   * Forwards the plain-text content to the command-menu hook and then
   * re-evaluates the active mention at the current cursor position.
   */
  const handleTextareaContentChange = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const text = textarea.plainText;
    handleContentChange(text);
    syncMentionMenu(text, textarea.cursorOffset);
  }, [handleContentChange, syncMentionMenu]);

  /**
   * Completes the mention at `index` by replacing the active `@mention` token
   * with the selected candidate path, then re-synchronies the mention menu
   * in case the inserted path itself ends with `/` and opens a subdirectory.
   *
   * @param index - Index into `mentionCandidates` to insert.
   */
  const handleMentionExecute = useCallback(
    (index: number) => {
      const textarea = textareaRef.current;
      const mention = activeMentionRef.current;
      const candidate = mentionCandidates[index];

      if (!textarea || !mention || !candidate) return;

      // For directories, keep the trailing slash so the user can keep typing.
      // For files, append a space so the cursor lands ready for the next word.
      const insertion =
        candidate.kind === "directory" ? candidate.path : `${candidate.path} `;

      const nextText =
        `${textarea.plainText.slice(0, mention.start)}@${insertion}` +
        textarea.plainText.slice(mention.end);

      textarea.replaceText(nextText);
      textarea.cursorOffset = mention.start + insertion.length + 1;
      syncMentionMenu(nextText, textarea.cursorOffset);
    },
    [mentionCandidates, syncMentionMenu],
  );

  /**
   * Handles cursor-position changes within the textarea (without text
   * changes) so the mention menu correctly appears/disappears as the user
   * moves the caret in and out of an `@mention` token.
   */
  const handleTextareaCursorChange = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    syncMentionMenu(textarea.plainText, textarea.cursorOffset);
  }, [syncMentionMenu]);

  /**
   * Submits the current textarea content via the `onSubmit` prop and clears
   * the textarea.  No-ops when `disabled` is `true` or the trimmed text is
   * empty.
   */
  const handleSubmit = useCallback(() => {
    if (disabled) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const text = textarea.plainText.trim();
    if (text.length === 0) return;

    onSubmit(text);
    textarea.setText("");
  }, [disabled, onSubmit]);

  /**
   * Dispatches a resolved {@link Command}.
   *
   * - Clears the textarea first.
   * - If the command carries an `action` function, it is called with
   *   contextual helpers (renderer, toast, dialog, navigate, mode setters).
   * - Otherwise the command's `value` is inserted as a text prefix so the
   *   user can complete a templated prompt.
   *
   * @param command - The resolved command, or `undefined` to no-op.
   */
  const handleCommand = useCallback(
    (command: Command | undefined) => {
      const textarea = textareaRef.current;
      if (!textarea || !command) return;

      textarea.setText("");

      if (command.action) {
        command.action({
          exit: () => renderer.destroy(),
          toast,
          dialog,
          navigate,
          mode,
          setMode,
          setModel,
        });
      } else {
        textarea.insertText(command.value + " ");
      }
    },
    [renderer, toast, dialog, navigate, mode, setMode, setModel],
  );

  /**
   * Executes the command at `index` in the command menu by resolving it and
   * delegating to {@link handleCommand}.
   *
   * @param index - Zero-based index within the visible command list.
   */
  const handleCommandExecute = useCallback(
    (index: number) => {
      const command = resolveCommand(index);
      if (command) {
        handleCommand(command);
      }
    },
    [resolveCommand, handleCommand],
  );

  // ---------------------------------------------------------------------------
  // Side effects
  // ---------------------------------------------------------------------------

  /**
   * Fetches mention candidates whenever the active mention query changes.
   *
   * Uses an `ignore` flag to discard stale async results if the query changes
   * again before the previous fetch resolves.
   */
  useEffect(() => {
    if (!activeMention) {
      setMentionCandidates([]);
      return;
    }

    let ignore = false;

    const loadCandidates = async () => {
      const nextCandidates = await getMentionCandidates(activeMention.query);
      if (ignore) return;

      setMentionCandidates(nextCandidates);
      setMentionSelectedIndex((currentIndex) => {
        if (nextCandidates.length === 0) return 0;
        return Math.min(currentIndex, nextCandidates.length - 1);
      });
    };

    void loadCandidates();

    return () => {
      ignore = true;
    };
  }, [activeMention]);

  /**
   * Wires up the textarea's `onSubmit` callback once on mount.
   *
   * The callback delegates to `onSubmitRef.current` so it always executes the
   * latest submit logic without requiring the event handler to be re-registered
   * every render.
   */
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.onSubmit = () => {
      onSubmitRef.current();
    };
  }, []);

  /**
   * Kept up-to-date every render so `textarea.onSubmit` (registered once)
   * always calls the latest version that closes the correct overlay or
   * submits the form.
   *
   * Priority order:
   * 1. Command menu is open → execute selected command.
   * 2. Mention menu is open and a candidate is highlighted → complete mention.
   * 3. Otherwise → submit the textarea content.
   */
  onSubmitRef.current = () => {
    if (disabled) return;

    if (showCommandMenu) {
      const command = resolveCommand(selectedIndex);
      handleCommand(command);
      return;
    }

    if (showMentionMenu) {
      const candidate = mentionCandidates[mentionSelectedIndex];
      if (candidate) {
        handleMentionExecute(mentionSelectedIndex);
        return;
      }
    }

    handleSubmit();
  };

  /**
   * Global keyboard handler for the Tab key.
   *
   * Toggles between BUILD and PLAN modes when the base keyboard layer is
   * active and the component is not disabled.
   */
  useKeyboard((key) => {
    if (disabled) return;
    if (!isTopLayer("base")) return;
    if (key.name === "tab") {
      key.preventDefault();
      toggleMode();
    }
  });

  /**
   * Registers a `"base"` keyboard layer responder that handles Ctrl+C by
   * clearing the textarea when it contains text, preventing accidental
   * application exit.
   *
   * Returns `true` to signal the event was consumed; `false` to let the
   * default Ctrl+C handler propagate.
   */
  useEffect(() => {
    setResponder("base", () => {
      if (disabled) return false;

      const textarea = textareaRef.current;
      if (textarea && textarea.plainText.length > 0) {
        textarea.setText("");
        return true;
      }

      return false;
    });

    return () => setResponder("base", null);
  }, [disabled, setResponder]);

  /**
   * Keyboard handler active only while the mention dropdown is visible and
   * owns the top keyboard layer.
   *
   * - **Escape** — closes the mention menu.
   * - **↑** — moves selection up; scrolls the list if the new row would be
   *   above the visible viewport.
   * - **↓** — moves selection down; scrolls the list if the new row would be
   *   below the visible viewport.
   */
  useKeyboard((key) => {
    if (disabled) return;
    if (!showMentionMenu || !isTopLayer("mention")) return;

    if (key.name === "escape") {
      key.preventDefault();
      closeMentionMenu();
    } else if (key.name === "up") {
      key.preventDefault();
      setMentionSelectedIndex((currentIndex) => {
        const nextIndex = Math.max(0, currentIndex - 1);
        const scrollbox = mentionScrollRef.current;

        // Scroll up if the newly selected row is above the visible window.
        if (scrollbox && nextIndex < scrollbox.scrollTop) {
          scrollbox.scrollTo(nextIndex);
        }

        return nextIndex;
      });
    } else if (key.name === "down") {
      key.preventDefault();
      setMentionSelectedIndex((currentIndex) => {
        if (mentionCandidates.length === 0) return 0;

        const nextIndex = Math.min(
          mentionCandidates.length - 1,
          currentIndex + 1,
        );
        const scrollbox = mentionScrollRef.current;

        // Scroll down if the newly selected row is below the visible window.
        if (scrollbox) {
          const viewportHeight = scrollbox.viewport.height;
          const visibleEnd = scrollbox.scrollTop + viewportHeight - 1;
          if (nextIndex > visibleEnd) {
            scrollbox.scrollTo(nextIndex - viewportHeight + 1);
          }
        }

        return nextIndex;
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <box alignItems="center" width="100%">
      {/* Outer border — color reflects the current prompt mode */}
      <box
        border={["left"]}
        borderColor={mode === Mode.BUILD ? colors.primary : colors.planMode}
        customBorderChars={{
          ...EmptyBorder,
          vertical: "┃",
          bottomLeft: "╹",
        }}
        width="100%"
      >
        <box
          backgroundColor={colors.surface}
          gap={1}
          justifyContent="center"
          paddingX={2}
          paddingY={1}
          position="relative"
          width="100%"
        >
          {/* Command menu overlay — rendered above the textarea */}
          {showCommandMenu && (
            <box
              backgroundColor={colors.surface}
              bottom="100%"
              left={0}
              position="absolute"
              width="100%"
              zIndex={10}
            >
              <CommandMenu
                query={commandQuery}
                scrollRef={scrollRef}
                selectedIndex={selectedIndex}
                onExecute={handleCommandExecute}
                onSelect={setSelectedIndex}
              />
            </box>
          )}

          {/* File mention overlay — only shown when command menu is closed */}
          {!showCommandMenu && showMentionMenu && (
            <box
              backgroundColor={colors.surface}
              bottom="100%"
              left={0}
              position="absolute"
              width="100%"
              zIndex={10}
            >
              <FileMentionMenu
                candidates={mentionCandidates}
                scrollRef={mentionScrollRef}
                selectedIndex={mentionSelectedIndex}
                onExecute={handleMentionExecute}
                onSelect={setMentionSelectedIndex}
              />
            </box>
          )}

          {/* Textarea — focused when the component is enabled and any
              compatible keyboard layer is on top */}
          <textarea
            ref={textareaRef}
            focused={
              !disabled &&
              (isTopLayer("base") ||
                isTopLayer("command") ||
                isTopLayer("mention"))
            }
            keyBindings={TEXTAREA_KEY_BINDINGS}
            placeholder={`Ask anything..."Fix a bug in the database"`}
            onContentChange={handleTextareaContentChange}
            onCursorChange={handleTextareaCursorChange}
          />

          <StatusBar />
        </box>
      </box>
    </box>
  );
}
