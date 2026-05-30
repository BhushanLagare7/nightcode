import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { useKeyboardLayer } from "../keyboard-layer";
import { useTheme } from "../theme";
import type { DialogConfig } from "./types";

export type DialogContextValue = {
  open: (config: DialogConfig) => void;
  close: () => void;
};

const DialogContext = createContext<DialogContextValue | null>(null);

export function useDialog(): DialogContextValue {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error("useDialog must be used within a DialogProvider");
  }

  return context;
}

type DialogProviderProps = {
  children: ReactNode;
};

export function DialogProvider({ children }: DialogProviderProps) {
  const [currentDialog, setCurrentDialog] = useState<DialogConfig | null>(null);
  const { push, pop } = useKeyboardLayer();

  const close = useCallback(() => {
    setCurrentDialog(null);
    pop("dialog");
  }, [pop]);

  const open = useCallback(
    (config: DialogConfig) => {
      setCurrentDialog(config);
      push("dialog", () => {
        close();
        return true;
      });
    },
    [push, close],
  );

  const value: DialogContextValue = { open, close };

  return (
    <DialogContext.Provider value={value}>
      {children}
      <Dialog close={close} currentDialog={currentDialog} />
    </DialogContext.Provider>
  );
}

type DialogProps = {
  currentDialog: DialogConfig | null;
  close: () => void;
};

function Dialog({ currentDialog, close }: DialogProps) {
  const dimensions = useTerminalDimensions();
  const { isTopLayer } = useKeyboardLayer();
  const { colors } = useTheme();

  useKeyboard((key) => {
    if (!currentDialog || !isTopLayer("dialog")) return;

    if (key.name === "escape") {
      close();
    }
  });

  if (!currentDialog) return null;

  const { title, children } = currentDialog;

  return (
    <box
      alignItems="center"
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
      height={dimensions.height}
      justifyContent="center"
      left={0}
      position="absolute"
      top={0}
      width={dimensions.width}
      zIndex={100}
      onMouseDown={() => close()}
    >
      <box
        backgroundColor={colors.surface}
        flexDirection="column"
        gap={1}
        height="auto"
        paddingX={4}
        paddingY={1}
        width={Math.min(60, dimensions.width - 4)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <box
          alignItems="center"
          flexDirection="row"
          justifyContent="space-between"
          paddingBottom={1}
        >
          <text attributes={TextAttributes.BOLD}>{title}</text>
          <text attributes={TextAttributes.DIM} onMouseDown={() => close()}>
            esc
          </text>
        </box>
        <box flexGrow={1}>{children}</box>
      </box>
    </box>
  );
}
