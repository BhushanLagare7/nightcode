import * as Sentry from "@sentry/hono/bun";
import { createMiddleware } from "hono/factory";
import { authenticateOAuthRequest } from "../lib/auth";

export type AuthenticatedEnv = {
  Variables: {
    userId: string;
  };
};

export const requireAuth = createMiddleware<AuthenticatedEnv>(
  async (c, next) => {
    try {
      const auth = await authenticateOAuthRequest(c.req.raw);
      if (!auth) {
        Sentry.logger.warn("Authentication failed: No valid OAuth session", {
          path: c.req.path,
          method: c.req.method,
        });
        return c.json({ error: "Unauthorized. Run /login to continue." }, 401);
      }

      c.set("userId", auth.userId);
      Sentry.setUser({ id: auth.userId });

      Sentry.addBreadcrumb({
        category: "auth",
        message: "User authenticated successfully",
        level: "info",
        data: { userId: auth.userId },
      });

      await next();
    } catch (error) {
      Sentry.captureException(error, {
        tags: { "error.type": "auth_middleware_failed" },
        extra: { path: c.req.path, method: c.req.method },
      });
      Sentry.logger.error("Authentication failed with exception", {
        path: c.req.path,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      return c.json({ error: "Unauthorized. Run /login to continue." }, 401);
    }
  },
);
