import * as Sentry from "@sentry/hono/bun";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createCheckoutUrl, createCustomerPortalUrl } from "../lib/polar";
import type { AuthenticatedEnv } from "../middleware/require-auth";

const app = new Hono<AuthenticatedEnv>()
  .post("/checkout", async (c) => {
    const userId = c.get("userId");

    Sentry.addBreadcrumb({
      category: "billing",
      message: "Creating checkout URL",
      level: "info",
      data: { userId },
    });

    try {
      const url = await createCheckoutUrl({
        customerExternalId: userId,
        requestUrl: c.req.url,
      });

      Sentry.logger.info("Created checkout URL successfully", { userId });
      return c.json({ url });
    } catch (error) {
      Sentry.captureException(error, {
        tags: { "error.type": "billing", "billing.operation": "createCheckoutUrl" },
        extra: { userId },
      });
      Sentry.logger.error("Failed to create checkout URL", {
        userId,
        message: error instanceof Error ? error.message : "Unknown error",
      });

      throw new HTTPException(500, { message: "Failed to initiate checkout" });
    }
  })
  .post("/portal", async (c) => {
    const userId = c.get("userId");

    Sentry.addBreadcrumb({
      category: "billing",
      message: "Creating customer portal URL",
      level: "info",
      data: { userId },
    });

    try {
      const url = await createCustomerPortalUrl({
        customerExternalId: userId,
        requestUrl: c.req.url,
      });

      Sentry.logger.info("Created customer portal URL successfully", { userId });
      return c.json({ url });
    } catch (error) {
      Sentry.captureException(error, {
        tags: { "error.type": "billing", "billing.operation": "createCustomerPortalUrl" },
        extra: { userId },
      });
      Sentry.logger.error("Failed to create customer portal URL", {
        userId,
        message: error instanceof Error ? error.message : "Unknown error",
      });

      throw new HTTPException(500, { message: "Failed to open customer portal" });
    }
  })
  .get("/success", (c) =>
    c.text("Done. You can close this tab and return to Nightcode."),
  );

export default app;
