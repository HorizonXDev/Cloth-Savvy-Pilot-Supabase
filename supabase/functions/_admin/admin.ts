// _admin/admin.ts — shared core for the admin_* dashboard functions.
//
// Threat model (single owner, decision D5 in PLAN_BACKEND_AND_DASHBOARD.md):
// every admin route is guarded by ONE shared secret, ADMIN_TOKEN, sent as
// `Authorization: Bearer <token>` by the dashboard. The comparison is
// constant-time (both sides hashed, XOR over fixed-length digests). The
// routes run with the service-role client, so the token is the ONLY thing
// between the world and tenant/key administration — fail closed everywhere:
// missing ADMIN_TOKEN secret => every admin request refused (500), never an
// open door.
//
// These routes do NOT meter or rate-limit (auth:false in each function):
// admin calls are human-driven, must never appear in usage_events, and are
// not subject to a tenant's per-key limits.
//
// CORS: admin routes pass their own allowlist (ADMIN_ALLOWED_ORIGINS,
// falling back to ALLOWED_ORIGINS) into handle() via RouteOptions.corsOrigins
// so the dashboard origin can be kept out of the PUBLIC API's allowlist.

import { allowedOrigins } from "../_pilot/cors.ts";
import { PilotError } from "../_pilot/errors.ts";
import { mapDbError } from "../_pilot/pgerror.ts";
import { parseTenantSettings } from "../_pilot/settings.ts";
import type { PilotEnv, TenantSettings } from "../_pilot/types.ts";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Canonical model id the encoder reports (CLIP-server: fashion-clip @ 7e3ba62).
 * Tenants created from the dashboard default to it; products must match. */
export const DEFAULT_EMBEDDING_MODEL = "fashion-clip@7e3ba62";
export const EMBEDDING_DIM = 512;

/** Origin allowlist for admin routes: ADMIN_ALLOWED_ORIGINS if set (comma
 * list, "*" refused), else undefined so handle() uses ALLOWED_ORIGINS. */
export function adminOrigins(env: PilotEnv): readonly string[] | undefined {
  const raw = env.ADMIN_ALLOWED_ORIGINS;
  if (raw === undefined) return undefined;
  const list = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0 && s !== "*");
  return list.length > 0 ? list : allowedOrigins(env);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string equality: both sides become SHA-256 digests (fixed
 * 32 bytes regardless of input length), then every byte is XOR-compared with
 * no early exit. */
async function ctEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da.charCodeAt(i) ^ db.charCodeAt(i);
  return diff === 0;
}

/** Throws unless the request carries the exact admin bearer token. */
export async function verifyAdmin(req: Request, env: PilotEnv): Promise<void> {
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    // Fail closed with an operator-actionable message (config state only).
    throw new PilotError("internal", "admin API is disabled — set the ADMIN_TOKEN secret");
  }
  const header = req.headers.get("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(\S+)$/);
  if (!m) throw new PilotError("unauthorized", "missing admin bearer token");
  if (!(await ctEqual(m[1], expected))) {
    throw new PilotError("unauthorized", "invalid admin token");
  }
}

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new PilotError("invalid_request", `field '${field}' must be a UUID`);
  }
  return value;
}

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  website_url: string | null;
  status: string;
  embedding_model: string;
  embedding_dim: number;
  settings: unknown;
  created_at: string;
}

/** Fetch a tenant by id or fail with a clean 400 (admin tooling has no 404s
 * in its vocabulary — the caller sent the id). */
export async function getTenant(
  db: { from: (t: string) => any }, // deno-lint-ignore no-explicit-any — supabase builder
  tenantId: string,
  requestId: string,
): Promise<TenantRow> {
  const { data, error } = await db
    .from("tenants")
    .select("id,slug,name,website_url,status,embedding_model,embedding_dim,settings,created_at")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw mapDbError(error, requestId, "tenants.select");
  if (!data) throw new PilotError("invalid_request", "no tenant with that id");
  return data as TenantRow;
}

/** Strict settings validation for WRITES: parse+normalize, but any issue the
 * reader would silently tolerate is a 400 here — the admin editor must be
 * told its edit was wrong instead of quietly storing fallbacks.
 * Null-valued keys are treated as ABSENT: the normalized output itself
 * contains `currency: null`, and that output must round-trip through this
 * validator on every subsequent PATCH (merge-over-current). */
export function validatedSettings(input: unknown): TenantSettings {
  let candidate = input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    candidate = Object.fromEntries(
      Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== null),
    );
  }
  const { settings, issues } = parseTenantSettings(candidate);
  if (issues.length > 0) {
    throw new PilotError("invalid_request", `settings rejected: ${issues.join("; ")}`);
  }
  return settings;
}

// Key generation lives in _pilot/keystore.ts — admin and tenant routes
// both mint keys, and neither credential family imports the other's module.
// Re-exported here so admin_keys' existing imports keep working unchanged.
export { newApiSecretKey, withHash, sha256HexOf } from "../_pilot/keystore.ts";
export type { NewKey } from "../_pilot/keystore.ts";
