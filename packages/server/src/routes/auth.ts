import * as Sentry from "@sentry/hono/bun";
import { Hono } from "hono";

const app = new Hono().get("/callback", (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  const errorDescription = c.req.query("error_description");

  Sentry.addBreadcrumb({
    category: "auth",
    message: "Auth callback route hit",
    level: "info",
    data: {
      hasError: !!error,
      hasCode: !!code,
      hasState: !!state,
    },
  });

  if (error) {
    Sentry.logger.warn("OAuth callback returned error", {
      error,
      errorDescription,
    });
    return c.text(errorDescription ?? error, 400);
  }

  if (!code || !state) {
    Sentry.logger.warn("OAuth callback missing code or state parameter", {
      hasCode: !!code,
      hasState: !!state,
    });
    return c.text("Missing authorization code or state", 400);
  }

  try {
    const [encoded] = state.split(".");
    if (!encoded) throw new Error("Invalid state format");

    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
    const port = payload.port;

    if (!port || typeof port !== "number") {
      throw new Error("Invalid port in state");
    }

    const redirectUrl = `http://localhost:${port}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;

    Sentry.addBreadcrumb({
      category: "auth",
      message: "OAuth callback successful, redirecting to CLI port",
      level: "info",
      data: { port },
    });

    return c.redirect(redirectUrl);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { "error.type": "auth_callback_failed" },
      extra: { state },
    });
    Sentry.logger.error("Auth callback failed parsing state or redirecting", {
      message: err instanceof Error ? err.message : "Unknown error",
    });
    return c.text("Invalid authentication state", 400);
  }
});

export default app;
