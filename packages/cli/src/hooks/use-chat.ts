import { useChat as useAiChat } from "@ai-sdk/react";
import {
  type ModeType,
  type SupportedChatModelId,
  type ToolContracts,
} from "@nightcode/shared";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  type InferUITools,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import { useMemo } from "react";
import { apiClient } from "../lib/api-client";
import { getAuth } from "../lib/auth";
import { executeLocalTool } from "../lib/local-tools";

/**
 * Metadata stored alongside each chat message.
 */
export type ChatMessageMetadata = {
  mode?: ModeType;
  model?: SupportedChatModelId | string;
  durationMs?: number;
  usage?: LanguageModelUsage;
};

/**
 * Tool shape inferred from shared tool contracts.
 */
type ChatTools = {
  [Name in keyof InferUITools<ToolContracts>]: {
    input: InferUITools<ToolContracts>[Name]["input"];
    output: unknown;
  };
};

/**
 * Strongly typed chat message used throughout the app.
 */
export type Message = UIMessage<ChatMessageMetadata, never, ChatTools>;

/**
 * Custom chat hook wrapping `@ai-sdk/react` with:
 * - Authenticated transport
 * - Session-aware message sending
 * - Local tool execution handling
 */
export function useChat(sessionId: string, initialMessages: Message[]) {
  /**
   * Transport responsible for sending messages to the backend API.
   * Memoized per session.
   */
  const transport = useMemo(() => {
    return new DefaultChatTransport<Message>({
      api: apiClient.chat.$url().toString(),

      // Attach auth token (if available) to every request
      headers() {
        const auth = getAuth();
        return auth ? { Authorization: `Bearer ${auth.token}` } : new Headers();
      },

      /**
       * Prepares the request payload before sending.
       * Sends only the latest message (and optionally the previous user message
       * when responding with an assistant message containing tool calls).
       */
      prepareSendMessagesRequest({ messages }) {
        const message = messages[messages.length - 1];
        if (!message) throw new Error("No message to send");

        // Use the most recent message that defined mode + model as fallback
        const metadata = messages.findLast(
          (m) => m.metadata?.mode && m.metadata?.model,
        )?.metadata;

        const previousMessage = messages[messages.length - 2];

        // If assistant just responded to a user, send them together
        const requestMessages =
          message.role === "assistant" && previousMessage?.role === "user"
            ? [previousMessage, message]
            : [message];

        return {
          body: {
            id: sessionId,
            messages: requestMessages,
            mode: message.metadata?.mode ?? metadata?.mode,
            model: message.metadata?.model ?? metadata?.model,
          },
        };
      },
    });
  }, [sessionId]);

  /**
   * AI chat state + lifecycle management.
   */
  const chat = useAiChat<Message>({
    id: sessionId,
    messages: initialMessages,
    transport,

    /**
     * Handles tool calls emitted by the assistant.
     * Executes the tool locally and sends the result back to the model.
     */
    onToolCall({ toolCall }) {
      const mode = chat.messages.at(-1)?.metadata?.mode ?? "BUILD";

      void executeLocalTool(toolCall.toolName, toolCall.input, mode)
        .then((output) =>
          chat.addToolOutput({
            tool: toolCall.toolName as keyof ChatTools,
            toolCallId: toolCall.toolCallId,
            output,
          }),
        )
        .catch((error) =>
          chat.addToolOutput({
            tool: toolCall.toolName as keyof ChatTools,
            toolCallId: toolCall.toolCallId,
            state: "output-error",
            errorText: error instanceof Error ? error.message : String(error),
          }),
        );
    },

    // Automatically send follow-up message once assistant finishes tool calls
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  /**
   * Public API exposed by this hook.
   */
  return {
    messages: chat.messages,
    status: chat.status,
    error: chat.error,

    /**
     * Sends a new user message with required mode + model metadata.
     */
    submit: (params: {
      userText: string;
      mode: ModeType;
      model: SupportedChatModelId;
    }) => {
      return chat.sendMessage({
        text: params.userText,
        metadata: {
          mode: params.mode,
          model: params.model,
        },
      });
    },

    /** Abort/stop the current generation. */
    abort: chat.stop,
    interrupt: chat.stop,
  };
}
