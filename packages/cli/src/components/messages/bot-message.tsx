import { Mode } from "@nightcode/database/enums";
import { TextAttributes } from "@opentui/core";
import type {
  ClientMessagePart,
  ClientToolCallPart,
} from "../../hooks/use-chat";
import { useTheme } from "../../providers/theme";
import { EmptyBorder } from "../border";

type BotMessageProps = {
  /** The current interaction mode (e.g. Plan or Build). */
  mode: Mode;
  /** The name/identifier of the AI model used. */
  model: string;
  /** The list of message parts that make up the bot's response. */
  parts: ClientMessagePart[];
  /** Optional human-readable duration of the response generation. */
  duration?: string;
  /** Whether the response was interrupted before completion. */
  interrupted?: boolean;
  /** Whether the response is currently being streamed. */
  streaming?: boolean;
};

/**
 * Converts a camelCase tool name into a human-readable title-cased string.
 * @example "myToolName" → "My Tool Name"
 */
function formatToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Extracts and joins all argument values from a tool call part into a single string.
 */
function formatToolArgs(tc: ClientToolCallPart): string {
  return Object.values(tc.args).map(String).join(" ");
}

/** A group of consecutive message parts sharing the same type. */
type PartGroup = {
  type: ClientMessagePart["type"];
  parts: ClientMessagePart[];
  /** Unique key used for React reconciliation. */
  key: string;
};

/**
 * Groups consecutive message parts of the same type together.
 * This avoids unnecessary visual separation between adjacent parts of the same kind.
 */
function groupConsecutiveParts(parts: ClientMessagePart[]): PartGroup[] {
  const groups: PartGroup[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const lastGroup = groups[groups.length - 1];

    if (lastGroup && lastGroup.type === part.type) {
      // Append to the existing group if the type matches
      lastGroup.parts.push(part);
    } else {
      // Start a new group with a stable key
      const key =
        part.type === "tool-call"
          ? `group-tc-${part.id}`
          : `group-${part.type}-${i}`;
      groups.push({ type: part.type, parts: [part], key });
    }
  }

  return groups;
}

/**
 * Renders a bot message, including reasoning blocks, tool calls, and text parts,
 * followed by a status footer showing the mode, model, and optional duration.
 */
export function BotMessage({
  mode,
  model,
  parts,
  duration,
  interrupted = false,
  streaming = false,
}: BotMessageProps) {
  const { colors } = useTheme();

  // Concatenate all text parts for potential downstream use
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");

  return (
    <box alignItems="center" width="100%">
      {groupConsecutiveParts(parts).map((group) => (
        <box key={group.key} paddingY={1} width="100%">
          {group.parts.map((part, j) => {
            // Render reasoning blocks with a dimmed left-border style
            if (part.type === "reasoning") {
              return (
                <box
                  key={`reasoning-${j}`}
                  border={["left"]}
                  borderColor={colors.thinkingBorder}
                  customBorderChars={{
                    ...EmptyBorder,
                    vertical: "│",
                  }}
                  paddingX={2}
                  width="100%"
                >
                  <text attributes={TextAttributes.DIM}>
                    <em fg={colors.thinking}>Thinking:</em> {part.text}
                  </text>
                </box>
              );
            }

            // Render tool calls with their formatted name, args, and a "calling" indicator
            if (part.type === "tool-call") {
              return (
                <box
                  key={part.id}
                  border={["left"]}
                  borderColor={colors.thinkingBorder}
                  customBorderChars={{
                    ...EmptyBorder,
                    vertical: "│",
                  }}
                  paddingX={2}
                  width="100%"
                >
                  <text attributes={TextAttributes.DIM}>
                    <em fg={colors.info}>{formatToolName(part.name)}:</em>{" "}
                    {formatToolArgs(part)}
                    {part.status === "calling" ? " …" : ""}
                  </text>
                </box>
              );
            }

            // Render plain text parts
            if (part.type === "text") {
              return (
                <box key={`text-${j}`} paddingX={3} width="100%">
                  <text>{part.text}</text>
                </box>
              );
            }

            return null;
          })}
        </box>
      ))}

      {/* Footer: displays mode indicator, model name, and duration or interrupted state */}
      <box gap={1} paddingBottom={1} paddingX={3} width="100%">
        <box flexDirection="row" gap={2}>
          <text
            attributes={interrupted ? TextAttributes.DIM : 0}
            fg={
              interrupted
                ? undefined
                : mode === Mode.PLAN
                  ? colors.planMode
                  : colors.primary
            }
          >
            ◉
          </text>
          <box flexDirection="row" gap={1}>
            <text attributes={interrupted ? TextAttributes.DIM : 0}>
              {mode === Mode.PLAN ? "Plan" : "Build"}
            </text>

            <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
              ›
            </text>
            <text attributes={TextAttributes.DIM}>{model}</text>

            {/* Show duration or interrupted label when applicable */}
            {(duration || interrupted) && (
              <>
                <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
                  ›
                </text>
                <text attributes={TextAttributes.DIM}>
                  {interrupted ? "interrupted" : duration}
                </text>
              </>
            )}
          </box>
        </box>
      </box>
    </box>
  );
}
