import { useKeyboard, useRenderer } from "@opentui/react";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

type Responder = () => boolean;

type KeyboardLayerContextValue = {
  push: (id: string, responder?: Responder) => void;
  pop: (id: string) => void;
  isTopLayer: (id: string) => boolean;
  setResponder: (id: string, responder: Responder | null) => void;
};

const KeyboardLayerContext = createContext<KeyboardLayerContextValue | null>(
  null,
);

type KeyboardLayerProviderProps = {
  children: ReactNode;
};

export function KeyboardLayerProvider({
  children,
}: KeyboardLayerProviderProps) {
  const [stack, setStack] = useState<string[]>(["base"]);
  const stackRef = useRef(stack);
  stackRef.current = stack;

  const responders = useRef<Map<string, Responder>>(new Map());
  const renderer = useRenderer();

  const push = useCallback((id: string, responder?: Responder) => {
    if (responder) responders.current.set(id, responder);

    setStack((prev) => {
      if (prev.includes(id)) return prev;

      return [...prev, id];
    });
  }, []);

  const pop = useCallback((id: string) => {
    responders.current.delete(id);
    setStack((prev) => prev.filter((layer) => layer !== id));
  }, []);

  const isTopLayer = useCallback(
    (id: string) => {
      return stack.length === 0 || stack[stack.length - 1] === id;
    },
    [stack],
  );

  const setResponder = useCallback(
    (id: string, responder: Responder | null) => {
      if (responder) {
        responders.current.set(id, responder);
      } else {
        responders.current.delete(id);
      }
    },
    [],
  );

  // Single ctrl+C handler that walks the responder chain
  useKeyboard((key) => {
    if (!key.ctrl || key.name !== "c") return;

    const currentStack = stackRef.current;
    for (let i = currentStack.length - 1; i >= 0; i--) {
      const layerId = currentStack[i]!;
      const responder = responders.current.get(layerId);
      if (responder?.()) {
        return;
      }
    }

    // No responder handled it - exit
    renderer.destroy();
  });

  const value: KeyboardLayerContextValue = {
    push,
    pop,
    isTopLayer,
    setResponder,
  };

  return (
    <KeyboardLayerContext.Provider value={value}>
      {children}
    </KeyboardLayerContext.Provider>
  );
}

export function useKeyboardLayer() {
  const context = useContext(KeyboardLayerContext);
  if (!context) {
    throw new Error(
      "useKeyboardLayer must be used within KeyboardLayerProvider",
    );
  }

  return context;
}
