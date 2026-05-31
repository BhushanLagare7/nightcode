import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Header } from "./components/headers";
import { InputBar } from "./components/input-bar";
import { DialogProvider } from "./providers/dialog";
import { KeyboardLayerProvider } from "./providers/keyboard-layer";
import { ThemeProvider, useTheme } from "./providers/theme";
import { ToastProvider } from "./providers/toast";

function ThemedRoot() {
  const { colors } = useTheme();

  return (
    <box
      alignItems="center"
      backgroundColor={colors.background}
      gap={2}
      height="100%"
      justifyContent="center"
      width="100%"
    >
      <Header />
      <box maxWidth={78} paddingX={2} width="100%">
        <InputBar disabled={false} onSubmit={() => {}} />
      </box>
    </box>
  );
}

function App() {
  return (
    <ThemeProvider>
      <KeyboardLayerProvider>
        <DialogProvider>
          <ToastProvider>
            <ThemedRoot />
          </ToastProvider>
        </DialogProvider>
      </KeyboardLayerProvider>
    </ThemeProvider>
  );
}

const renderer = await createCliRenderer({
  targetFps: 60,
  exitOnCtrlC: false,
});
createRoot(renderer).render(<App />);
