import { Mode } from "@nightcode/database/enums";
import { useCallback } from "react";
import { useDialog } from "../../providers/dialog";
import { DialogSearchList } from "../dialog-search-list";

const AVAILABLE_MODES: Mode[] = [Mode.BUILD, Mode.PLAN];

type AgentsDialogContentProps = {
  currentMode: Mode;
  onSelectMode: (mode: Mode) => void;
};

function getModeLabel(mode: Mode) {
  return mode === Mode.PLAN ? "Plan" : "Build";
}

export const AgentsDialogContent = ({
  currentMode,
  onSelectMode,
}: AgentsDialogContentProps) => {
  const dialog = useDialog();

  const handleSelect = useCallback(
    (nextMode: Mode) => {
      onSelectMode(nextMode);
      dialog.close();
    },
    [onSelectMode, dialog],
  );

  return (
    <DialogSearchList
      emptyText="No matching agents"
      filterFn={(item, query) =>
        getModeLabel(item).toLowerCase().includes(query.toLowerCase())
      }
      getKey={(item) => item}
      items={AVAILABLE_MODES}
      placeholder="Search agents"
      renderItem={(item, isSelected) => (
        <text fg={isSelected ? "black" : "white"} selectable={false}>
          {item === currentMode ? " • " : "   "}
          {getModeLabel(item)}
        </text>
      )}
      onSelect={handleSelect}
    />
  );
};
