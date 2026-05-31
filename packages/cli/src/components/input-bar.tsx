import type { KeyBinding, TextareaRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useCallback, useEffect, useRef } from "react";
import { useDialog } from "../providers/dialog";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useTheme } from "../providers/theme";
import { useToast } from "../providers/toast";
import { EmptyBorder } from "./border";
import { CommandMenu } from "./command-menu";
import type { Command } from "./command-menu/types";
import { useCommandMenu } from "./command-menu/use-command-menu";
import { StatusBar } from "./status-bar";

type InputBarProps = {
  onSubmit: (text: string) => void;
  disabled?: boolean;
};

export const TEXTAREA_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "enter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "enter", shift: true, action: "newline" },
];

export function InputBar({ onSubmit, disabled = false }: InputBarProps) {
  const textareaRef = useRef<TextareaRenderable>(null);
  const onSubmitRef = useRef<() => void>(() => {});
  const renderer = useRenderer();
  const toast = useToast();
  const dialog = useDialog();
  const { isTopLayer, setResponder } = useKeyboardLayer();
  const { colors } = useTheme();

  const {
    commandQuery,
    handleContentChange,
    resolveCommand,
    setSelectedIndex,
    selectedIndex,
    showCommandMenu,
    scrollRef,
  } = useCommandMenu();

  const handleTextareaContentChange = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    handleContentChange(textarea.plainText);
  }, [handleContentChange]);

  const handleSubmit = useCallback(() => {
    if (disabled) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const text = textarea.plainText.trim();
    if (text.length === 0) return;

    onSubmit(text);
    textarea.setText("");
  }, [disabled, onSubmit]);

  const handleCommand = useCallback(
    (command: Command | undefined) => {
      const textarea = textareaRef.current;
      if (!textarea || !command) return;

      textarea.setText("");

      if (command.action) {
        command.action({
          exit: () => renderer.destroy(),
          toast,
          dialog,
        });
      } else {
        textarea.insertText(command.value + " ");
      }
    },
    [renderer, toast, dialog],
  );

  const handleCommandExecute = useCallback(
    (index: number) => {
      const command = resolveCommand(index);
      if (command) {
        handleCommand(command);
      }
    },
    [resolveCommand, handleCommand],
  );

  // Wire up textarea submit handler once so it always reads the latest state.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.onSubmit = () => {
      onSubmitRef.current();
    };
  }, []);

  onSubmitRef.current = () => {
    if (disabled) return;

    if (showCommandMenu) {
      const command = resolveCommand(selectedIndex);
      handleCommand(command);
      return;
    }

    handleSubmit();
  };

  // Register the base layer responder for ctrl+C dismissal.
  useEffect(() => {
    setResponder("base", () => {
      if (disabled) return false;

      const textarea = textareaRef.current;
      if (textarea && textarea.plainText.length > 0) {
        textarea.setText("");
        return true;
      }

      return false;
    });

    return () => setResponder("base", null);
  }, [disabled, setResponder]);

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
          gap={1}
          justifyContent="center"
          paddingX={2}
          paddingY={1}
          position="relative"
          width="100%"
        >
          {showCommandMenu && (
            <box
              backgroundColor={colors.surface}
              bottom="100%"
              left={0}
              position="absolute"
              width="100%"
              zIndex={10}
            >
              <CommandMenu
                query={commandQuery}
                scrollRef={scrollRef}
                selectedIndex={selectedIndex}
                onExecute={handleCommandExecute}
                onSelect={setSelectedIndex}
              />
            </box>
          )}
          <textarea
            ref={textareaRef}
            focused={!disabled && (isTopLayer("base") || isTopLayer("command"))}
            keyBindings={TEXTAREA_KEY_BINDINGS}
            placeholder={`Ask anything..."Fix a bug in the database"`}
            onContentChange={handleTextareaContentChange}
          />
          <StatusBar />
        </box>
      </box>
    </box>
  );
}
