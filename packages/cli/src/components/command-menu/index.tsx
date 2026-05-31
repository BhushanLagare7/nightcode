import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import type { RefObject } from "react";
import { useTheme } from "../../providers/theme";
import { COMMANDS } from "./commands";
import { getFilteredCommands } from "./filter-commands";

const MAX_VISIBLE_ITEMS = 8;

// Align all command names in a fixed-width column so their descriptions
// start at the same horizontal position for a clean tabular look.
// The width adjusts to accommodate the longest command name.
const COMMAND_COL_WIDTH =
  Math.max(...COMMANDS.map((command) => command.name.length)) + 4;

type CommandMenuProps = {
  query: string;
  selectedIndex: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  onSelect: (index: number) => void;
  onExecute: (index: number) => void;
};

export function CommandMenu({
  query,
  selectedIndex,
  scrollRef,
  onSelect,
  onExecute,
}: CommandMenuProps) {
  const { colors } = useTheme();
  const filtered = getFilteredCommands(query);
  const visibleHeight = Math.min(filtered.length, MAX_VISIBLE_ITEMS);

  if (filtered.length === 0) {
    return (
      <box paddingX={1}>
        <text attributes={TextAttributes.DIM}>No matching commands</text>
      </box>
    );
  }

  return (
    <scrollbox ref={scrollRef} height={visibleHeight}>
      {filtered.map((command, index) => {
        const isSelected = index === selectedIndex;

        return (
          <box
            key={command.value}
            backgroundColor={isSelected ? colors.selection : undefined}
            flexDirection="row"
            height={1}
            overflow="hidden"
            paddingX={1}
            onMouseDown={() => onExecute(index)}
            onMouseMove={() => onSelect(index)}
          >
            <box flexShrink={0} width={COMMAND_COL_WIDTH}>
              <text fg={isSelected ? "black" : "white"} selectable={false}>
                /{command.name}
              </text>
            </box>
            <box flexGrow={1} flexShrink={1} overflow="hidden">
              <text fg={isSelected ? "black" : "gray"} selectable={false}>
                {command.description}
              </text>
            </box>
          </box>
        );
      })}
    </scrollbox>
  );
}
