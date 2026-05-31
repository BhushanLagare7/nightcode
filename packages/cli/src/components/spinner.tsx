import "opentui-spinner/react";
import { useTheme } from "../providers/theme";

export function Spinner() {
  const { colors } = useTheme();

  return <spinner color={colors.primary} name="aesthetic" />;
}
