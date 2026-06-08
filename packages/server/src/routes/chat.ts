import { zValidator } from "@hono/zod-validator";
import type { Prisma } from "@nightcode/database";
import { db } from "@nightcode/database/client";
import { MessageStatus, Mode } from "@nightcode/database/enums";
import {
  messagePartsSchema,
  toolCallArgsSchema,
  type ChatStreamEvent,
  type MessagePart,
} from "@nightcode/shared";
import * as Sentry from "@sentry/hono/bun";
import { streamText as aiStreamText, stepCountIs } from "ai";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { isSupportedChatModel, resolveChatModel } from "../lib/models";
import type { AuthenticatedEnv } from "../middleware/require-auth";
import { buildSystemPrompt } from "../system-prompt";
import { createTools } from "../tools";

/** Validates the shape of a new chat submission request body. */
const submitSchema = z.object({
  content: z.string(),
  mode: z.enum(Mode),
  model: z.string().refine(isSupportedChatModel, "Unsupported model"),
});

/**
 * Zod validator middleware for chat submission.
 * Logs a warning and returns 400 when validation fails.
 */
const submitValidator = zValidator("json", submitSchema, (result, c) => {
  if (!result.success) {
    Sentry.logger.warn("Chat submission validation failed", {
      path: c.req.path,
      issues: result.error.issues.length,
    });

    Sentry.addBreadcrumb({
      category: "validation",
      message: "Chat submission payload rejected",
      level: "warning",
      data: {
        issueCount: result.error.issues.length,
        fields: result.error.issues.map((i) => i.path.join(".")).join(", "),
      },
    });

    return c.json({ error: "Invalid request body" }, 400);
  }
});

/**
 * Tracks session IDs that currently have an active resume stream,
 * preventing duplicate concurrent resumes for the same session.
 */
const activeResumeSessionIds = new Set<string>();

/**
 * Converts raw DB messages into the format expected by the AI SDK.
 * Filters out ERROR role messages and empty ASSISTANT messages.
 */
function buildConversationHistory(
  messages: {
    role: "USER" | "ASSISTANT" | "ERROR";
    content: string;
    status: MessageStatus;
  }[],
) {
  return messages.flatMap((m) => {
    if (m.role === "ERROR") return [];
    if (m.role === "ASSISTANT" && m.content.length === 0) return [];

    return [
      {
        role: m.role === "USER" ? ("user" as const) : ("assistant" as const),
        content: m.content,
      },
    ];
  });
}

/**
 * Returns the last message in the session if it is a USER message,
 * indicating the session has a pending request that can be resumed.
 * Returns null if the session is not in a resumable state.
 */
function getResumableUserMessage(
  messages: {
    role: "USER" | "ASSISTANT" | "ERROR";
    model: string;
    mode: Mode;
  }[],
) {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "USER") {
    return null;
  }

  return lastMessage;
}

/** Parameters required to initiate an AI streaming response. */
type StreamParams = {
  sessionId: string;
  model: string;
  /** Working directory for tool execution; null disables tools. */
  cwd: string | null;
  history: { role: "user" | "assistant"; content: string }[];
  mode: Mode;
  abortController: AbortController;
};

/**
 * Streams an AI response over an SSE connection, handling the full
 * lifecycle of a chat turn:
 *
 * - Emits `reasoning-delta`, `text-delta`, `tool-call`, and
 *   `tool-result` events incrementally as the model produces them.
 * - Persists the completed assistant message to the database on success.
 * - Persists an INTERRUPTED message when the stream is aborted mid-flight.
 * - Persists an ERROR message and emits an error event on failure.
 */
async function streamAIResponse(
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  params: StreamParams,
) {
  const { sessionId, model, cwd, history, mode, abortController } = params;
  const startTime = Date.now();
  const tools = cwd ? createTools(cwd, mode) : undefined;
  const parts: MessagePart[] = [];
  const resolvedModel = resolveChatModel(model);

  Sentry.setTag("chat.session_id", sessionId);
  Sentry.setTag("chat.model", model);
  Sentry.setTag("chat.mode", mode);

  Sentry.addBreadcrumb({
    category: "chat",
    message: "Starting AI streaming response",
    level: "info",
    data: { sessionId, model, mode, hasTools: !!tools },
  });

  /**
   * Saves whatever partial content has been accumulated so far as an
   * INTERRUPTED message. Called when the stream is aborted before
   * completing, so the turn is not silently lost.
   */
  const persistInterruptedMessage = async () => {
    const fullText = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");

    if (fullText.length === 0 && parts.length === 0) return;

    const elapsedMs = Date.now() - startTime;

    const validatedParts: Prisma.InputJsonValue | undefined =
      parts.length > 0 ? messagePartsSchema.parse(parts) : undefined;

    Sentry.logger.info("Persisted interrupted message", {
      sessionId,
      elapsedMs,
    });

    Sentry.addBreadcrumb({
      category: "chat",
      message: "Message streaming interrupted",
      level: "warning",
      data: { sessionId, elapsedMs, textLength: fullText.length },
    });

    await db.message.create({
      data: {
        content: fullText,
        duration: Math.round(elapsedMs / 1000),
        mode,
        model,
        parts: validatedParts,
        role: "ASSISTANT",
        sessionId,
        status: MessageStatus.INTERRUPTED,
      },
    });
  };

  try {
    const result = aiStreamText({
      abortSignal: abortController.signal,
      messages: history,
      model: resolvedModel.model,
      providerOptions: resolvedModel.providerOptions,
      // Cap agentic loops at 50 steps when tools are available.
      stopWhen: tools ? stepCountIs(50) : undefined,
      system: buildSystemPrompt({ cwd, mode }),
      tools,
    });

    for await (const part of result.fullStream) {
      if (stream.aborted) break;

      if (part.type === "reasoning-delta") {
        const last = parts[parts.length - 1];
        if (last && last.type === "reasoning") {
          last.text += part.text;
        } else {
          parts.push({ type: "reasoning", text: part.text });
        }
        const event: ChatStreamEvent = {
          type: "reasoning-delta",
          text: part.text,
        };
        await stream.writeSSE({
          event: "reasoning-delta",
          data: JSON.stringify(event),
        });
      }

      if (part.type === "text-delta") {
        const last = parts[parts.length - 1];
        if (last && last.type === "text") {
          last.text += part.text;
        } else {
          parts.push({ type: "text", text: part.text });
        }
        const event: ChatStreamEvent = {
          type: "text-delta",
          text: part.text,
        };
        await stream.writeSSE({
          event: "text-delta",
          data: JSON.stringify(event),
        });
      }

      if (part.type === "tool-call") {
        const args = toolCallArgsSchema.parse(part.input);

        Sentry.addBreadcrumb({
          category: "tool",
          message: `Calling tool: ${part.toolName}`,
          level: "info",
          data: { toolCallId: part.toolCallId, input: part.input },
        });

        parts.push({
          type: "tool-call",
          id: part.toolCallId,
          name: part.toolName,
          args,
        });

        const event: ChatStreamEvent = {
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args,
        };

        await stream.writeSSE({
          event: "tool-call",
          data: JSON.stringify(event),
        });
      }

      if (part.type === "tool-result") {
        const resultString =
          typeof part.output === "string"
            ? part.output
            : JSON.stringify(part.output);

        // Attach the result to the matching tool-call part for persistence.
        const toolCallPart = parts.find(
          (p): p is Extract<MessagePart, { type: "tool-call" }> =>
            p.type === "tool-call" && p.id === part.toolCallId,
        );

        if (toolCallPart) {
          toolCallPart.result = resultString;
        }

        Sentry.addBreadcrumb({
          category: "tool",
          message: `Result for tool: ${part.toolName}`,
          level: "info",
          data: { toolCallId: part.toolCallId },
        });

        const event: ChatStreamEvent = {
          type: "tool-result",
          toolCallId: part.toolCallId,
          result: resultString,
        };

        await stream.writeSSE({
          event: "tool-result",
          data: JSON.stringify(event),
        });
      }

      if (part.type === "error") {
        throw part.error;
      }
    }

    if (stream.aborted || abortController.signal.aborted) {
      await persistInterruptedMessage();
      return;
    }

    const elapsedMs = Date.now() - startTime;
    const fullText = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");

    const validatedParts: Prisma.InputJsonValue | undefined =
      parts.length > 0 ? messagePartsSchema.parse(parts) : undefined;

    const assistantMessage = await db.message.create({
      data: {
        content: fullText,
        duration: Math.round(elapsedMs / 1000),
        model,
        mode,
        parts: validatedParts,
        role: "ASSISTANT",
        sessionId,
        status: MessageStatus.COMPLETE,
      },
    });

    Sentry.logger.info("AI streaming completed successfully", {
      sessionId,
      durationMs: elapsedMs,
    });

    const doneEvent: ChatStreamEvent = {
      type: "done",
      messageId: assistantMessage.id,
      durationMs: elapsedMs,
    };

    await stream.writeSSE({ event: "done", data: JSON.stringify(doneEvent) });
  } catch (error) {
    if (abortController.signal.aborted) {
      Sentry.addBreadcrumb({
        category: "chat",
        message: "AI response aborted by signal during stream",
        level: "info",
      });
      await persistInterruptedMessage();
      return;
    }

    const message = error instanceof Error ? error.message : String(error);

    Sentry.captureException(error, {
      tags: { "error.type": "ai_stream_failed" },
      extra: { sessionId, model, mode },
    });
    Sentry.logger.error("AI stream response failed", { sessionId, message });

    // Store a visible ERROR message so the UI can surface the failure.
    await db.message.create({
      data: {
        content: message,
        model,
        mode,
        role: "ERROR",
        sessionId,
        status: MessageStatus.COMPLETE,
      },
    });

    const errorEvent: ChatStreamEvent = { type: "error", message: message };

    await stream.writeSSE({ event: "error", data: JSON.stringify(errorEvent) });
  }
}

const app = new Hono<AuthenticatedEnv>()
  /**
   * POST /:sessionId/resume
   *
   * Re-runs the AI response for a session whose last message is an
   * unanswered USER message (e.g. after a server restart or network drop).
   * Returns 409 if the session is already being resumed.
   */
  .post("/:sessionId/resume", async (c) => {
    const sessionId = c.req.param("sessionId");
    const userId = c.get("userId");

    Sentry.setTag("session.id", sessionId);
    Sentry.addBreadcrumb({
      category: "chat",
      message: "Request to resume session",
      level: "info",
      data: { sessionId },
    });

    const session = await db.session.findUnique({
      where: { id: sessionId, userId },
      include: {
        messages: {
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    if (!session) {
      Sentry.logger.warn("Session not found for resume", { sessionId, userId });
      return c.json({ error: "Session not found" }, 404);
    }

    const resumableMessage = getResumableUserMessage(session.messages);
    if (!resumableMessage) {
      Sentry.logger.warn("Session has no pending user message to resume", {
        sessionId,
      });
      return c.json(
        { error: "Session has no pending user message to resume" },
        409,
      );
    }

    if (!isSupportedChatModel(resumableMessage.model)) {
      Sentry.logger.warn("Session uses unsupported model for resume", {
        sessionId,
        model: resumableMessage.model,
      });
      return c.json(
        { error: `Session uses unsupported model: ${resumableMessage.model}` },
        409,
      );
    }

    if (activeResumeSessionIds.has(sessionId)) {
      Sentry.logger.warn("Session already has an active resume", { sessionId });
      return c.json({ error: "Session already has an active resume" }, 409);
    }

    activeResumeSessionIds.add(sessionId);

    const history = buildConversationHistory(session.messages);
    const abortController = new AbortController();

    try {
      return streamSSE(
        c,
        async (stream) => {
          stream.onAbort(() => {
            abortController.abort();
          });

          try {
            await streamAIResponse(stream, {
              abortController,
              cwd: session.cwd,
              history,
              mode: resumableMessage.mode,
              model: resumableMessage.model,
              sessionId,
            });
          } finally {
            // Always release the lock so a future resume can proceed.
            activeResumeSessionIds.delete(sessionId);
          }
        },
        async (err, stream) => {
          activeResumeSessionIds.delete(sessionId);
          Sentry.captureException(err, {
            tags: {
              "error.type": "sse_stream_error",
              "sse.operation": "resume",
            },
            extra: { sessionId },
          });
          const message = err instanceof Error ? err.message : String(err);
          Sentry.logger.error("SSE stream resume error callback triggered", {
            sessionId,
            message,
          });
          const errorEvent: ChatStreamEvent = {
            type: "error",
            message: message,
          };

          await stream.writeSSE({
            event: "error",
            data: JSON.stringify(errorEvent),
          });
        },
      );
    } catch (error) {
      activeResumeSessionIds.delete(sessionId);
      Sentry.captureException(error, {
        tags: { "error.type": "resume_route_failed" },
        extra: { sessionId },
      });
      Sentry.logger.error("Resume route handler threw exception", {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  })
  /**
   * POST /:sessionId
   *
   * Accepts a new user message, persists it, then streams the AI
   * response back over SSE. Validated by `submitValidator`.
   */
  .post("/:sessionId", submitValidator, async (c) => {
    const sessionId = c.req.param("sessionId");
    const userId = c.get("userId");

    Sentry.setTag("session.id", sessionId);
    Sentry.addBreadcrumb({
      category: "chat",
      message: "Request to submit chat message",
      level: "info",
      data: { sessionId },
    });

    const session = await db.session.findUnique({
      where: { id: sessionId, userId },
      include: {
        messages: {
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    if (!session) {
      Sentry.logger.warn("Session not found for submission", {
        sessionId,
        userId,
      });
      return c.json({ error: "Session not found" }, 404);
    }

    const data = c.req.valid("json");

    await db.message.create({
      data: {
        sessionId,
        role: "USER",
        status: MessageStatus.COMPLETE,
        model: data.model,
        content: data.content,
        mode: data.mode,
      },
    });

    // Include the new user message in history before streaming.
    const history = buildConversationHistory([
      ...session.messages,
      { role: "USER", content: data.content, status: MessageStatus.COMPLETE },
    ]);

    const abortController = new AbortController();

    try {
      return streamSSE(
        c,
        async (stream) => {
          stream.onAbort(() => {
            abortController.abort();
          });

          await streamAIResponse(stream, {
            abortController,
            cwd: session.cwd,
            history,
            mode: data.mode,
            model: data.model,
            sessionId,
          });
        },
        async (err, stream) => {
          Sentry.captureException(err, {
            tags: {
              "error.type": "sse_stream_error",
              "sse.operation": "submit",
            },
            extra: { sessionId },
          });
          const message = err instanceof Error ? err.message : String(err);
          Sentry.logger.error("SSE stream submit error callback triggered", {
            sessionId,
            message,
          });
          const errorEvent: ChatStreamEvent = {
            type: "error",
            message: message,
          };

          await stream.writeSSE({
            event: "error",
            data: JSON.stringify(errorEvent),
          });
        },
      );
    } catch (error) {
      Sentry.captureException(error, {
        tags: { "error.type": "submit_route_failed" },
        extra: { sessionId },
      });
      Sentry.logger.error("Submit route handler threw exception", {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });

export default app;
