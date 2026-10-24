// _pilot/rate_limit.ts — decision D4: per-key sliding-window limit by
// COUNTING recent usage_events rows. No new table, no counters, no UPDATEs
// (usage_events is append-only by privilege revoke, migrations/0005).
//
// How it works: count rows for (tenant_id, key_id) with created_at in the
// last 60 s; if ≥ limit → 429 with Retry-After: 60. The current call's own
// usage row (written by metering.ts in the pipeline's `finally`) joins the
// count for subsequent requests.
//
// COST AND LIMITS OF THIS APPROACH (stated per D4):
//   * Cost: ONE extra indexed query per authenticated request. The existing
//     index usage_events_tenant_created_idx (tenant_id, created_at) serves
//     the window scan; key_id is filtered from the scanned rows. Cost grows
//     with how many events THIS TENANT logged in the last 60 s — tiny at
//     pilot scale (a 60 req/min tenant scans ≤ a few hundred index entries),
//     but it is not O(1) like a counter table.
//   * Consistency: rows are written in `finally`, so a request still in
//     flight is not yet counted — concurrent bursts can overshoot the limit
//     slightly (each isolate also counts only rows it can see, and they are
//     all visible in Postgres — no per-isolate memory involved).
//   * Window semantics: it is a per-request rolling window (now-60s … now),
//     not an aligned fixed window. Retry-After is always 60 s — the worst
//     case until enough rows age out; a client that keeps hammering keeps
//     re-counting its own 429 rows (429s ARE metered), which is intended
//     back-pressure, not a bug.
//   * Failure mode: if the count query errors we FAIL OPEN (log a warning,
//     allow the request). Rationale: metering/observability first, and a
//     PostgREST hiccup should not turn the whole API into a 5xx. This is a
//     deliberate beyond-brief decision; flip to fail-closed if abuse shows up.

import { PilotError } from "./errors.ts";
import { logWarn } from "./logger.ts";
import type { AuthContext } from "./types.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const WINDOW_MS = 60_000;

export async function enforceRateLimit(
  db: SupabaseClient,
  auth: AuthContext,
  requestId: string,
): Promise<void> {
  const limit = auth.settings.rate_limit_per_min;
  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();

  const { count, error } = await db
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", auth.tenantId)
    .eq("key_id", auth.keyId)
    .gt("created_at", windowStart);

  if (error) {
    // D4 decision: fail open + loud warning (see header comment).
    logWarn("rate_limit: count query failed — allowing request", {
      request_id: requestId,
      tenant_id: auth.tenantId,
      pg_code: error.code ?? null,
    });
    return;
  }

  if ((count ?? 0) >= limit) {
    throw new PilotError(
      "rate_limited",
      `rate limit exceeded: ${limit} requests per minute for this API key`,
      { "Retry-After": "60" },
    );
  }
}
