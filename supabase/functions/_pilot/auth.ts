// _pilot/auth.ts — API-key authentication middleware (decision A1).
//
// Flow: Authorization: Bearer sk_live_…|sk_test_… → format check (pure) →
// SHA-256 (WebCrypto) → api_keys lookup by key_hash → revoked/unknown → 401;
// tenant suspended → 403 → resolve_api_key RPC (also stamps last_used_at) →
// fetch tenant row (embedding_model + settings) → AuthContext.
//
// Rules enforced here:
//   * tenant comes ONLY from the key. body/query/header tenant_id, tenant,
//     slug etc. are never read by this layer (T15).
//   * 401 missing/unknown/revoked/malformed key; 403 valid key of a suspended
//     tenant (two-step lookup is what makes 401 vs 403 honest — resolve_api_key
//     alone returns zero rows for both revoked and suspended, which would
//     collapse 403 into 401).
//   * The key material is never logged, never put in an error message, and
//     never sent anywhere except hashed. Timing: the format gate rejects
//     malformed keys before any hashing; the equality that matters happens
//     inside a Postgres index lookup on sha256 — there is no byte-by-byte
//     secret comparison in JS to leak timing.
//   * A 403 means "your key is real but your tenant is suspended" — that is
//     not secret leakage: it only follows from knowing a valid key.

import { PilotError } from "./errors.ts";
import { parseApiKey, type KeyPrefix } from "./key_format.ts";
import { logWarn } from "./logger.ts";
import { parseTenantSettings } from "./settings.ts";
import { serviceClient } from "./supabase.ts";
import type { AuthContext, PilotEnv } from "./types.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

async function sha256Hex(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface KeyRow {
  id: string;
  tenant_id: string;
  environment: "live" | "sandbox";
  revoked_at: string | null;
}

export async function authenticate(
  req: Request,
  db: SupabaseClient,
  _env: PilotEnv,
  requestId: string,
): Promise<AuthContext> {
  const header = (req.headers.get("Authorization") ?? "").trim();
  const m = /^Bearer[ \t]+(.+)$/i.exec(header);
  if (!m) {
    throw new PilotError("unauthorized", "missing 'Authorization: Bearer <api key>' header");
  }
  const rawKey = m[1].trim();

  const parsed = parseApiKey(rawKey);
  if (!parsed.ok) {
    // Covers pk_ (reserved, never issued), wrong length, bad charset.
    throw new PilotError("unauthorized", "unknown or malformed API key");
  }
  const prefix: KeyPrefix = parsed.prefix;

  const keyHash = await sha256Hex(rawKey); // plaintext dies with this frame

  // Step 1: does a key row exist at all? (never log keyHash)
  const { data: keyRows, error: keyErr } = await db
    .from("api_keys")
    .select("id, tenant_id, environment, revoked_at")
    .eq("key_hash", keyHash)
    .limit(1);
  if (keyErr) {
    logWarn("auth: api_keys lookup failed", { request_id: requestId, pg_code: keyErr.code ?? null });
    throw new PilotError("internal", "authentication backend unavailable");
  }
  const row = (keyRows as unknown as KeyRow[] | null)?.[0];
  if (!row) throw new PilotError("unauthorized", "unknown or malformed API key");
  if (row.revoked_at !== null) throw new PilotError("unauthorized", "API key has been revoked");

  // Step 2: tenant status → honest 403 vs 401.
  const { data: tenant, error: tenantErr } = await db
    .from("tenants")
    .select("id, status, embedding_model, settings")
    .eq("id", row.tenant_id)
    .limit(1);
  if (tenantErr) {
    logWarn("auth: tenants lookup failed", { request_id: requestId, pg_code: tenantErr.code ?? null });
    throw new PilotError("internal", "authentication backend unavailable");
  }
  const t = (tenant as unknown as Array<{
    id: string; status: string; embedding_model: string; settings: unknown;
  }> | null)?.[0];
  if (!t) throw new PilotError("unauthorized", "unknown or malformed API key"); // raced drop
  if (t.status !== "active") throw new PilotError("forbidden", "tenant is suspended");

  // Step 3: resolve_api_key — the L1 anchor; stamps last_used_at.
  const { data: resolved, error: rpcErr } = await db.rpc("resolve_api_key", {
    p_key_hash: keyHash,
  });
  if (rpcErr) {
    logWarn("auth: resolve_api_key failed", { request_id: requestId, pg_code: rpcErr.code ?? null });
    throw new PilotError("internal", "authentication backend unavailable");
  }
  const resolvedRow = (Array.isArray(resolved) ? resolved[0] : resolved) as
    | { tenant_id: string; key_id: string; environment: string; tenant_status: string }
    | undefined;
  if (!resolvedRow || resolvedRow.tenant_id !== row.tenant_id) {
    throw new PilotError("unauthorized", "unknown or malformed API key");
  }

  const { settings, issues } = parseTenantSettings(t.settings);
  for (const issue of issues) {
    logWarn("settings: invalid value", { request_id: requestId, tenant_id: t.id, issue });
  }

  return {
    tenantId: row.tenant_id,
    keyId: row.id,
    environment: row.environment, // authoritative — NOT inferred from prefix
    keyPrefixSk: prefix,
    tenantModel: t.embedding_model,
    settings,
  };
}
