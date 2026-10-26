// _tenant/tenant.ts — portal session guard for every tenant_* function.
//
// SEPARATION MODEL (the whole point of the two-dashboard design):
//
//   ┌───────────────────────┐        ┌───────────────────────┐
//   │ admin-dashboard        │        │ tenant-portal          │
//   │ credential:            │        │ credential:            │
//   │   ADMIN_TOKEN          │        │   Supabase Auth        │
//   │   (shared secret,      │        │   user session         │
//   │    owner-held)         │        │   (email + password)   │
//   └──────────┬────────────┘        └──────────┬────────────┘
//              │ verifyAdmin()                   │ resolvePortalSession()
//              ▼                                 ▼
//        admin_* functions                 tenant_* functions
//        (service-role admin ops)          (ONLY this session's tenant)
//
// The two credential families are structurally disjoint:
//   * admin_* routes call verifyAdmin() which demands the ADMIN_TOKEN
//     bearer — a Supabase user JWT does not match it (401), so a portal
//     session can never perform an admin operation.
//   * tenant_* routes call resolvePortalSession() which demands a valid
//     Supabase Auth USER JWT — ADMIN_TOKEN is not a JWT (401), so the
//     admin secret is useless here, and there is no admin code path in
//     any tenant_* function at all: no tenant create/suspend, no cross-
//     tenant read, no key revoke for anyone but this session's tenant.
//
// HOW A SESSION RESOLVES (fail closed at every step):
//   1. Authorization: Bearer <user jwt> — missing → 401.
//   2. Verify the JWT against GoTrue (auth.getUser) — invalid/expired → 401.
//   3. Look up tenant_users by user_id — no row, or revoked_at set → 403.
//      (revocation and "never had access" are both 403: membership is not
//       secret, and one honest code keeps the portal's error handling simple.)
//   4. Fetch the tenant — suspended → 403; missing (raced drop) → 403.
//
// THE TENANT ID NEVER COMES FROM THE REQUEST. Not the body, not the query,
// not a header — the sole source is the tenant_users row keyed by the
// verified user id. A crafted request from tenant A cannot name tenant B:
// the field is never read (same rule as T15 on the API layer).
//
// Metering: tenant_* routes are NOT metered (auth:false at the route, and
// this resolver runs inside the handler) — portal browsing must never
// appear in usage_events or consume a tenant's API quota. This mirrors
// verifyAdmin() on the admin side.

import { allowedOrigins } from "../_pilot/cors.ts";
import { PilotError } from "../_pilot/errors.ts";
import { logWarn } from "../_pilot/logger.ts";
import { parseTenantSettings } from "../_pilot/settings.ts";
import type { PilotEnv, TenantSettings } from "../_pilot/types.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** What a verified portal session knows. tenantId comes from the
 * tenant_users membership row ONLY — see header. */
export interface PortalSession {
  userId: string; // auth.users.id
  email: string; // membership row's copy (display)
  tenantId: string; // THE one tenant this session may address
  tenantSlug: string;
  tenantName: string;
  tenantModel: string; // tenants.embedding_model
  settings: TenantSettings; // validated tenants.settings
}

/** Origin allowlist for tenant_* routes: TENANT_ALLOWED_ORIGINS if set
 * (comma list, "*" refused), else ALLOWED_ORIGINS — same policy as
 * adminOrigins(), so the three surfaces can be kept disjoint on purpose. */
export function tenantOrigins(env: PilotEnv): readonly string[] | undefined {
  const raw = env.TENANT_ALLOWED_ORIGINS;
  if (raw === undefined) return undefined;
  const list = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0 && s !== "*");
  return list.length > 0 ? list : allowedOrigins(env);
}

interface MembershipRow {
  tenant_id: string;
  email: string;
  revoked_at: string | null;
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  embedding_model: string;
  settings: unknown;
}

/** Resolve the portal session or throw a PilotError (401/403). */
export async function resolvePortalSession(
  req: Request,
  db: SupabaseClient,
  requestId: string,
): Promise<PortalSession> {
  const header = (req.headers.get("Authorization") ?? "").trim();
  const m = /^Bearer[ \t]+(.+)$/i.exec(header);
  if (!m) {
    throw new PilotError("unauthorized", "missing 'Authorization: Bearer <session token>' header");
  }
  const jwt = m[1].trim();

  // Step 2: real verification against GoTrue — never decode locally.
  const { data: userData, error: userErr } = await db.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    throw new PilotError("unauthorized", "invalid or expired session token");
  }
  const user = userData.user;

  // Step 3: membership — the ONLY place tenantId comes from.
  const { data: rows, error: memErr } = await db
    .from("tenant_users")
    .select("tenant_id, email, revoked_at")
    .eq("user_id", user.id)
    .limit(1);
  if (memErr) {
    logWarn("portal: tenant_users lookup failed", {
      request_id: requestId,
      pg_code: memErr.code ?? null,
    });
    throw new PilotError("internal", "portal backend unavailable");
  }
  const membership = (rows as unknown as MembershipRow[] | null)?.[0];
  if (!membership) {
    // Valid login, no tenant: this account has no portal access.
    throw new PilotError("forbidden", "this account has no tenant portal access");
  }
  if (membership.revoked_at !== null) {
    throw new PilotError("forbidden", "portal access for this account has been revoked");
  }

  // Step 4: tenant state.
  const { data: tenants, error: tErr } = await db
    .from("tenants")
    .select("id, slug, name, status, embedding_model, settings")
    .eq("id", membership.tenant_id)
    .limit(1);
  if (tErr) {
    logWarn("portal: tenants lookup failed", {
      request_id: requestId,
      pg_code: tErr.code ?? null,
    });
    throw new PilotError("internal", "portal backend unavailable");
  }
  const tenant = (tenants as unknown as TenantRow[] | null)?.[0];
  if (!tenant) {
    // Membership pointed at a dropped tenant (raced drop_tenant) — cut off.
    throw new PilotError("forbidden", "this account has no tenant portal access");
  }
  if (tenant.status !== "active") {
    throw new PilotError("forbidden", "this tenant is suspended — contact support");
  }

  const { settings, issues } = parseTenantSettings(tenant.settings);
  for (const issue of issues) {
    logWarn("settings: invalid value", {
      request_id: requestId,
      tenant_id: tenant.id,
      issue,
    });
  }

  return {
    userId: user.id,
    email: membership.email,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
    tenantModel: tenant.embedding_model,
    settings,
  };
}
