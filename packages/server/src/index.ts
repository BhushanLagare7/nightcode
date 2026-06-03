import * as Sentry from "@sentry/hono/bun";
import { sentry } from "@sentry/hono/bun";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import sessions from "./routes/sessions";

const app = new Hono();

app.use(
  sentry(app, {
    dsn: "https://623eae9b977b6c8d0007444c2c1b22a3@o4510142950473728.ingest.us.sentry.io/4511502817230848",
    tracesSampleRate: 1.0,
    enableLogs: true,
    sendDefaultPii: true,
  }),
);

app.get("/debug-sentry", () => {
  // Send a log before throwing the error
  Sentry.logger.info("User triggered test error", {
    action: "test_error_endpoint",
  });
  // Send a test metric before throwing the error
  Sentry.metrics.count("test_counter", 1);
  throw new Error("My first Sentry error!");
});

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    Sentry.logger.warn("Handled HTTP error", {
      status: error.status,
      message: error.message || "Request failed",
      path: c.req.path,
      method: c.req.method,
    });

    return c.json({ error: error.message || "Request failed" }, error.status);
  }

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
