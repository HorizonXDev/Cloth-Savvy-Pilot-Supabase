// _pilot/idempotency.ts — replay protection for expensive routes.
//
// Contract (see migrations/0013_idempotency.sql):
//   * `Idempotency-Key` is OPTIONAL. A request without it behaves exactly as
//     before — old clients are never broken.
//   * With a key, the first request reserves a row BEFORE doing the expensive
//     work and stores the response when it finishes. A retry with the same key
//     and same body returns the stored response instead of running again.
//   * Same key + different body is a 400 (never a silently wrong image).
//   * A concurrent duplicate gets 429 + Retry-After while the first is still
//     running. A reservation older than 10 minutes is treated as crashed and
//     taken over.
//   * If the work fails, the reservation is deleted, so a retry can run.
//
// Scope is (tenant, endpoint, key). The tenant comes from the API key, never
// from the request body — one tenant can never read another's key.

import { PilotError } from "./errors.ts";
import { logWarn } from "./logger.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/** Printable, log-safe, long enough to be unique. */
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const STALE_MS = 10 * 60 * 1000;
const UNIQUE_VIOLATION = "23505";

export type BeginResult =
  | { kind: "reserved"; key: string | null }
  | { kind: "replay"; key: string; response: unknown };

export interface IdempotencyRow {
  request_hash: string;
  status: "in_progress" | "done";
  response: unknown;
  created_at: string;
}

/** What to do when the key already exists. Pure — unit-tested without a DB. */
export type ExistingDecision =
  | { action: "replay"; response: unknown }
  | { action: "mismatch" }
  | { action: "take_over" }
  | { action: "in_flight" };

export function decideExisting(
  row: IdempotencyRow,
  hash: string,
  now: number,
): ExistingDecision {
  // Hash first: a different body must never receive the stored response,
  // whether the first request finished or is still running.
  if (row.request_hash !== hash) return { action: "mismatch" };
  if (row.status === "done") return { action: "replay", response: row.response };

  const age = now - new Date(row.created_at).getTime();
  if (Number.isFinite(age) && age > STALE_MS) return { action: "take_over" };
  return { action: "in_flight" };
}

/** Read and validate the header. Absent -> null (feature unused). */
export function readIdempotencyKey(req: Request): string | null {
  const raw = req.headers.get(IDEMPOTENCY_HEADER);
  if (raw === null) return null;
  const key = raw.trim();
  if (!KEY_RE.test(key)) {
    throw new PilotError(
      "invalid_request",
      `header '${IDEMPOTENCY_HEADER}' must be 8..128 characters of A-Z a-z 0-9 . _ : -`,
    );
  }
  return key;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable-ish fingerprint of the request body. Key order is whatever the
 * client serialised; identical retries from the same client match. */
export async function requestHash(body: unknown): Promise<string> {
  return await sha256Hex(JSON.stringify(body));
}

async function getRow(
  db: SupabaseClient,
  tenantId: string,
  endpoint: string,
  key: string,
): Promise<IdempotencyRow | null> {
  const { data, error } = await db
    .from("idempotency_keys")
    .select("request_hash,status,response,created_at")
    .eq("tenant_id", tenantId)
    .eq("endpoint", endpoint)
    .eq("key", key)
    .limit(1);
  if (error) {
    logWarn("idempotency: lookup failed", { pg_code: error.code ?? null });
    throw new PilotError("internal", "idempotency backend unavailable");
  }
  return ((data as unknown as IdempotencyRow[] | null) ?? [])[0] ?? null;
}

async function removeRow(
  db: SupabaseClient,
  tenantId: string,
  endpoint: string,
  key: string,
  onlyInProgress: boolean,
): Promise<void> {
  let q = db
    .from("idempotency_keys")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("endpoint", endpoint)
    .eq("key", key);
  if (onlyInProgress) q = q.eq("status", "in_progress");
  const { error } = await q;
  if (error) {
    logWarn("idempotency: delete failed", { pg_code: error.code ?? null });
  }
}

/**
 * Reserve the key (or return the stored response for a replay).
 * Throws PilotError when the key was reused for a different request, while a
 * duplicate is still in flight, or when the backend cannot be read.
 */
export async function beginIdempotent(
  db: SupabaseClient,
  tenantId: string,
  endpoint: string,
  key: string | null,
  hash: string,
  attempt = 1,
): Promise<BeginResult> {
  if (key === null) return { kind: "reserved", key: null };

  const { error } = await db.from("idempotency_keys").insert({
    tenant_id: tenantId,
    endpoint,
    key,
    request_hash: hash,
  });

  if (!error) return { kind: "reserved", key };

  if (error.code !== UNIQUE_VIOLATION) {
    logWarn("idempotency: insert failed", { pg_code: error.code ?? null });
    throw new PilotError("internal", "idempotency backend unavailable");
  }

  const row = await getRow(db, tenantId, endpoint, key);
  if (!row) {
    // The other side removed the row between our insert and read: retry once.
    if (attempt < 2) return await beginIdempotent(db, tenantId, endpoint, key, hash, attempt + 1);
    throw new PilotError("internal", "idempotency backend unavailable");
  }

  const decision = decideExisting(row, hash, Date.now());

  if (decision.action === "mismatch") {
    throw new PilotError(
      "invalid_request",
      `header '${IDEMPOTENCY_HEADER}' was already used for a different request`,
    );
  }

  if (decision.action === "replay") {
    return { kind: "replay", key, response: decision.response };
  }

  // Take over only if the reservation is clearly abandoned — the platform
  // kills a function after 150 s, so 10 minutes means a crash, not "slow".
  if (decision.action === "take_over") {
    await removeRow(db, tenantId, endpoint, key, true);
    if (attempt < 2) return await beginIdempotent(db, tenantId, endpoint, key, hash, attempt + 1);
  }

  throw new PilotError(
    "rate_limited",
    `a request with this '${IDEMPOTENCY_HEADER}' is still running — retry shortly`,
    { "Retry-After": "10" },
  );
}

/** Store the finished response. Best-effort: the work is already done. */
export async function completeIdempotent(
  db: SupabaseClient,
  tenantId: string,
  endpoint: string,
  key: string | null,
  response: unknown,
): Promise<void> {
  if (key === null) return;
  const { error } = await db
    .from("idempotency_keys")
    .update({ status: "done", response })
    .eq("tenant_id", tenantId)
    .eq("endpoint", endpoint)
    .eq("key", key);
  if (error) {
    logWarn("idempotency: store response failed", { pg_code: error.code ?? null });
  }
}

/** Drop the reservation after a failure so the client can retry. */
export async function releaseIdempotent(
  db: SupabaseClient,
  tenantId: string,
  endpoint: string,
  key: string | null,
): Promise<void> {
  if (key === null) return;
  await removeRow(db, tenantId, endpoint, key, true);
}
