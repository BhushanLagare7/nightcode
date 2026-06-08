/**
 * @fileoverview OAuth 2.0 + PKCE authentication flow implementation for CLI login.
 *
 * This module handles the complete OAuth login process by:
 * 1. Spinning up a temporary local HTTP server to receive the OAuth callback
 * 2. Opening the user's browser to the Clerk authorization URL
 * 3. Exchanging the authorization code for an access token via PKCE flow
 * 4. Persisting the token using the auth module
 *
 * @module login
 */

import open from "open";
import { saveAuth } from "./auth";

/**
 * Maximum time (in milliseconds) to wait for the user to complete the login
 * flow before automatically rejecting the promise and stopping the server.
 *
 * @constant {number} LOGIN_TIMEOUT_MS - Defaults to 5 minutes.
 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Represents the OAuth state parameter payload that is encoded and passed
 * through the authorization request to prevent CSRF attacks.
 *
 * @typedef {Object} OAuthState
 * @property {string} nonce - A cryptographically random value used to verify
 *   the integrity of the state returned by the authorization server.
 * @property {number} port - The local port on which the temporary callback
 *   server is listening. Used to reconstruct the redirect URI if needed.
 */
type OAuthState = {
  nonce: string;
  port: number;
};

/**
 * Encodes a `Uint8Array` or plain string into a Base64URL-encoded string.
 *
 * Base64URL encoding is URL-safe (replaces `+` with `-`, `/` with `_`,
 * and omits padding `=` characters), making it suitable for use in URLs
 * and OAuth parameters such as PKCE code challenges and state values.
 *
 * @param {Uint8Array | string} input - The raw bytes or string to encode.
 * @returns {string} The Base64URL-encoded representation of the input.
 *
 * @example
 * toBase64Url("hello world"); // => "aGVsbG8gd29ybGQ"
 * toBase64Url(new Uint8Array([104, 101, 108, 108, 111])); // => "aGVsbG8"
 */
function toBase64Url(input: Uint8Array | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Generates a PKCE (Proof Key for Code Exchange) code challenge from a
 * given code verifier string, as defined in RFC 7636.
 *
 * The challenge is computed as:
 * ```
 * code_challenge = BASE64URL(SHA-256(ASCII(code_verifier)))
 * ```
 *
 * This prevents authorization code interception attacks by ensuring that
 * only the party that generated the verifier can exchange the code for tokens.
 *
 * @param {string} verifier - A high-entropy cryptographically random string
 *   (the code verifier) generated before the authorization request.
 * @returns {Promise<string>} A promise that resolves to the Base64URL-encoded
 *   SHA-256 hash of the verifier (the code challenge).
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc7636 RFC 7636 - PKCE}
 *
 * @example
 * const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
 * const challenge = await createPkceChallenge(verifier);
 */
async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return toBase64Url(new Uint8Array(digest));
}

/**
 * Serializes an {@link OAuthState} object into a Base64URL-encoded string
 * suitable for use as the OAuth `state` query parameter.
 *
 * The state is JSON-serialized and then Base64URL-encoded to produce a
 * compact, URL-safe representation.
 *
 * @param {OAuthState} state - The state payload containing the nonce and port.
 * @returns {string} A Base64URL-encoded string representing the serialized state.
 *
 * @example
 * const encoded = encodeState({ nonce: "abc123", port: 51423 });
 * // => "eyJub25jZSI6ImFiYzEyMyIsInBvcnQiOjUxNDIzfQ"
 */
function encodeState(state: OAuthState): string {
  return toBase64Url(JSON.stringify(state));
}

/**
 * Deserializes a Base64URL-encoded OAuth state string back into an
 * {@link OAuthState} object.
 *
 * The authorization server may append a `.` separator followed by additional
 * data (e.g., Clerk appends its own signature). Only the first segment
 * before the `.` is decoded and parsed as the original state payload.
 *
 * @param {string} state - The raw `state` query parameter value received
 *   in the OAuth callback URL.
 * @returns {OAuthState} The decoded state object containing the nonce and port.
 * @throws {Error} Throws `"Invalid state"` if the encoded segment is missing
 *   or the value cannot be parsed as valid JSON.
 *
 * @example
 * const state = decodeState("eyJub25jZSI6ImFiYzEyMyIsInBvcnQiOjUxNDIzfQ");
 * // => { nonce: "abc123", port: 51423 }
 */
function decodeState(state: string): OAuthState {
  const [encoded] = state.split(".");
  if (!encoded) {
    throw new Error("Invalid state");
  }

  return JSON.parse(Buffer.from(encoded, "base64url").toString()) as OAuthState;
}

/**
 * Safely extracts a human-readable message from an unknown thrown value.
 *
 * Useful in `catch` blocks where TypeScript types the caught value as
 * `unknown`. Returns `error.message` for `Error` instances, or the
 * string representation for any other value.
 *
 * @param {unknown} error - The value caught in a try/catch block.
 * @returns {string} A string message describing the error.
 *
 * @example
 * getErrorMessage(new Error("Something went wrong")); // => "Something went wrong"
 * getErrorMessage("oops");                            // => "oops"
 * getErrorMessage(42);                                // => "42"
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Initiates the OAuth 2.0 Authorization Code Flow with PKCE to authenticate
 * the CLI user via their default web browser.
 *
 * ### Flow Overview
 * 1. Reads required environment variables (`CLERK_FRONTEND_API`, `CLERK_OAUTH_CLIENT_ID`, `API_URL`).
 * 2. Generates a cryptographically secure `nonce` and PKCE `code_verifier` / `code_challenge` pair.
 * 3. Starts a temporary local HTTP server (on a random available port) to handle the OAuth callback.
 * 4. Constructs and opens the Clerk authorization URL in the user's default browser.
 * 5. Waits for the browser to redirect to `{API_URL}/auth/callback`, which should
 *    proxy the request back to the local callback server.
 * 6. Validates the returned `state` parameter (nonce check) to prevent CSRF attacks.
 * 7. Exchanges the received `code` for an access token using the PKCE verifier.
 * 8. Persists the token via {@link saveAuth} and resolves the returned promise.
 *
 * The local server is automatically stopped 500ms after the flow settles
 * (either successfully or with an error), or after {@link LOGIN_TIMEOUT_MS}
 * if the user does not complete the login in time.
 *
 * ### Required Environment Variables
 * | Variable                | Description                                      |
 * |-------------------------|--------------------------------------------------|
 * | `CLERK_FRONTEND_API`    | Base URL of the Clerk Frontend API               |
 * | `CLERK_OAUTH_CLIENT_ID` | OAuth client ID registered in Clerk              |
 * | `API_URL`               | _(optional)_ Base URL of the API server. Defaults to `http://localhost:3000` |
 *
 * @returns {Promise<{ token: string }>} Resolves with the access token upon
 *   successful authentication.
 *
 * @throws {Error} `"CLERK_FRONTEND_API not set"` - If the Clerk Frontend API env var is missing.
 * @throws {Error} `"CLERK_OAUTH_CLIENT_ID not set"` - If the OAuth client ID env var is missing.
 * @throws {Error} `"Failed to start callback server"` - If Bun's HTTP server fails to bind a port.
 * @throws {Error} `"Missing code or state"` - If the callback URL is missing required parameters.
 * @throws {Error} `"State mismatch"` - If the returned state nonce does not match the original.
 * @throws {Error} `"Failed to exchange authorization code"` - If the token exchange request fails.
 * @throws {Error} `"Login timed out"` - If the user does not complete login within {@link LOGIN_TIMEOUT_MS}.
 *
 * @example
 * try {
 *   const { token } = await performLogin();
 *   console.log("Logged in successfully. Token:", token);
 * } catch (err) {
 *   console.error("Login failed:", err.message);
 * }
 */
export async function performLogin(): Promise<{ token: string }> {
  const clerkFrontendApi = process.env.CLERK_FRONTEND_API;
  const clientId = process.env.CLERK_OAUTH_CLIENT_ID;
  const apiUrl = process.env.API_URL ?? "http://localhost:3000";

  if (!clerkFrontendApi) throw new Error("CLERK_FRONTEND_API not set");
  if (!clientId) throw new Error("CLERK_OAUTH_CLIENT_ID not set");

  // Generate a one-time random value to bind the authorization request to
  // the callback, preventing CSRF/replay attacks on the state parameter.
  const nonce = crypto.randomUUID();

  // Generate a high-entropy random code verifier for PKCE (RFC 7636).
  const codeVerifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

  // Derive the corresponding code challenge to send in the authorization URL.
  const codeChallenge = await createPkceChallenge(codeVerifier);

  /**
   * Tracks whether the login promise has already settled (resolved or rejected)
   * to ensure the timeout handler does not double-reject after a successful
   * or failed exchange.
   */
  let settled = false;

  return new Promise<{ token: string }>((resolve, reject) => {
    /**
     * Temporary local HTTP server that listens for the OAuth authorization
     * callback. Bun assigns a random available port (port: 0), which is
     * embedded in the `state` parameter so the proxy can route correctly.
     */
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);

        // Only handle requests to the /callback route; reject all others.
        if (url.pathname !== "/callback") {
          return new Response("Not found", { status: 404 });
        }

        // Handle explicit OAuth errors returned by the authorization server
        // (e.g., user denied access, or a misconfigured client).
        const error = url.searchParams.get("error");

        if (error) {
          const msg = url.searchParams.get("error_description") ?? error;
          settled = true;
          reject(new Error(msg));
          setTimeout(() => server.stop(), 500);
          return new Response(`Authentication failed: ${msg}`, { status: 400 });
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        // Both `code` and `state` are required for a valid callback.
        if (!code || !state) {
          settled = true;
          reject(new Error("Missing code or state"));
          setTimeout(() => server.stop(), 500);
          return new Response("Bad request", { status: 400 });
        }

        // Verify nonce from state to ensure the callback corresponds to
        // the authorization request initiated by this session.
        try {
          const payload = decodeState(state);

          if (payload.nonce !== nonce) throw new Error("State mismatch");
        } catch (err) {
          settled = true;
          reject(err);
          setTimeout(() => server.stop(), 500);
          return new Response("Invalid state", { status: 400 });
        }

        try {
          // Exchange authorization code for Clerk tokens using the PKCE
          // verifier to prove this request originated from the same client
          // that initiated the authorization flow.
          const redirectUri = `${apiUrl}/auth/callback`;

          const tokenRes = await fetch(`${clerkFrontendApi}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectUri,
              client_id: clientId,
              code_verifier: codeVerifier,
            }),
          });

          if (!tokenRes.ok) {
            const details = await tokenRes.text();
            throw new Error(details || "Failed to exchange authorization code");
          }

          const tokenData = (await tokenRes.json()) as { access_token: string };

          // Persist the token locally and resolve the login promise.
          settled = true;
          saveAuth({ token: tokenData.access_token });
          resolve({ token: tokenData.access_token });
          setTimeout(() => server.stop(), 500);
          return new Response("Authenticated! You can close this tab.");
        } catch (err) {
          settled = true;
          reject(err);
          const message = getErrorMessage(err);
          setTimeout(() => server.stop(), 500);
          return new Response(`Authentication failed: ${message}`, {
            status: 400,
          });
        }
      },
    });

    // Retrieve the port assigned by the OS so it can be embedded in the
    // OAuth state parameter for the API proxy to route the callback correctly.
    const port = server.port;
    if (typeof port !== "number") {
      server.stop();
      reject(new Error("Failed to start callback server"));
      return;
    }

    const state = encodeState({ port, nonce });

    // The redirect URI must point to the API server, which is expected to
    // proxy the OAuth callback back to the local server on the embedded port.
    const redirectUri = `${apiUrl}/auth/callback`;

    // Construct the full Clerk authorization URL with all required OAuth 2.0
    // and PKCE parameters.
    const authorizeUrl = new URL(`${clerkFrontendApi}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", "openid email profile");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("prompt", "login"); // Force re-authentication
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256"); // SHA-256 PKCE method

    // Open the constructed URL in the user's default web browser to begin
    // the interactive login flow.
    void open(authorizeUrl.toString());

    // Enforce a maximum wait time for the login to complete. If the promise
    // has not yet settled when the timer fires, reject it and clean up the server.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        server.stop();
        reject(new Error("Login timed out"));
      }
    }, LOGIN_TIMEOUT_MS);
  });
}
