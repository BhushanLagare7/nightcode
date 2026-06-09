import { zValidator } from "@hono/zod-validator";
import type { Prisma } from "@nightcode/database";
import { db } from "@nightcode/database/client";
import {
  getToolContracts,
  modeSchema,
  type ModeType,
  type ToolContracts,
} from "@nightcode/shared";
import {
  convertToModelMessages,
  streamText,
  validateUIMessages,
  type InferUITools,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import { Hono } from "hono";
import { z } from "zod";
import { calculateCreditsForUsage } from "../lib/credits";
import { isSupportedChatModel, resolveChatModel } from "../lib/models";
import { ingestAiUsage } from "../lib/polar";
import type { AuthenticatedEnv } from "../middleware/require-auth";
import { requireCreditsBalance } from "../middleware/require-credits-balance";
import { buildSystemPrompt } from "../system-prompt";

/** Metadata attached to each chat message, populated progressively during streaming. */
type ChatMessageMetadata = {
  mode?: ModeType;
  model?: string;
  /** Total time taken to generate the response in milliseconds. */
  durationMs?: number;
  usage?: LanguageModelUsage;
};

/** Extended UI message type that carries Nightcode-specific metadata and tool contracts. */
type NightcodeUIMessage = UIMessage<
  ChatMessageMetadata,
  never,
  InferUITools<ToolContracts>
>;

/** Expected shape of the chat submission request body. */
const submitSchema = z.object({
  /** The session ID to associate the messages with. */
  id: z.string(),
  messages: z
    .array(
      z.custom<NightcodeUIMessage>((value) => {
        // Ensure each message has the minimum required fields
        return (
          value != null &&
          typeof value === "object" &&
          "id" in value &&
          "parts" in value
        );
      }),
    )
    .min(1),
  mode: modeSchema,
  model: z.string().refine(isSupportedChatModel, "Unsupported model"),
});

/** Validates the request JSON body against `submitSchema`, returning a 400 on failure. */
const submitValidator = zValidator("json", submitSchema, (result, c) => {
  if (!result.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }
});

/**
 * Returns true if the message contains any tool call parts that have not
 * yet received a result. Used to defer session persistence until all tool
 * calls are resolved.
 */
function hasPendingToolCalls(message: NightcodeUIMessage) {
  return message.parts.some((part) => {
    if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      const state = (part as { state?: string }).state;
      return state !== "output-available" && state !== "output-error";
    }

    return false;
  });
}

/**
 * POST /
 *
 * Accepts a chat submission, streams the AI response back to the client,
 * and — once the stream is complete — persists the updated message history
 * and reports token usage for billing.
 *
 * Middleware applied (in order):
 *  1. `requireCreditsBalance` – rejects the request when the user has no credits.
 *  2. `submitValidator`       – validates and parses the JSON request body.
 */
const app = new Hono<AuthenticatedEnv>().post(
  "/",
  requireCreditsBalance,
  submitValidator,
  async (c) => {
    const userId = c.get("userId");
    const { id, messages, mode, model } = c.req.valid("json");

    // Verify the session belongs to the authenticated user
    const session = await db.session.findUnique({
      where: { id, userId },
    });

    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const startTime = Date.now();
    const tools = getToolContracts(mode);
    const resolvedModel = resolveChatModel(model);

    // Reconstruct the full message history by merging persisted and incoming messages
    const previousMessages = Array.isArray(session.messages)
      ? (session.messages as unknown as NightcodeUIMessage[])
      : [];
    const mergedMessages = [...previousMessages];

    for (const message of messages) {
      // Stamp each incoming message with the current mode and model
      const incomingMessage = {
        ...message,
        metadata: { ...message.metadata, mode, model },
      } satisfies NightcodeUIMessage;

      const existingMessageIndex = mergedMessages.findIndex(
        (m) => m.id === incomingMessage.id,
      );

      // Insert new messages; replace existing ones (e.g. optimistic updates)
      if (existingMessageIndex === -1) {
        mergedMessages.push(incomingMessage);
      } else {
        mergedMessages[existingMessageIndex] = incomingMessage;
      }
    }

    // Validate the final message list and convert to the format expected by the model
    const nextMessages = await validateUIMessages<NightcodeUIMessage>({
      messages: mergedMessages,
      tools,
    });
    const modelMessages = await convertToModelMessages(nextMessages, { tools });

    // Captured inside `onFinish` so it is available to the streaming metadata callback
    let completedUsage: LanguageModelUsage | null = null;

    const result = streamText({
      model: resolvedModel.model,
      system: buildSystemPrompt({ mode }),
      messages: modelMessages,
      tools,
      providerOptions: resolvedModel.providerOptions,
      onFinish(event) {
        completedUsage = event.totalUsage;
      },
    });

    return result.toUIMessageStreamResponse<NightcodeUIMessage>({
      originalMessages: nextMessages,
      /** Attaches metadata to the stream at the start and finish parts. */
      messageMetadata({ part }) {
        if (part.type === "start") {
          return { mode, model };
        }

        if (part.type !== "finish") return undefined;

        return {
          mode,
          model,
          durationMs: Date.now() - startTime,
          ...(completedUsage ? { usage: completedUsage } : {}),
        };
      },
      async onFinish(event) {
        // Do not persist if the stream was aborted or tool calls are still pending
        if (event.isAborted) return;
        if (hasPendingToolCalls(event.responseMessage)) return;

        // Persist the updated message history to the database
        await db.session.update({
          where: { id, userId },
          data: {
            messages: event.messages as unknown as Prisma.InputJsonValue,
          },
        });

        if (!completedUsage) return;

        // Report token usage to Polar for credit billing
        try {
          const billableUsage = calculateCreditsForUsage({
            provider: resolvedModel.provider,
            model: resolvedModel.modelId,
            usage: completedUsage,
          });

          await ingestAiUsage({
            externalCustomerId: userId,
            eventId: `chat-message:${event.responseMessage.id}`,
            credits: billableUsage.credits,
          });
        } catch (error) {
          console.error("Failed to ingest Polar AI usage for chat message", {
            error,
            sessionId: id,
            messageId: event.responseMessage.id,
            userId,
          });
        }
      },
      onError(error) {
        return error instanceof Error ? error.message : String(error);
      },
    });
  },
);

export default app;
