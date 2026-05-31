import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import { InputBar } from "./input-bar";
import { Spinner } from "./spinner";

type SessionShellProps = {
  children?: ReactNode;
  onSubmit: (text: string) => void;
  inputDisabled?: boolean;
  loading?: boolean;
};

export function SessionShell({
  children,
  onSubmit,
  inputDisabled = false,
  loading = false,
}: SessionShellProps) {
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      gap={1}
      height="100%"
      paddingX={2}
      paddingY={1}
      width="100%"
    >
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" width="100%">
        <box gap={1}>{children}</box>
      </scrollbox>
      <box flexShrink={0}>
        <InputBar disabled={inputDisabled} onSubmit={onSubmit} />
      </box>
      <box
        flexDirection="row"
        flexShrink={0}
        gap={2}
        height={1}
        justifyContent="space-between"
        paddingLeft={1}
        width="100%"
      >
        <box alignItems="center" flexDirection="row" gap={2}>
          {loading ? <Spinner /> : null}
        </box>
        <box flexDirection="row" flexShrink={0} gap={1} marginLeft="auto">
          <text>tab</text>
          <text attributes={TextAttributes.DIM}>agents</text>
        </box>
      </box>
    </box>
  );
}
