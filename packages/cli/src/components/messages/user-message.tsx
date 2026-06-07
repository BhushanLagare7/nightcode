import { Mode } from "@nightcode/database/enums";
import { useTheme } from "../../providers/theme";
import { EmptyBorder } from "../border";

type UserMessageProps = {
  message: string;
  mode: Mode;
};

export function UserMessage({ message, mode }: UserMessageProps) {
  const { colors } = useTheme();

  return (
    <box alignItems="center" width="100%">
      <box
        border={["left"]}
        borderColor={mode === Mode.PLAN ? colors.planMode : colors.primary}
        customBorderChars={{
          ...EmptyBorder,
          vertical: "┃",
          bottomLeft: "╹",
        }}
        width="100%"
      >
        <box
          backgroundColor={colors.surface}
          justifyContent="center"
          paddingX={2}
          paddingY={1}
          width="100%"
        >
          <text>{message}</text>
        </box>
      </box>
    </box>
  );
}
