/**
 * Session routes — handles CRUD operations for chat sessions.
 * All routes require an authenticated user (via AuthenticatedEnv).
 */

import { zValidator } from "@hono/zod-validator";
import { db } from "@nightcode/database/client";
import { MessageStatus, Mode, Role } from "@nightcode/database/enums";
import { findSupportedChatModel } from "@nightcode/shared";
import * as Sentry from "@sentry/hono/bun";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AuthenticatedEnv } from "../middleware/require-auth";

/** Shape of the request body for creating a new session. */
const createSessionSchema = z.object({
  title: z.string(),
  cwd: z.string().optional(),
  /** If provided, this message is created together with the session. */
  initialMessage: z
    .object({
      role: z.enum(Role),
      content: z.string(),
      mode: z.enum(Mode),
      /** Must be a model ID supported by findSupportedChatModel. */
      model: z
        .string()
        .refine((id) => !!findSupportedChatModel(id), "Unsupported model"),
    })
    .optional(),
});

/**
 * Zod validator middleware for POST /sessions.
 * Returns 400 and logs a Sentry warning when validation fails.
 */
const createSessionValidator = zValidator(
  "json",
  createSessionSchema,
  (result, c) => {
    if (!result.success) {
      Sentry.logger.warn("Session creation validation failed", {
        path: c.req.path,
        issues: result.error.issues.length,
      });

      Sentry.addBreadcrumb({
        category: "validation",
        message: "Session creation payload rejected",
        level: "warning",
        data: {
          issueCount: result.error.issues.length,
          fields: result.error.issues.map((i) => i.path.join(".")).join(", "),
        },
      });

      return c.json({ error: "Invalid request body" }, 400);
    }
  },
);

const app = new Hono<AuthenticatedEnv>()
  /**
   * GET /
   * Returns all sessions for the authenticated user, ordered newest first.
   */
  .get("/", async (c) => {
    const userId = c.get("userId");

    Sentry.addBreadcrumb({
      category: "db",
      message: "Querying all sessions",
      level: "info",
    });

    try {
      const sessions = await db.session.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          title: true,
          createdAt: true,
        },
      });

      Sentry.logger.info("Listed sessions", {
        count: sessions.length,
      });

      return c.json(sessions);
    } catch (error) {
      Sentry.captureException(error, {
        tags: { "error.type": "database", "db.operation": "session.findMany" },
      });
      Sentry.logger.error("Failed to list sessions", {
        message: error instanceof Error ? error.message : "Unknown error",
      });

      throw new HTTPException(500, { message: "Failed to load sessions" });
    }
  })
  /**
   * GET /:id
   * Returns a single session with its messages, ordered oldest first.
   * Responds with 404 if the session doesn't exist or belongs to another user.
   */
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const userId = c.get("userId");

    Sentry.setTag("session.id", id);
    Sentry.addBreadcrumb({
      category: "db",
      message: `Loading session ${id}`,
      level: "info",
    });

    try {
      const session = await db.session.findUnique({
        where: { id, userId },
        include: {
          messages: {
            orderBy: { createdAt: "asc" },
          },
        },
      });

      if (!session) {
        Sentry.logger.warn("Session not found", {
          sessionId: id,
        });

        return c.json({ error: "Session not found" }, 404);
      }

      Sentry.logger.info("Loaded session", {
        sessionId: id,
        messageCount: session.messages.length,
      });

      return c.json(session);
    } catch (error) {
      Sentry.captureException(error, {
        tags: {
          "error.type": "database",
          "db.operation": "session.findUnique",
        },
        extra: { sessionId: id },
      });
      Sentry.logger.error("Failed to load session", {
        sessionId: id,
        message: error instanceof Error ? error.message : "Unknown error",
      });

      throw new HTTPException(500, { message: "Failed to load session" });
    }
  })
  /**
   * POST /
   * Creates a new session for the authenticated user.
   * If initialMessage is provided, it is persisted with status COMPLETE
   * in the same database transaction. Responds with 201 on success.
   */
  .post("/", createSessionValidator, async (c) => {
    const { initialMessage, ...data } = c.req.valid("json");
    const userId = c.get("userId");

    Sentry.addBreadcrumb({
      category: "db",
      message: `Creating session "${data.title}"`,
      level: "info",
      data: { hasInitialMessage: !!initialMessage },
    });

    try {
      const session = await db.session.create({
        data: {
          ...data,
          userId,
          ...(initialMessage && {
            messages: {
              create: {
                ...initialMessage,
                status: MessageStatus.COMPLETE,
              },
            },
          }),
        },
        include: {
          messages: true,
        },
      });

      Sentry.setTag("session.id", session.id);
      Sentry.logger.info("Created session", {
        sessionId: session.id,
        title: session.title,
        hasInitialMessage: session.messages.length > 0,
      });

      return c.json(session, 201);
    } catch (error) {
      Sentry.captureException(error, {
        tags: { "error.type": "database", "db.operation": "session.create" },
        extra: { title: data.title, hasInitialMessage: !!initialMessage },
      });
      Sentry.logger.error("Failed to create session", {
        title: data.title,
        message: error instanceof Error ? error.message : "Unknown error",
      });

      throw new HTTPException(500, { message: "Failed to create session" });
    }
  });

export default app;
