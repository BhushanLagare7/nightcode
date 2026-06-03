import * as Sentry from "@sentry/hono/bun";
import { sentry } from "@sentry/hono/bun";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import sessions from "./routes/sessions";

const app = new Hono();

// --- Sentry configuration (env-aware) ---
const sentryDsn = process.env.SENTRY_DSN;
const isDev = process.env.NODE_ENV !== "production";

if (sentryDsn) {
  app.use(
    sentry(app, {
      dsn: sentryDsn,
      tracesSampleRate: isDev ? 1.0 : 0.1,
      enableLogs: true,
      sendDefaultPii: isDev,
    }),
  );

  Sentry.logger.info("Sentry SDK initialized", {
    environment: isDev ? "development" : "production",
    tracesSampleRate: isDev ? 1.0 : 0.1,
  });
} else {
  console.warn("[sentry] SENTRY_DSN not set – error reporting disabled");
}

// --- Request-scoped Sentry context ---
app.use(async (c, next) => {
  Sentry.setTag("http.method", c.req.method);
  Sentry.setTag("http.route", c.req.routePath);
  Sentry.setContext("request", {
    url: c.req.url,
    method: c.req.method,
    path: c.req.path,
    headers: {
      "user-agent": c.req.header("user-agent"),
      "content-type": c.req.header("content-type"),
    },
  });

  Sentry.addBreadcrumb({
    category: "http",
    message: `${c.req.method} ${c.req.path}`,
    level: "info",
  });

  await next();
});

app.get("/debug-sentry", () => {
  Sentry.logger.info("User triggered test error", {
    action: "test_error_endpoint",
  });
  Sentry.metrics.count("test_counter", 1);
  throw new Error("My first Sentry error!");
});

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    // HTTP exceptions are expected errors – log as warnings, don't capture
    Sentry.logger.warn("Handled HTTP error", {
      status: error.status,
      message: error.message || "Request failed",
      path: c.req.path,
      method: c.req.method,
    });

    if (error.status >= 500) {
      Sentry.captureException(error, {
        tags: { "error.type": "http_exception", "http.status": error.status },
        extra: { path: c.req.path, method: c.req.method },
      });
    }

    return c.json({ error: error.message || "Request failed" }, error.status);
  }

  // Unexpected errors – capture exception for Sentry Issues
  Sentry.captureException(error, {
    tags: { "error.type": "unhandled" },
    extra: {
      path: c.req.path,
      method: c.req.method,
      message: error instanceof Error ? error.message : "Unknown error",
    },
  });

  Sentry.logger.error("Unhandled server error", {
    path: c.req.path,
    method: c.req.method,
    message: error instanceof Error ? error.message : "Unknown error",
  });

  return c.json({ error: "Internal Server Error" }, 500);
});

const routes = app.route("/sessions", sessions);

export type AppType = typeof routes;

// "idleTimeout" must be high, otherwise LLM tool calls might not complete
export default { port: 3000, fetch: app.fetch, idleTimeout: 255 };
