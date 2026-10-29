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

// ------------------------------------------------------------- per-route (P0-3)
// `/vton` is the only route that bills GPU seconds, so it gets two additional
// checks on top of the global per-key window:
//
//   * a much tighter per-key window   (settings.vton_rate_limit_per_min, 3/min)
//   * a per-tenant monthly ceiling    (settings.vton_monthly_cap, 100/month,
//                                      0 = disabled)
//
// DIFFERENCES FROM THE GLOBAL LIMITER, on purpose:
//   * FAIL CLOSED. If the count query errors we refuse the call
//     (`quota_unavailable`, 503) instead of guessing. A GPU job that cannot be
//     attributed to a quota is exactly the spend we are trying to bound.
//   * The monthly count spans ALL keys of the tenant, so issuing a second key
//     does not buy a second month.
//   * Rows that were themselves refused by a quota check (429/402) are
//     excluded from both counts. Metering records every authenticated call —
//     a client hammering its limit would otherwise burn its own monthly cap.
//   * Counting rows is racy: concurrent calls can all read "under cap". The
//     overshoot is bounded by the per-minute window (≤ a few in-flight calls
//     per key), which is why this stays a cheap COUNT and not an atomic
//     reservation like the consumer credit RPC (P0-1).

const BLOCKED_STATUSES = [429, 402];
const BLOCKED_FILTER = `(${BLOCKED_STATUSES.join(",")})`;

/** Only the GPU route has extra limits today; add rows here when /combos
 *  starts costing money. */
const ENDPOINTS_WITH_QUOTA = new Set(["vton"]);

export async function enforceEndpointLimits(
  db: SupabaseClient,
  auth: AuthContext,
  requestId: string,
  endpoint: string,
): Promise<void> {
  if (!ENDPOINTS_WITH_QUOTA.has(endpoint)) return;
  await enforceVtonLimits(db, auth, requestId);
}

async function enforceVtonLimits(
  db: SupabaseClient,
  auth: AuthContext,
  requestId: string,
): Promise<void> {
  const { vton_rate_limit_per_min: perMinute, vton_monthly_cap: monthlyCap } = auth.settings;

  // 1) tight per-key window (same rolling 60 s definition as the global one)
  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();
  const inWindow = await countVtonEvents(db, auth.tenantId, auth.keyId, windowStart, requestId, "window");
  if (inWindow >= perMinute) {
    throw new PilotError(
      "rate_limited",
      `try-on rate limit exceeded: ${perMinute} calls per minute for this API key`,
      { "Retry-After": "60" },
    );
  }

  // 2) tenant-wide monthly ceiling (0 = off)
  if (monthlyCap <= 0) return;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const thisMonth = await countVtonEvents(
    db,
    auth.tenantId,
    null, // every key of the tenant counts against the same ceiling
    monthStart.toISOString(),
    requestId,
    "month",
  );
  if (thisMonth >= monthlyCap) {
    const nextMonth = new Date(monthStart);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    throw new PilotError(
      "quota_exceeded",
      `monthly try-on cap reached: ${monthlyCap} calls per UTC month for this tenant ` +
        `(resets ${nextMonth.toISOString().slice(0, 10)})`,
    );
  }
}

async function countVtonEvents(
  db: SupabaseClient,
  tenantId: string,
  keyId: string | null,
  since: string,
  requestId: string,
  phase: "window" | "month",
): Promise<number> {
  let query = db
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("endpoint", "vton")
    .gt("created_at", since)
    .not("status_code", "in", BLOCKED_FILTER);
  if (keyId) query = query.eq("key_id", keyId);

  const { count, error } = await query;
  if (error) {
    // FAIL CLOSED — see the block comment above.
    logWarn("quota: vton usage count failed — refusing the call", {
      request_id: requestId,
      tenant_id: tenantId,
      phase,
      pg_code: error.code ?? null,
    });
    throw new PilotError(
      "quota_unavailable",
      "try-on quota could not be verified right now — request refused, retry shortly",
      { "Retry-After": "30" },
    );
  }
  return count ?? 0;
}
