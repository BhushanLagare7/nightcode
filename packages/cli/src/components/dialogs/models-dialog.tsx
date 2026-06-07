import type { SupportedChatModelId } from "@nightcode/shared";
import { useCallback } from "react";
import { useDialog } from "../../providers/dialog";
import { DialogSearchList } from "../dialog-search-list";

type ModelsDialogContentProps = {
  models: SupportedChatModelId[];
  onSelectModel: (modelId: SupportedChatModelId) => void;
};

export const ModelsDialogContent = ({
  models,
  onSelectModel,
}: ModelsDialogContentProps) => {
  const dialog = useDialog();

  const handleSelect = useCallback(
    (modelId: SupportedChatModelId) => {
      onSelectModel(modelId);
      dialog.close();
    },
    [dialog, onSelectModel],
  );

  return (
    <DialogSearchList
      emptyText="No matching models"
      filterFn={(modelId, query) =>
        modelId.toLowerCase().includes(query.toLowerCase())
      }
      getKey={(modelId) => modelId}
      items={models}
      placeholder="Search models"
      renderItem={(modelId, isSelected) => (
        <text fg={isSelected ? "black" : "white"} selectable={false}>
          {modelId}
        </text>
      )}
      onSelect={handleSelect}
    />
  );
};
