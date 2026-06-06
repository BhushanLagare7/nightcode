import type { Mode } from "@nightcode/database/enums";
import {
  chatStreamEventSchema,
  type SupportedChatModelId,
} from "@nightcode/shared";
import { EventSourceParserStream } from "eventsource-parser/stream";
import type { ClientResponse } from "hono/client";
import prettyMs from "pretty-ms";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../lib/api-client";
import { getErrorMessage } from "../lib/http-errors";

export type ClientMessagePart = { type: "text"; text: string };

/**
 * Represents a single message in the chat conversation.
 * Can be a user message, assistant response, or an error.
 */
export type Message =
  | {
      id: string;
      role: "user";
      content: string;
      mode: Mode;
      model: SupportedChatModelId;
    }
  | {
      id: string;
      role: "assistant";
      content: string;
      mode: Mode;
      model: SupportedChatModelId;
      parts: ClientMessagePart[];
      /** Human-readable generation time, e.g. "1.2s" */
      duration?: string;
      /** True when the stream was stopped before completion */
      interrupted?: boolean;
    }
  | { id: string; role: "error"; content: string };

/** Tracks whether a stream is active and its current content. */
type StreamingState =
  | { status: "idle" }
  | {
      status: "streaming";
      parts: ClientMessagePart[];
      mode: Mode;
      model: SupportedChatModelId;
    };

/** Internal state for a stream that is currently in-flight. */
type ActiveStream = {
  requestId: string;
  controller: AbortController;
  mode: Mode;
  model: SupportedChatModelId;
  /** Accumulated message parts received so far. */
  parts: ClientMessagePart[];
  /** Prevents a partial message from being captured more than once on interrupt. */
  interruptedCaptured: boolean;
};

type SubmitParams = {
  userText: string;
  mode: Mode;
  model: SupportedChatModelId;
};

type RunStreamParams = {
  mode: Mode;
  model: SupportedChatModelId;
  /** Returns the streaming HTTP response for the given abort controller. */
  request: (controller: AbortController) => Promise<ClientResponse<unknown>>;
};

/**
 * Manages chat messages and streaming assistant responses for a session.
 *
 * @param sessionId - The active chat session identifier.
 * @param initialMessages - Messages to pre-populate the conversation with.
 * @returns Messages, streaming state, and controls for the conversation.
 */
export function useChat(sessionId: string, initialMessages: Message[]) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [streaming, setStreaming] = useState<StreamingState>({
    status: "idle",
  });

  // Holds the currently active stream so callbacks can reference it without
  // capturing a stale closure.
  const activeStreamRef = useRef<ActiveStream | null>(null);

  const updateMessages = useCallback(
    (updater: (prev: Message[]) => Message[]) => {
      setMessages((prev) => updater(prev));
    },
    [],
  );

  /** Returns true only if the given request is still the active stream. */
  const isActiveRequest = useCallback((requestId: string) => {
    return activeStreamRef.current?.requestId === requestId;
  }, []);

  /** Publishes the latest accumulated parts to React state. */
  const emitParts = useCallback(
    (requestId: string, parts: ClientMessagePart[]) => {
      if (!isActiveRequest(requestId)) return;

      const snapshot = [...parts];
      const activeStream = activeStreamRef.current;
      if (!activeStream) return;

      activeStream.parts = snapshot;
      setStreaming({
        status: "streaming",
        parts: snapshot,
        mode: activeStream.mode,
        model: activeStream.model,
      });
    },
    [isActiveRequest],
  );

  /**
   * Saves whatever the assistant has streamed so far as an interrupted message.
   * No-ops if already captured or if there are no parts to save.
   */
  const captureInterruptedMessage = useCallback(
    (activeStream: ActiveStream) => {
      if (activeStream.interruptedCaptured || activeStream.parts.length === 0) {
        return;
      }

      activeStream.interruptedCaptured = true;
      const parts = [...activeStream.parts];
      const fullText = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");

      updateMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: fullText,
          mode: activeStream.mode,
          model: activeStream.model,
          parts,
          interrupted: true,
        },
      ]);
    },
    [updateMessages],
  );

  /** Clears the active stream reference and resets streaming state to idle. */
  const clearStream = useCallback(
    (requestId: string) => {
      if (!isActiveRequest(requestId)) return;

      activeStreamRef.current = null;
      setStreaming({ status: "idle" });
    },
    [isActiveRequest],
  );

  /**
   * Consumes a streaming HTTP response and progressively updates messages.
   * Handles text-delta, done, and error stream events.
   */
  const handleStream = useCallback(
    async (response: ClientResponse<unknown>, activeStream: ActiveStream) => {
      if (!isActiveRequest(activeStream.requestId)) return;

      if (!response.ok) {
        const message = await getErrorMessage(response);
        updateMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "error", content: message },
        ]);
        return;
      }

      const parts: ClientMessagePart[] = [];

      const stream = response
        .body!.pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream());

      for await (const { data } of stream) {
        if (!isActiveRequest(activeStream.requestId)) return;

        let event;

        try {
          event = chatStreamEventSchema.parse(JSON.parse(data));
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Invalid stream event";
          updateMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "error", content: message },
          ]);
          break;
        }

        switch (event.type) {
          case "text-delta": {
            // Append to the last text part when possible to avoid extra allocations.
            const last = parts[parts.length - 1];
            if (last && last.type === "text") {
              last.text += event.text;
            } else {
              parts.push({ type: "text", text: event.text });
            }
            emitParts(activeStream.requestId, parts);
            break;
          }
          case "done": {
            if (!isActiveRequest(activeStream.requestId)) return;

            const fullText = parts
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("");

            updateMessages((prev) => [
              ...prev,
              {
                id: activeStream.requestId,
                role: "assistant",
                content: fullText,
                mode: activeStream.mode,
                model: activeStream.model,
                duration: prettyMs(event.durationMs),
                parts: [...parts],
              },
            ]);
            break;
          }
          case "error": {
            updateMessages((prev) => [
              ...prev,
              {
                id: activeStream.requestId,
                role: "error",
                content: event.message,
              },
            ]);
            break;
          }
        }
      }
    },
    [isActiveRequest, emitParts, updateMessages],
  );

  /**
   * Starts a new streaming request. Registers it as the active stream and
   * tears it down when the request settles or is aborted.
   */
  const runStream = useCallback(
    async ({ mode, model, request }: RunStreamParams) => {
      const controller = new AbortController();
      const activeStream: ActiveStream = {
        requestId: crypto.randomUUID(),
        controller,
        mode,
        model,
        parts: [],
        interruptedCaptured: false,
      };

      activeStreamRef.current = activeStream;
      setStreaming({ status: "streaming", parts: [], mode, model });

      try {
        const response = await request(controller);
        await handleStream(response, activeStream);
      } catch (err) {
        // AbortError is expected when the user stops the stream — not an error.
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }

        if (!isActiveRequest(activeStream.requestId)) return;

        const msg = err instanceof Error ? err.message : String(err);
        updateMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "error",
            content: msg,
          },
        ]);
      } finally {
        clearStream(activeStream.requestId);
      }
    },
    [clearStream, handleStream, isActiveRequest, updateMessages],
  );

  /**
   * Stops the active stream.
   * @param capturePartial - When true, saves any partial response as an interrupted message.
   */
  const stopActiveStream = useCallback(
    (capturePartial: boolean) => {
      const activeStream = activeStreamRef.current;
      if (!activeStream) return;

      if (capturePartial) {
        captureInterruptedMessage(activeStream);
      }

      activeStreamRef.current = null;
      setStreaming({ status: "idle" });
      activeStream.controller.abort();
    },
    [captureInterruptedMessage],
  );

  /** Resumes generation for the current session without sending a new user message. */
  const resume = useCallback(
    async ({ mode, model }: Omit<SubmitParams, "userText">) => {
      await runStream({
        mode,
        model,
        request: async (controller) => {
          return apiClient.chat[":sessionId"].resume.$post(
            { param: { sessionId } },
            { init: { signal: controller.signal } },
          );
        },
      });
    },
    [runStream, sessionId],
  );

  // Auto-resume when the conversation ends with a user message that has no reply.
  // Runs once on mount; the ref prevents re-triggering if `resume` identity changes.
  const hasAutoResumedRef = useRef(false);
  useEffect(() => {
    if (hasAutoResumedRef.current) return;
    const last = initialMessages[initialMessages.length - 1];
    if (!last || last.role !== "user") return;

    hasAutoResumedRef.current = true;
    void resume({ mode: last.mode, model: last.model });
  }, [initialMessages, resume]);

  /**
   * Sends a user message and starts streaming the assistant response.
   * If a stream is already active, it is interrupted and its partial
   * response is captured before the new message is sent.
   */
  const submit = useCallback(
    async ({ userText, mode, model }: SubmitParams) => {
      // Capture any in-progress answer so it isn't lost when the new message arrives.
      stopActiveStream(true);

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: userText,
        mode,
        model,
      };
      updateMessages((prev) => [...prev, userMessage]);

      await runStream({
        mode,
        model,
        request: async (controller) => {
          return apiClient.chat[":sessionId"].$post(
            {
              param: { sessionId },
              json: { content: userText, mode, model },
            },
            { init: { signal: controller.signal } },
          );
        },
      });
    },
    [runStream, sessionId, updateMessages, stopActiveStream],
  );

  /** Stops the active stream and discards any partial response. */
  const abort = useCallback(() => {
    stopActiveStream(false);
  }, [stopActiveStream]);

  /** Stops the active stream and saves the partial response as an interrupted message. */
  const interrupt = useCallback(() => {
    stopActiveStream(true);
  }, [stopActiveStream]);

  return { messages, streaming, submit, abort, interrupt };
}
