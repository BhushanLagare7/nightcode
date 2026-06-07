import { MessageStatus } from "@nightcode/database/enums";
import {
  messagePartsSchema,
  type SupportedChatModelId,
} from "@nightcode/shared";
import { useKeyboard } from "@opentui/react";
import type { InferResponseType } from "hono/client";
import prettyMs from "pretty-ms";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { z } from "zod";
import { BotMessage, ErrorMessage, UserMessage } from "../components/messages";
import { SessionShell } from "../components/session-shell";
import {
  useChat,
  type ClientMessagePart,
  type Message,
} from "../hooks/use-chat";
import { apiClient } from "../lib/api-client";
import { getErrorMessage } from "../lib/http-errors";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { usePromptConfig } from "../providers/prompt-config";
import { useToast } from "../providers/toast";

type SessionData = InferResponseType<
  (typeof apiClient.sessions)[":id"]["$get"],
  200
>;

const sessionLocationSchema = z.object({
  session: z.custom<SessionData>(
    (val) => val !== null && typeof val === "object" && "id" in val,
  ),
});

function mapDbMessages(dbMessages: SessionData["messages"]): Message[] {
  return dbMessages.map((m): Message => {
    if (m.role === "ERROR") {
      return { id: m.id, role: "error", content: m.content };
    }

    if (m.role === "USER") {
      return {
        id: m.id,
        role: "user",
        content: m.content,
        mode: m.mode,
        model: m.model as SupportedChatModelId,
      };
    }

    const parsedParts =
      m.parts == null ? null : messagePartsSchema.safeParse(m.parts);
    const parts: ClientMessagePart[] = parsedParts?.success
      ? parsedParts.data.map((p) =>
          p.type === "tool-call" ? { ...p, status: "done" as const } : p,
        )
      : [];

    return {
      id: m.id,
      role: "assistant",
      content: m.content,
      model: m.model as SupportedChatModelId,
      mode: m.mode,
      parts,
      ...(m.duration != null ? { duration: prettyMs(m.duration * 1000) } : {}),
      interrupted: m.status === MessageStatus.INTERRUPTED,
    };
  });
}

function ChatMessage({ msg }: { msg: Message }) {
  if (msg.role === "user") {
    return <UserMessage message={msg.content} mode={msg.mode} />;
  }

  if (msg.role === "error") {
    return <ErrorMessage message={msg.content} />;
  }

  return (
    <BotMessage
      duration={msg.duration}
      interrupted={msg.interrupted}
      mode={msg.mode}
      model={msg.model}
      parts={msg.parts}
      streaming={false}
    />
  );
}

function SessionChat({ session }: { session: SessionData }) {
  const [initialMessages] = useState(() => mapDbMessages(session.messages));
  const { isTopLayer } = useKeyboardLayer();
  const { mode, model } = usePromptConfig();
  const { messages, streaming, submit, abort, interrupt } = useChat(
    session.id,
    initialMessages,
  );

  // Stop the pending reply when the user leaves this session.
  useEffect(() => {
    return () => abort();
  }, [abort]);

  // Let the user cancel a reply even before the first streamed chunk arrives.
  useKeyboard((key) => {
    if (
      key.name === "escape" &&
      isTopLayer("base") &&
      streaming.status === "streaming"
    ) {
      key.preventDefault();
      interrupt();
    }
  });

  return (
    <SessionShell
      interruptible={streaming.status === "streaming"}
      loading={streaming.status === "streaming"}
      onSubmit={(text) => submit({ userText: text, mode, model })}
    >
      {messages.map((msg) => (
        <ChatMessage key={msg.id} msg={msg} />
      ))}
      {streaming.status === "streaming" && streaming.parts.length > 0 && (
        <BotMessage
          mode={streaming.mode}
          model={streaming.model}
          parts={streaming.parts}
          streaming
        />
      )}
    </SessionShell>
  );
}

export function Session() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  const prefetched = useMemo(() => {
    const parsed = sessionLocationSchema.safeParse(location.state);
    return parsed.success ? parsed.data.session : null;
  }, [location.state]);

  const [session, setSession] = useState<SessionData | null>(prefetched);

  useEffect(() => {
    // Skip fetch is session was passed via location state
    if (prefetched) return;

    setSession(null);

    if (!id) return;

    let ignore = false;
    const fetchSession = async () => {
      try {
        const response = await apiClient.sessions[":id"].$get({
          param: { id },
        });
        if (ignore) return;
        if (!response.ok) throw new Error(await getErrorMessage(response));

        const resolved = await response.json();
        setSession(resolved);
      } catch (error) {
        if (ignore) return;

        toast.show({
          variant: "error",
          message:
            error instanceof Error ? error.message : "Failed to fetch session",
        });
        navigate("/", { replace: true });
      }
    };

    fetchSession();

    return () => {
      ignore = true;
    };
  }, [id, prefetched, toast, navigate]);

  if (!session) {
    return <SessionShell inputDisabled loading onSubmit={() => {}} />;
  }

  return <SessionChat key={session.id} session={session} />;
}
