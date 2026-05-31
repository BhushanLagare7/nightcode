import { useTheme } from "../../providers/theme";

type BotMessageProps = {
  content: string;
  model: string;
};

export function BotMessage({ content, model }: BotMessageProps) {
  const { colors } = useTheme();

  return (
    <box alignItems="center" width="100%">
      <box paddingY={1} width="100%">
        <box paddingX={3} width="100%">
          <text>{content}</text>
        </box>
      </box>
      <box gap={1} paddingBottom={1} paddingX={3} width="100%">
        <box flexDirection="row" gap={2}>
          <text fg={colors.primary}>◉</text>
          <text>{model}</text>
        </box>
      </box>
    </box>
  );
}
