import { useCallback } from "react";
import { useNavigate } from "react-router";
import { Header } from "../components/headers";
import { InputBar } from "../components/input-bar";

export function Home() {
  const navigate = useNavigate();

  const handleSubmit = useCallback(
    (text: string) => {
      navigate("/sessions/new", { state: { message: text } });
    },
    [navigate],
  );

  return (
    <box
      alignItems="center"
      flexGrow={1}
      gap={2}
      height="100%"
      justifyContent="center"
      position="relative"
      width="100%"
    >
      <Header />
      <box maxWidth={78} paddingX={2} width="100%">
        <InputBar onSubmit={handleSubmit} />
      </box>
    </box>
  );
}
