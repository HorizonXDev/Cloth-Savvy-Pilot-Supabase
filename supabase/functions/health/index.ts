// functions/health — GET /v1/health  (no auth, by design)
//
// Supabase serves functions at /functions/v1/<name>, so this route is
// https://<ref>.supabase.co/functions/v1/health — the "/v1/health" endpoint
// from the brief.
//
// Body: {status: "ok"|"degraded", request_id,
//        dependencies: {database: {status, latency_ms},
//                       encoder:  {status, latency_ms, model?, revision?, detail?}}}
// Always HTTP 200: health is read by humans and probes that prefer body
// semantics; `status` carries ok/degraded per dependency. DB ping = a
// head/count query on tenants; encoder relay = its open GET /health.

import { encoderHealth } from "../_pilot/encoder.ts";
import { handle } from "../_pilot/http.ts";
import { readEnv } from "../_pilot/env.ts";
import { logWarn } from "../_pilot/logger.ts";

Deno.serve((req) =>
  handle(req, readEnv(), { endpoint: "health", auth: false, methods: ["GET"] }, async (ctx) => {
    // --- database ping -----------------------------------------------------
    const t0 = performance.now();
    let dbStatus: "ok" | "degraded" = "ok";
    let dbDetail: string | undefined;
    try {
      const { error, count } = await ctx.db
        .from("tenants")
        .select("id", { count: "exact", head: true });
      if (error) {
        dbStatus = "degraded";
        dbDetail = error.code ?? "query failed";
        logWarn("health: db ping failed", { request_id: ctx.requestId, pg_code: error.code ?? null });
      } else {
        void count; // a successful count proves the Data API answered
      }
    } catch {
      dbStatus = "degraded";
      dbDetail = "unreachable";
    }
    const dbMs = Math.round(performance.now() - t0);

    // --- encoder relay -----------------------------------------------------
    const enc = await encoderHealth(ctx.env);

    const overall = dbStatus === "ok" && enc.status === "ok" ? "ok" : "degraded";
    return {
      body: {
        status: overall,
        request_id: ctx.requestId,
        dependencies: {
          database: {
            status: dbStatus,
            latency_ms: dbMs,
            ...(dbDetail ? { detail: dbDetail } : {}),
          },
          encoder: {
            status: enc.status,
            latency_ms: enc.latency_ms,
            ...(enc.model ? { model: enc.model } : {}),
            ...(enc.revision ? { revision: enc.revision } : {}),
            ...(enc.detail ? { detail: enc.detail } : {}),
          },
        },
      },
    };
  }),
);
