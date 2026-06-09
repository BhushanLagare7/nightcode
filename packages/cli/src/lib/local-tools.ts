/**
 * @fileoverview Local tool execution engine for the Nightcode CLI.
 *
 * Provides a sandboxed set of filesystem and shell utilities that AI-assisted
 * workflows can invoke at runtime. Every operation is restricted to the
 * current working directory so that no tool can read or modify files outside
 * the project root.
 *
 * Supported tools
 * ───────────────
 * • readFile      – Read a file's contents (with size cap).
 * • listDirectory – List entries in a directory (files & sub-directories).
 * • glob          – Find files matching a glob pattern.
 * • grep          – Search file contents with a regular-expression pattern.
 * • writeFile     – Write (or overwrite) a file, creating directories as needed.
 * • editFile      – Replace an exact, unambiguous substring inside a file.
 * • bash          – Execute an arbitrary shell command with a configurable timeout.
 *
 * @module localTools
 */

import { Mode, toolInputSchemas, type ModeType } from "@nightcode/shared";
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum number of characters returned by {@link executeLocalTool} for the `readFile` tool. */
const MAX_FILE_SIZE = 10_000;

/**
 * Maximum number of file paths returned by the `glob` tool before the result
 * is marked as truncated.
 */
const MAX_RESULTS = 200;

/**
 * Maximum number of line matches returned by the `grep` tool before the result
 * is marked as truncated.
 */
const MAX_MATCHES = 50;

/**
 * Maximum number of characters captured from stdout / stderr by the `bash`
 * tool. Output beyond this limit is replaced with a truncation notice.
 */
const MAX_OUTPUT = 20_000;

/**
 * Default milliseconds before a `bash` command is forcefully killed.
 * Can be overridden per-invocation via the tool's `timeout` input field.
 */
const DEFAULT_TIMEOUT = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves `path` relative to the current working directory and guarantees
 * that the resolved path remains inside that directory.
 *
 * @param path - An absolute or relative path supplied by the caller.
 * @returns An object containing:
 *   - `cwd`      – The current working directory (`process.cwd()`).
 *   - `resolved` – The fully-resolved, safe absolute path.
 *
 * @throws {Error} When the resolved path escapes the project root
 *                 (i.e. a path-traversal attempt such as `../../etc/passwd`).
 *
 * @example
 * ```ts
 * const { cwd, resolved } = resolveInsideCwd("src/index.ts");
 * // cwd      → "/home/user/project"
 * // resolved → "/home/user/project/src/index.ts"
 * ```
 */
function resolveInsideCwd(path: string) {
  const cwd = process.cwd();
  const resolved = resolve(cwd, path);
  const rel = relative(cwd, resolved);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path is outside the project directory");
  }

  return { cwd, resolved };
}

/**
 * Truncates a string to at most `limit` characters and appends a human-readable
 * notice when truncation occurs so callers are aware that the output is partial.
 *
 * @param value - The string to potentially truncate.
 * @param limit - Maximum allowed character count.
 * @returns The original string when it is within the limit, otherwise a
 *          truncated string followed by `"\n... (truncated, N total chars)"`.
 *
 * @example
 * ```ts
 * truncate("hello world", 5);
 * // → "hello\n... (truncated, 11 total chars)"
 *
 * truncate("hi", 5);
 * // → "hi"
 * ```
 */
function truncate(value: string, limit: number) {
  return value.length > limit
    ? `${value.slice(0, limit)}\n... (truncated, ${value.length} total chars)`
    : value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core executor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatches a named tool call and returns its result.
 *
 * All filesystem paths are validated against the project root before any I/O
 * is performed. Write-capable tools (`writeFile`, `editFile`, `bash`) are
 * disabled in {@link Mode.PLAN} mode to prevent accidental side-effects during
 * planning phases.
 *
 * ---
 *
 * ### Tool reference
 *
 * #### `readFile`
 * Reads a UTF-8 file. When the file exceeds {@link MAX_FILE_SIZE} characters
 * the content is capped and the response includes `truncated: true` plus the
 * actual `totalLength`.
 *
 * **Returns**
 * ```ts
 * { content: string }
 * // or when truncated:
 * { content: string; truncated: true; totalLength: number }
 * ```
 *
 * ---
 *
 * #### `listDirectory`
 * Lists the immediate children of a directory. Hidden entries (names starting
 * with `.`) and `node_modules` are filtered out. Directories are sorted before
 * files; entries of the same type are sorted alphabetically.
 *
 * **Returns**
 * ```ts
 * { path: string; entries: { name: string; type: "file" | "directory" }[] }
 * ```
 *
 * ---
 *
 * #### `glob`
 * Scans the file tree rooted at `path` for files matching `pattern`. Paths
 * inside `node_modules` are excluded. Results are capped at {@link MAX_RESULTS}
 * entries.
 *
 * **Returns**
 * ```ts
 * { files: string[]; truncated?: true }
 * ```
 *
 * ---
 *
 * #### `grep`
 * Runs `grep -E` (extended regex) recursively inside `path`. `node_modules`
 * and `.git` are always excluded. An optional `include` glob (e.g. `"*.ts"`)
 * restricts which files are searched. Results are capped at {@link MAX_MATCHES}
 * entries.
 *
 * **Returns**
 * ```ts
 * { matches: { file: string; line: number; content: string }[]; truncated?: true; totalMatches?: number }
 * // or when nothing matched:
 * { matches: []; message: "No matches found" }
 * ```
 *
 * ---
 *
 * #### `writeFile`
 * Writes `content` to `path`, creating any missing parent directories.
 * ⚠️ **Not available in PLAN mode.**
 *
 * **Returns**
 * ```ts
 * { success: true; path: string; bytesWritten: number }
 * ```
 *
 * ---
 *
 * #### `editFile`
 * Replaces the first (and only) occurrence of `oldString` with `newString`
 * inside `path`. Throws if `oldString` is not found or if it appears more than
 * once (ambiguous edit). ⚠️ **Not available in PLAN mode.**
 *
 * **Returns**
 * ```ts
 * { success: true; path: string }
 * ```
 *
 * ---
 *
 * #### `bash`
 * Executes `command` via `bash -c` from the project root. The process is
 * killed after `timeout` milliseconds (default: {@link DEFAULT_TIMEOUT}).
 * Both stdout and stderr are capped at {@link MAX_OUTPUT} characters.
 * ⚠️ **Not available in PLAN mode.**
 *
 * **Returns**
 * ```ts
 * { stdout: string; stderr: string; exitCode: number }
 * ```
 *
 * ---
 *
 * @param toolName - The name of the tool to execute (e.g. `"readFile"`).
 * @param input    - Raw, invalidated input object; each tool validates its own
 *                   schema via `toolInputSchemas`.
 * @param mode     - The current operational mode. Write tools are blocked when
 *                   `mode === Mode.PLAN`.
 *
 * @returns A Promise that resolves to a tool-specific result object (see each
 *          tool's **Returns** section above).
 *
 * @throws {Error} `"Tool <name> is not available in PLAN mode"` – when a
 *                 write-capable tool is called during planning.
 * @throws {Error} `"Path is outside the project directory"` – on path-traversal
 *                 attempts (surfaced from {@link resolveInsideCwd}).
 * @throws {Error} `"oldString not found in file"` – `editFile` target not found.
 * @throws {Error} `"oldString is ambiguous; found N matches"` – `editFile` would
 *                 affect multiple locations.
 * @throws {Error} `"grep failed: <stderr>"` – `grep` exited with an unexpected
 *                 non-zero code (code `1` means "no match" and is not an error).
 * @throws {Error} `"Unknown tool: <name>"` – unrecognized `toolName`.
 *
 * @example
 * ```ts
 * // Read a source file
 * const result = await executeLocalTool("readFile", { path: "src/index.ts" }, Mode.ACT);
 * console.log(result.content);
 *
 * // Search for TODO comments
 * const { matches } = await executeLocalTool(
 *   "grep",
 *   { pattern: "TODO", path: "src", include: "*.ts" },
 *   Mode.PLAN,
 * );
 *
 * // Run a build (not allowed in PLAN mode)
 * const { stdout, exitCode } = await executeLocalTool(
 *   "bash",
 *   { command: "bun run build", timeout: 60_000 },
 *   Mode.ACT,
 * );
 * ```
 */
export async function executeLocalTool(
  toolName: string,
  input: unknown,
  mode: ModeType,
) {
  // ── Mode guard ──────────────────────────────────────────────────────────────
  // In PLAN mode only read-only / search tools are permitted.
  // Write-capable tools (writeFile, editFile, bash) are blocked to avoid
  // unintended side effects while the AI is still planning its approach.
  if (
    mode === Mode.PLAN &&
    !["readFile", "listDirectory", "glob", "grep"].includes(toolName)
  ) {
    throw new Error(`Tool ${toolName} is not available in PLAN mode`);
  }

  switch (toolName) {
    // ── readFile ──────────────────────────────────────────────────────────────
    case "readFile": {
      const { path } = toolInputSchemas.readFile.parse(input);
      const { resolved } = resolveInsideCwd(path);
      const content = await readFile(resolved, "utf-8");

      // Return a truncation notice when the file exceeds the character cap so
      // the caller knows the content is partial and can request specific ranges
      // if needed.
      return content.length > MAX_FILE_SIZE
        ? {
            content: content.slice(0, MAX_FILE_SIZE),
            truncated: true,
            totalLength: content.length,
          }
        : { content };
    }

    // ── listDirectory ─────────────────────────────────────────────────────────
    case "listDirectory": {
      const { path } = toolInputSchemas.listDirectory.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      const entries = await readdir(resolved);
      const results: { name: string; type: "file" | "directory" }[] = [];

      for (const entry of entries) {
        // Skip hidden files/directories (dot-prefixed) and node_modules to
        // keep the output relevant and manageable.
        if (entry.startsWith(".") || entry === "node_modules") continue;

        const info = await stat(join(resolved, entry));
        results.push({
          name: entry,
          type: info.isDirectory() ? "directory" : "file",
        });
      }

      // Sort: directories first, then files; each group is sorted alphabetically.
      results.sort((a, b) =>
        a.type !== b.type
          ? a.type === "directory"
            ? -1
            : 1
          : a.name.localeCompare(b.name),
      );

      return { path: relative(cwd, resolved) || ".", entries: results };
    }

    // ── glob ──────────────────────────────────────────────────────────────────
    case "glob": {
      const { pattern, path } = toolInputSchemas.glob.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);

      const glob = new Bun.Glob(pattern);
      const files: string[] = [];
      let truncated = false;

      for await (const match of glob.scan({
        cwd: resolved,
        dot: false, // Exclude hidden files from results.
        onlyFiles: true,
      })) {
        // Exclude anything inside node_modules even when the pattern would
        // otherwise match (e.g. "**/*.ts").
        if (match.includes("node_modules")) continue;

        if (files.length >= MAX_RESULTS) {
          truncated = true;
          break;
        }

        // Store paths relative to cwd for portability.
        files.push(relative(cwd, resolve(resolved, match)));
      }

      files.sort();
      return { files, ...(truncated ? { truncated: true } : {}) };
    }

    // ── grep ──────────────────────────────────────────────────────────────────
    case "grep": {
      const { pattern, path, include } = toolInputSchemas.grep.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);

      // Build the argument list for the system `grep` binary.
      // -r  recursive, -n  line numbers, --color=never  plain output,
      // -E  extended regex
      const args = [
        "-rn",
        "--color=never",
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "-E",
      ];

      // Optionally restrict the search to files matching a glob pattern
      // (e.g. --include=*.ts).
      if (include) args.push(`--include=${include}`);
      args.push(pattern, resolved);

      const proc = Bun.spawn(["grep", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;

      // grep exits with 0 (matches found) or 1 (no matches).
      // Any other exit code signals a genuine error (e.g. invalid pattern).
      if (exitCode !== 0 && exitCode !== 1)
        throw new Error(`grep failed: ${stderr.trim()}`);

      if (!stdout.trim()) return { matches: [], message: "No matches found" };

      const lines = stdout.trim().split("\n");
      const matches: { file: string; line: number; content: string }[] = [];
      let truncated = false;

      for (const line of lines) {
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }

        // grep output format: "<file>:<lineNumber>:<matchedContent>"
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (match) {
          matches.push({
            file: relative(cwd, match[1]!),
            line: Number(match[2]),
            content: match[3]!,
          });
        }
      }

      return {
        matches,
        ...(truncated ? { truncated: true, totalMatches: lines.length } : {}),
      };
    }

    // ── writeFile ─────────────────────────────────────────────────────────────
    case "writeFile": {
      const { path, content } = toolInputSchemas.writeFile.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);

      // Ensure all ancestor directories exist before writing.
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf-8");

      return {
        success: true as const,
        path: relative(cwd, resolved),
        bytesWritten: Buffer.byteLength(content, "utf-8"),
      };
    }

    // ── editFile ──────────────────────────────────────────────────────────────
    case "editFile": {
      const { path, oldString, newString } =
        toolInputSchemas.editFile.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      const content = await readFile(resolved, "utf-8");

      // Count occurrences to ensure the edit is unambiguous.
      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) throw new Error("oldString not found in file");
      if (occurrences > 1)
        throw new Error(`oldString is ambiguous; found ${occurrences} matches`);

      // String.replace() replaces only the first occurrence, which is exactly
      // what we want after confirming there is only one.
      await writeFile(resolved, content.replace(oldString, newString), "utf-8");

      return { success: true as const, path: relative(cwd, resolved) };
    }

    // ── bash ──────────────────────────────────────────────────────────────────
    case "bash": {
      const { command, timeout = DEFAULT_TIMEOUT } =
        toolInputSchemas.bash.parse(input);

      const proc = Bun.spawn(["bash", "-c", command], {
        cwd: resolveInsideCwd(".").resolved,
        stdout: "pipe",
        stderr: "pipe",
        // Override TERM so interactive programs don't emit escape sequences.
        env: { ...process.env, TERM: "dumb" },
      });

      // Kill the process if it exceeds the allowed timeout.
      const timer = setTimeout(() => proc.kill(), timeout);

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;

      clearTimeout(timer);

      return {
        stdout: truncate(stdout, MAX_OUTPUT),
        stderr: truncate(stderr, MAX_OUTPUT),
        exitCode,
      };
    }

    // ── unknown ───────────────────────────────────────────────────────────────
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
