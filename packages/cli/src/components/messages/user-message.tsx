import { useTheme } from "../../providers/theme";
import { EmptyBorder } from "../border";

type UserMessageProps = {
  message: string;
};

export function UserMessage({ message }: UserMessageProps) {
  const { colors } = useTheme();

  return (
    <box alignItems="center" width="100%">
      <box
        border={["left"]}
        borderColor={colors.primary}
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
