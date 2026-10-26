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
 * (or the request has no Origin = server-to-server).
 * `allowedOverride` lets a route use its own allowlist (admin_* routes use
 * ADMIN_ALLOWED_ORIGINS); when omitted the env allowlist applies.
 * `methods` advertises the ROUTE's real methods in the preflight (a
 * hardcoded `GET, POST, OPTIONS` made every admin PATCH fail its preflight
 * — caught 2026-10-25 in the browser; found because Python tests never
 * enforce Access-Control-Allow-Methods). */
export function corsHeadersFor(
  env: PilotEnv,
  origin: string | null,
  allowedOverride?: readonly string[],
  methods?: readonly string[],
): Record<string, string> | null {
  if (!origin) return null;
  const allowed = allowedOverride ?? allowedOrigins(env);
  if (!allowed.includes(origin)) return null; // never echoed
  const allowMethods = methods && methods.length > 0
    ? [...new Set(["OPTIONS", ...methods])].join(", ")
    : "GET, POST, OPTIONS";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": allowMethods,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id",
    "Access-Control-Expose-Headers": "X-Request-Id, Server-Timing, Retry-After",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
