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
import { streamText as aiStreamText, stepCountIs } from "ai";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { isSupportedChatModel, resolveChatModel } from "../lib/models";
import { buildSystemPrompt } from "../system-prompt";
import { createTools } from "../tools";

const submitSchema = z.object({
  content: z.string(),
  mode: z.enum(Mode),
  model: z.string().refine(isSupportedChatModel, "Unsupported model"),
});

const submitValidator = zValidator("json", submitSchema, (result, c) => {
  if (!result.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }
});

const activeResumeSessionIds = new Set<string>();

// Strip error messages and empty assistant messages from the conversations
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

type StreamParams = {
  sessionId: string;
  model: string;
  cwd: string | null;
  history: { role: "user" | "assistant"; content: string }[];
  mode: Mode;
  abortController: AbortController;
};

async function streamAIResponse(
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  params: StreamParams,
) {
  const { sessionId, model, cwd, history, mode, abortController } = params;
  const startTime = Date.now();
  const tools = cwd ? createTools(cwd, mode) : undefined;
  const parts: MessagePart[] = [];
  const resolvedModel = resolveChatModel(model);

  const persistInterruptedMessage = async () => {
    const fullText = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");

    if (fullText.length === 0 && parts.length === 0) return;

    const elapsedMs = Date.now() - startTime;

    const validatedParts: Prisma.InputJsonValue | undefined =
      parts.length > 0 ? messagePartsSchema.parse(parts) : undefined;

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

        const toolCallPart = parts.find(
          (p): p is Extract<MessagePart, { type: "tool-call" }> =>
            p.type === "tool-call" && p.id === part.toolCallId,
        );

        if (toolCallPart) {
          toolCallPart.result = resultString;
        }

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

    const doneEvent: ChatStreamEvent = {
      type: "done",
      messageId: assistantMessage.id,
      durationMs: elapsedMs,
    };

    await stream.writeSSE({ event: "done", data: JSON.stringify(doneEvent) });
  } catch (error) {
    if (abortController.signal.aborted) {
      await persistInterruptedMessage();
      return;
    }

    const message = error instanceof Error ? error.message : String(error);

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

const app = new Hono()
  .post("/:sessionId/resume", async (c) => {
    const sessionId = c.req.param("sessionId");

    const session = await db.session.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const resumableMessage = getResumableUserMessage(session.messages);
    if (!resumableMessage) {
      return c.json(
        { error: "Session has no pending user message to resume" },
        409,
      );
    }

    if (!isSupportedChatModel(resumableMessage.model)) {
      return c.json(
        { error: `Session uses unsupported model: ${resumableMessage.model}` },
        409,
      );
    }

    if (activeResumeSessionIds.has(sessionId)) {
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
            activeResumeSessionIds.delete(sessionId);
          }
        },
        async (err, stream) => {
          activeResumeSessionIds.delete(sessionId);
          const message = err instanceof Error ? err.message : String(err);
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
      throw error;
    }
  })
  .post("/:sessionId", submitValidator, async (c) => {
    const sessionId = c.req.param("sessionId");

    const session = await db.session.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    if (!session) {
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

    const history = buildConversationHistory([
      ...session.messages,
      { role: "USER", content: data.content, status: MessageStatus.COMPLETE },
    ]);

    const abortController = new AbortController();

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
        const message = err instanceof Error ? err.message : String(err);
        const errorEvent: ChatStreamEvent = { type: "error", message: message };

        await stream.writeSSE({
          event: "error",
          data: JSON.stringify(errorEvent),
        });
      },
    );
  });

export default app;
