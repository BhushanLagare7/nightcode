import { useTerminalDimensions } from "@opentui/react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SplitBorderChars } from "../../components/border";
import { useTheme } from "../theme";
import {
  DEFAULT_DURATION,
  type ToastOptions,
  type ToastVariant,
} from "./types";

export type ToastContextValue = {
  show: (options: ToastOptions) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }

  return context;
}

type ToastProviderProps = {
  children: ReactNode;
};

export function ToastProvider({ children }: ToastProviderProps) {
  const [currentToast, setCurrentToast] = useState<ToastOptions | null>(null);
  const timeoutHandleRef = useRef<NodeJS.Timeout | null>(null);

  const clearCurrentTimeout = useCallback(() => {
    if (timeoutHandleRef.current) {
      clearTimeout(timeoutHandleRef.current);
      timeoutHandleRef.current = null;
    }
  }, []);

  const show = useCallback(
    (options: ToastOptions) => {
      const duration = options.duration ?? DEFAULT_DURATION;

      clearCurrentTimeout();

      setCurrentToast({
        variant: options.variant ?? "info",
        ...options,
        duration,
      });

      timeoutHandleRef.current = setTimeout(() => {
        setCurrentToast(null);
      }, duration).unref();
    },
    [clearCurrentTimeout],
  );

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toast currentToast={currentToast} />
    </ToastContext.Provider>
  );
}

type ToastProps = {
  currentToast: ToastOptions | null;
};

function Toast({ currentToast }: ToastProps) {
  if (!currentToast) return null;

  const { width } = useTerminalDimensions();
  const { colors } = useTheme();

  const variantColors: Record<ToastVariant, string> = {
    success: colors.success,
    error: colors.error,
    info: colors.info,
  };

  const borderColor = currentToast.variant
    ? variantColors[currentToast.variant]
    : variantColors.info;

  return (
    <box
      alignItems="flex-start"
      backgroundColor={colors.surface}
      border={["left", "right"]}
      borderColor={borderColor}
      customBorderChars={SplitBorderChars}
      justifyContent="center"
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      position="absolute"
      right={2}
      top={2}
      width={Math.max(1, Math.min(60, width - 6))}
    >
      <box flexDirection="column" gap={1} width="100%">
        <text fg="#E1E1E1" width="100%" wrapMode="word">
          {currentToast.message}
        </text>
      </box>
    </box>
  );
}
