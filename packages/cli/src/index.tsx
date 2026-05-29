import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Header } from "./components/headers";
import { InputBar } from "./components/input-bar";

function App() {
  return (
    <box
      alignItems="center"
      backgroundColor="#0D0D12"
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

const renderer = await createCliRenderer({
  targetFps: 60,
  exitOnCtrlC: false,
});
createRoot(renderer).render(<App />);
