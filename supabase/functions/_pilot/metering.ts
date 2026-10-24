// _pilot/metering.ts — exactly one usage_events row per authenticated call.
//
// THE RULE (documented per the brief):
//   * Written in a `finally` block of the request pipeline: it happens for
//     successes AND errors, including 429 rate-limited responses (a rejected
//     call still consumed a slot in the window and must be visible in
//     usage).
//   * 401s are EXCLUDED: no valid key → no (tenant_id, key_id) to satisfy the
//     composite FK — an unknown key has no tenant to bill (and the FK would
//     reject the insert anyway).
//   * A metering failure NEVER fails the request: it is logged as a warning
//     and the response still goes out (the pipeline is metering-last).
//   * units = 1 per call for every endpoint (the pilot meters calls, not
//     result rows; combos could meter n_combos later — not asked for now).

import { logWarn } from "./logger.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export interface UsageRecord {
  tenantId: string;
  keyId: string;
  endpoint: string;
  statusCode: number;
  requestId: string;
}

export async function recordUsage(
  db: SupabaseClient,
  rec: UsageRecord,
): Promise<void> {
  try {
    const { error } = await db.from("usage_events").insert({
      tenant_id: rec.tenantId,
      key_id: rec.keyId,
      endpoint: rec.endpoint,
      units: 1,
      status_code: rec.statusCode,
      request_id: rec.requestId,
    });
    if (error) {
      logWarn("metering: insert failed", { request_id: rec.requestId, pg_code: error.code ?? null });
    }
  } catch (e) {
    logWarn("metering: insert threw", { request_id: rec.requestId, err: e instanceof Error ? e.name : "unknown" });
  }
}
