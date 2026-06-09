import * as Sentry from "@sentry/hono/bun";
import { createMiddleware } from "hono/factory";
import { getAvailableCreditsBalance } from "../lib/polar";
import type { AuthenticatedEnv } from "./require-auth";

export const requireCreditsBalance = createMiddleware<AuthenticatedEnv>(
  async (c, next) => {
    const userId = c.get("userId");

    Sentry.addBreadcrumb({
      category: "billing",
      message: "Checking credits balance",
      level: "info",
      data: { userId },
    });

    try {
      const creditsBalance = await getAvailableCreditsBalance(userId);

      Sentry.setTag("credits.balance", creditsBalance);

      // This is a simple launch-time gate: only start new work when the customer
      // still has credits left. It does not reserve the full eventual cost of the
      // request, so low-volume apps may tolerate small overspend on edge cases.
      if (creditsBalance <= 0) {
        Sentry.logger.warn("Credits balance depleted", {
          userId,
          creditsBalance,
        });
        Sentry.addBreadcrumb({
          category: "billing",
          message: "User blocked due to depleted credits balance",
          level: "warning",
          data: { userId, creditsBalance },
        });

        return c.json(
          { error: "No credits remaining. Run /upgrade to buy more credits." },
          402,
        );
      }

      await next();
    } catch (error) {
      Sentry.captureException(error, {
        tags: { "error.type": "credits_verification_failed" },
        extra: { userId },
      });
      Sentry.logger.error("Failed to verify credits balance", {
        userId,
        message: error instanceof Error ? error.message : String(error),
      });

      return c.json(
        { error: "Unable to verify credits balance right now." },
        503,
      );
    }
  },
);
