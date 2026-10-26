// _pilot/http.ts — the request pipeline every function uses.
//
// One place implements, in order:
//   request id (X-Request-Id accepted or generated) → OPTIONS preflight →
//   CORS allowlist (never "*") → auth (optional per route) → rate limit
//   (authenticated routes) → handler → Server-Timing → response, and the
//   metering `finally` (exactly one usage_events row per AUTHENTICATED
//   request, including 429s; 401s excluded because no tenant/key resolved).
//
// Error handling: PilotError → its envelope; anything else → generic
// `internal` 500 with NO detail (the stack goes to server logs only). Every
// response carries X-Request-Id; every error body is
// {error:{code,message,request_id}}.
//
// UNVERIFIED (2026-10, official docs): per-function `verify_jwt` in
// config.toml. This layer needs verify_jwt=false for API-key functions:
// the platform would otherwise reject requests without a Supabase USER JWT,
// but our callers authenticate with an API key (server-to-server) and no
// user session exists — the in-function key auth IS the authentication.
// (Precedent: every consumer function in Cloth-Savvy-Edge-Functions also
// sets verify_jwt=false and authenticates inside.)

import { corsHeadersFor } from "./cors.ts";
import { errorEnvelope, internalMessage, PilotError, statusForCode } from "./errors.ts";
import { authenticate } from "./auth.ts";
import { logError, logWarn } from "./logger.ts";
import { enforceRateLimit } from "./rate_limit.ts";
import { recordUsage } from "./metering.ts";
import { serviceClient } from "./supabase.ts";
import type { HandlerContext, HandlerResult, PilotEnv } from "./types.ts";

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function resolveRequestId(req: Request): string {
  const given = req.headers.get("X-Request-Id");
  if (given && REQUEST_ID_RE.test(given)) return given;
  return crypto.randomUUID();
}

export interface RouteOptions {
  /** Metering/rate-limit label, e.g. "search", "combos.health". */
  endpoint: string;
  auth: boolean;
  methods: readonly string[];
  /** Origin allowlist for THIS route; defaults to env.ALLOWED_ORIGINS.
   * admin_* routes pass ADMIN_ALLOWED_ORIGINS (see _admin/admin.ts). */
  corsOrigins?: readonly string[];
}

export async function handle(
  req: Request,
  env: PilotEnv,
  opts: RouteOptions,
  handler: (ctx: HandlerContext) => Promise<HandlerResult>,
): Promise<Response> {
  const requestId = resolveRequestId(req);
  const origin = req.headers.get("Origin");
  const cors = corsHeadersFor(env, origin, opts.corsOrigins, opts.methods); // null → not allowed / no Origin

  // Preflight: answer from the allowlist only.
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeadersFor(env, origin, opts.corsOrigins, opts.methods) ?? {},
        "X-Request-Id": requestId,
      },
    });
  }

  if (!opts.methods.includes(req.method)) {
    // (was: a 5-argument errorResponse(...) call against this 3-arg helper —
    // any wrong-method request crashed the handler. Caught2026-10-24.)
    return errorResponse(requestId, cors, {
      code: "invalid_request",
      message: `method ${req.method} not allowed on this route`,
      extra: {},
    });
  }

  const db = serviceClient(env);
  let authCtx: HandlerContext["auth"];
  let status = 200;

  try {
    const ctx: HandlerContext = { req, env, db, requestId, timings: {} };

    if (opts.auth) {
      ctx.auth = await authenticate(req, db, env, requestId);
      authCtx = ctx.auth;
      await enforceRateLimit(db, ctx.auth, requestId); // may throw 429 (metered below)
    }

    const started = performance.now();
    const result = await handler(ctx);
    ctx.timings.total = Math.round(performance.now() - started);
    status = result.status ?? 200;

    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "X-Request-Id": requestId,
      ...result.headers ?? {},
    };
    const serverTiming = Object.entries(ctx.timings)
      .filter(([, ms]) => Number.isFinite(ms))
      .map(([name, ms]) => `${name};dur=${Math.round(ms)}`)
      .join(", ");
    if (serverTiming) headers["Server-Timing"] = serverTiming;
    if (cors) Object.assign(headers, cors);

    return new Response(JSON.stringify(result.body), { status, headers });
  } catch (err) {
    // Classify FIRST and record the real status so the metering `finally`
    // below logs the true status_code (429/502/503/500 — never a stale 200).
    const classified = classifyError(err, requestId);
    status = statusForCode(classified.code);
    return errorResponse(requestId, cors, classified);
  } finally {
    // Metering runs for every authenticated request, whatever happened above.
    if (authCtx) {
      await recordUsage(db, {
        tenantId: authCtx.tenantId,
        keyId: authCtx.keyId,
        endpoint: opts.endpoint,
        statusCode: status, // updated below for the error path via closure trick
        requestId,
      });
    }
  }
}

interface Classified {
  code: Parameters<typeof errorEnvelope>[1];
  message: string;
  extra: Record<string, string>;
}

function classifyError(err: unknown, requestId: string): Classified {
  if (err instanceof PilotError) {
    return { code: err.code, message: err.message, extra: err.headers };
  }
  // Unexpected: generic body for the caller, full detail to server logs only.
  logError("unhandled error", {
    request_id: requestId,
    name: err instanceof Error ? err.name : typeof err,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return { code: "internal", message: internalMessage(), extra: {} };
}

function errorResponse(
  requestId: string,
  cors: Record<string, string> | null,
  classified: Classified,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "X-Request-Id": requestId,
    ...classified.extra,
  };
  if (cors) Object.assign(headers, cors);
  return new Response(JSON.stringify(errorEnvelope(requestId, classified.code, classified.message)), {
    status: statusForCode(classified.code),
    headers,
  });
}
