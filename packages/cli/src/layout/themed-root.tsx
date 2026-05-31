import type { ReactNode } from "react";
import { useTheme } from "../providers/theme";

type ThemedRootProps = {
  children: ReactNode;
};

export function ThemedRoot({ children }: ThemedRootProps) {
  const { colors } = useTheme();

  return (
    <box
      backgroundColor={colors.background}
      flexGrow={1}
      height="100%"
      width="100%"
    >
      {children}
    </box>
  );
}
