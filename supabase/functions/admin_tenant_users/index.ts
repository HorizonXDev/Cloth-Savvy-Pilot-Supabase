// functions/admin_tenant_users — portal-login provisioning (ADMIN side).
//
//   GET    ?tenant_id=<uuid>   list portal logins for that tenant
//   POST   {tenant_id, email, mode?: "invite"|"password"}
//          mode "invite"  (default): GoTrue invite email — the person sets
//                        their own password (needs SMTP working; failure
//                        comes back with the GoTrue reason + a hint to use
//                        mode:"password" when SMTP isn't configured).
//          mode "password": admin-created login with a GENERATED temporary
//                        password returned EXACTLY ONCE (same show-once
//                        contract as API keys — hand it over out-of-band,
//                        the person changes it after first login).
//          Either way a tenant_users membership row is created for THE
//          GIVEN TENANT — that row is the portal's only authorization.
//   PATCH  {tenant_id, user_id, action: "revoke"|"reinstate"|"delete"}
//          revoke    -> revoked_at set; the login keeps existing but every
//                       portal route 403s from the next request.
//          reinstate -> revoked_at cleared.
//          delete    -> the auth user is deleted; the membership row goes
//                       with it (FK ON DELETE CASCADE on auth.users).
//
// WHY BOTH MODES: the decided UX is admin-invited email + password; the
// invite path depends on SMTP being configured on the pilot project
// (launch checklist item), and mode:"password" is the operational fallback
// that always works — and the only mode a headless test can exercise.
//
// Auth: shared ADMIN_TOKEN bearer (verifyAdmin) — this is admin work, so
// it lives ONLY in the admin_* family; no tenant_* route can reach it.
// NOT metered.

import { adminOrigins, getTenant, requireUuid, verifyAdmin } from "../_admin/admin.ts";
import { readEnv } from "../_pilot/env.ts";
import { PilotError } from "../_pilot/errors.ts";
import { handle } from "../_pilot/http.ts";
import { mapDbError } from "../_pilot/pgerror.ts";
import { optString, readJsonObject } from "../_pilot/validation.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MEMBERSHIP_COLUMNS = "id,user_id,email,created_at,created_by,revoked_at";

/** ~18 URL-safe chars from WebCrypto — a temp password, shown once. */
function generateTempPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** GoTrue error text → a message safe (and useful) for the dashboard. */
function goTrueFailure(context: string, err: { message?: string; code?: string | number }): never {
  const raw = (err.message ?? "").slice(0, 200);
  const lower = raw.toLowerCase();
  if (lower.includes("already") || lower.includes("exists")) {
    throw new PilotError("invalid_request", `an account with that email already exists`);
  }
  if (lower.includes("smtp") || lower.includes("email") || lower.includes("invite")) {
    // Invite mail could not be sent — most common when SMTP isn't set up.
    throw new PilotError(
      "invalid_request",
      `${context}: ${raw || "email delivery failed"} — if SMTP isn't configured, ` +
        `retry with mode:"password" and hand the temporary password over yourself`,
    );
  }
  throw new PilotError("internal", `${context} failed (quote the request_id)`);
}

Deno.serve((req) =>
  handle(
    req,
    readEnv(),
    {
      endpoint: "admin.tenant_users",
      auth: false,
      methods: ["GET", "POST", "PATCH"],
      corsOrigins: adminOrigins(readEnv()),
    },
    async (ctx) => {
      await verifyAdmin(ctx.req, ctx.env, ctx.requestId);

      // ---- GET: list portal logins for a tenant --------------------------
      if (ctx.req.method === "GET") {
        const url = new URL(ctx.req.url);
        const tenantId = requireUuid(url.searchParams.get("tenant_id"), "tenant_id");
        await getTenant(ctx.db, tenantId, ctx.requestId);
        const { data, error } = await ctx.db
          .from("tenant_users")
          .select(MEMBERSHIP_COLUMNS)
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
          .limit(500);
        if (error) throw mapDbError(error, ctx.requestId, "tenant_users.list");
        return { body: { request_id: ctx.requestId, users: data ?? [] } };
      }

      // ---- POST: create / invite a portal login --------------------------
      if (ctx.req.method === "POST") {
        const body = await readJsonObject(ctx.req);
        const tenantId = requireUuid(body.tenant_id, "tenant_id");
        const emailRaw = optString(body, "email", { required: true, max: 254 })!.toLowerCase();
        const mode = optString(body, "mode", { values: ["invite", "password"] }) ?? "invite";
        await getTenant(ctx.db, tenantId, ctx.requestId);
        if (!EMAIL_RE.test(emailRaw)) {
          throw new PilotError("invalid_request", "field 'email' is not a valid email address");
        }

        // Already a portal user ANYWHERE? (user_id is UNIQUE across tenants —
        // one login belongs to exactly one tenant, by design.)
        const { data: existing, error: exErr } = await ctx.db
          .from("tenant_users")
          .select("tenant_id, revoked_at")
          .ilike("email", emailRaw)
          .limit(1);
        if (exErr) throw mapDbError(exErr, ctx.requestId, "tenant_users.lookup");
        if ((existing ?? []).length > 0) {
          throw new PilotError(
            "invalid_request",
            "that email already has a portal login (one login = one tenant) — " +
              "reinstate it from its tenant, or use a different email",
          );
        }

        if (mode === "invite") {
          const { data: inv, error: invErr } = await ctx.db.auth.admin.inviteUserByEmail(emailRaw, {
            data: { tenant_id: tenantId, purpose: "cloth-savvy-portal" },
          });
          if (invErr || !inv.user) {
            goTrueFailure("invite failed", invErr ?? {});
          }
          const { error: insErr } = await ctx.db.from("tenant_users").insert({
            tenant_id: tenantId,
            user_id: inv.user.id,
            email: emailRaw,
            created_by: "admin",
          });
          if (insErr) {
            // Membership insert failing after a successful invite must not
            // leave a live-but-unscoped auth user: roll back the invite user.
            await ctx.db.auth.admin.deleteUser(inv.user.id).catch(() => {});
            throw mapDbError(insErr, ctx.requestId, "tenant_users.insert");
          }
          return {
            status: 201,
            body: {
              request_id: ctx.requestId,
              mode: "invite",
              email: emailRaw,
              user_id: inv.user.id,
              message: "invite email sent — the person sets their own password",
            },
          };
        }

        // ---- mode "password": generated temp password, shown ONCE --------
        const tempPassword = generateTempPassword();
        const { data: created, error: createErr } = await ctx.db.auth.admin.createUser({
          email: emailRaw,
          password: tempPassword,
          email_confirm: true, // admin-provisioned: no email round-trip
        });
        if (createErr || !created.user) {
          goTrueFailure("account creation failed", createErr ?? {});
        }
        const { error: insErr } = await ctx.db.from("tenant_users").insert({
          tenant_id: tenantId,
          user_id: created.user.id,
          email: emailRaw,
          created_by: "admin",
        });
        if (insErr) {
          await ctx.db.auth.admin.deleteUser(created.user.id).catch(() => {});
          throw mapDbError(insErr, ctx.requestId, "tenant_users.insert");
        }
        return {
          status: 201,
          body: {
            request_id: ctx.requestId,
            mode: "password",
            email: emailRaw,
            user_id: created.user.id,
            // SHOWN ONCE — the admin dashboard must display this and move on.
            temporary_password: tempPassword,
            warning: "hand this over now — it is never shown again; the person should change it after first login",
          },
        };
      }

      // ---- PATCH: revoke / reinstate / delete ----------------------------
      const body = await readJsonObject(ctx.req);
      const tenantId = requireUuid(body.tenant_id, "tenant_id");
      const userId = requireUuid(body.user_id, "user_id");
      const action = optString(body, "action", {
        required: true,
        values: ["revoke", "reinstate", "delete"],
      })!;
      await getTenant(ctx.db, tenantId, ctx.requestId);

      // Scope check FIRST: the user must belong to THIS tenant (the id in
      // the request is admin-chosen, but cross-tenant typos must 400 honestly).
      const { data: membership, error: memErr } = await ctx.db
        .from("tenant_users")
        .select(MEMBERSHIP_COLUMNS)
        .eq("tenant_id", tenantId)
        .eq("user_id", userId)
        .maybeSingle();
      if (memErr) throw mapDbError(memErr, ctx.requestId, "tenant_users.select");
      if (!membership) {
        throw new PilotError("invalid_request", "no portal login with that user id for this tenant");
      }

      if (action === "delete") {
        const { error: delErr } = await ctx.db.auth.admin.deleteUser(userId);
        if (delErr) throw goTrueFailure("deleting the auth user failed", delErr);
        // membership row removed by the auth.users FK cascade
        return { body: { request_id: ctx.requestId, deleted: true, user_id: userId } };
      }

      const patch = action === "revoke"
        ? { revoked_at: new Date().toISOString() }
        : { revoked_at: null };
      const { data: updated, error: upErr } = await ctx.db
        .from("tenant_users")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("user_id", userId)
        .select(MEMBERSHIP_COLUMNS)
        .maybeSingle();
      if (upErr) throw mapDbError(upErr, ctx.requestId, "tenant_users.update");
      return {
        body: {
          request_id: ctx.requestId,
          user: updated,
          action,
          ...(action === "revoke"
            ? { note: "this login loses portal access from its next request" }
            : {}),
        },
      };
    },
  ),
);
