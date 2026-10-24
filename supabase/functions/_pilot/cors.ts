// _pilot/cors.ts — explicit origin allowlist. NEVER "*".
//
// Policy:
//   * ALLOWED_ORIGINS is a comma-separated list of exact origins
//     (e.g. "https://app.example.com,https://admin.example.com").
//   * A request with NO Origin header is a server-to-server call (curl,
//     another service, the smoke script). It is allowed through untouched —
//     CORS is a browser mechanism and simply does not apply.
//   * A request WITH an Origin not on the list gets NO
//     Access-Control-Allow-Origin header at all (the browser then blocks the
//     response). We never echo a disallowed origin back.
//   * OPTIONS (preflight) is answered 204 from the allowlist.

import type { PilotEnv } from "./types.ts";

export function allowedOrigins(env: PilotEnv): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "*"); // "*" is refused even if configured
}

/** Headers to attach to a response, or null when the origin is not allowed
 * (or the request has no Origin = server-to-server). */
export function corsHeadersFor(env: PilotEnv, origin: string | null): Record<string, string> | null {
  if (!origin) return null;
  if (!allowedOrigins(env).includes(origin)) return null; // never echoed
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id",
    "Access-Control-Expose-Headers": "X-Request-Id, Server-Timing, Retry-After",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
