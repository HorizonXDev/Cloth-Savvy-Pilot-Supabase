// functions/admin_tenants — dashboard tenant administration.
//
//   GET    list tenants (id, slug, name, status, model, settings, created)
//   POST   create tenant via create_tenant() (service-key path, README §5)
//   PATCH  update name / website_url / status (active|suspended) / settings
//   DELETE {id, confirm_slug}  PERMANENTLY drop a tenant via drop_tenant():
//          the row, its product partition, usage events, keys, portal
//          logins, staged uploads. Irreversible, audited, and refused
//          unless the tenant is already suspended AND the slug is typed
//          exactly — the two rules drop_tenant() enforces itself (T12).
//
// Auth: shared ADMIN_TOKEN bearer (see _admin/admin.ts) — not an sk_ key;
// this route is NOT metered and never touches usage_events.
// Settings writes are STRICT: validatedSettings() rejects any input the
// reader would have silently normalized, so the editor learns its mistake
// instead of storing fallbacks. Unknown body fields are ignored.

import { adminOrigins, DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIM, getTenant, requireUuid, validatedSettings, verifyAdmin } from "../_admin/admin.ts";
import { readEnv } from "../_pilot/env.ts";
import { PilotError } from "../_pilot/errors.ts";
import { handle } from "../_pilot/http.ts";
import { mapDbError } from "../_pilot/pgerror.ts";
import { optString, readJsonObject } from "../_pilot/validation.ts";

const SLUG_RE = /^[a-z0-9_]{1,40}$/;

Deno.serve((req) =>
  handle(
    req,
    readEnv(),
    { endpoint: "admin.tenants", auth: false, methods: ["GET", "POST", "PATCH", "DELETE"], corsOrigins: adminOrigins(readEnv()) },
    async (ctx) => {
      await verifyAdmin(ctx.req, ctx.env);

      if (ctx.req.method === "GET") {
        const { data, error } = await ctx.db
          .from("tenants")
          .select("id,slug,name,website_url,status,embedding_model,embedding_dim,settings,created_at")
          .order("created_at", { ascending: false });
        if (error) throw mapDbError(error, ctx.requestId, "tenants.list");
        return { body: { request_id: ctx.requestId, tenants: data ?? [] } };
      }

      if (ctx.req.method === "POST") {
        const body = await readJsonObject(ctx.req);
        const slug = optString(body, "slug", { required: true, min: 1, max: 40 })!;
        if (!SLUG_RE.test(slug)) {
          throw new PilotError("invalid_request", "field 'slug' must match ^[a-z0-9_]+$ (max 40)");
        }
        const name = optString(body, "name", { required: true, min: 1, max: 100 })!;
        const websiteUrl = optString(body, "website_url", { max: 300 });
        const model = optString(body, "embedding_model", { max: 100 }) ?? DEFAULT_EMBEDDING_MODEL;
        const settings = body.settings === undefined
          ? validatedSettings({}) // normalize to documented defaults
          : validatedSettings(body.settings);

        const { data: tenantId, error } = await ctx.db.rpc("create_tenant", {
          p_slug: slug,
          p_name: name,
          p_embedding_model: model,
          p_embedding_dim: EMBEDDING_DIM,
          p_settings: settings,
        });
        if (error) throw mapDbError(error, ctx.requestId, "create_tenant");
        if (typeof tenantId !== "string") {
          throw new PilotError("internal", "create_tenant did not return a tenant id");
        }
        if (websiteUrl) {
          const { error: updErr } = await ctx.db
            .from("tenants")
            .update({ website_url: websiteUrl })
            .eq("id", tenantId);
          if (updErr) throw mapDbError(updErr, ctx.requestId, "tenants.website_url");
        }
        const tenant = await getTenant(ctx.db, tenantId, ctx.requestId);
        return { status: 201, body: { request_id: ctx.requestId, tenant } };
      }

      // ---- DELETE: permanent drop ----------------------------------------
      if (ctx.req.method === "DELETE") {
        const body = await readJsonObject(ctx.req);
        const id = requireUuid(body.id, "id");
        const confirmSlug = optString(body, "confirm_slug", { required: true, min: 1, max: 40 })!;
        const tenant = await getTenant(ctx.db, id, ctx.requestId);

        // Check both rules HERE first so the dialog gets a sentence it can act
        // on. drop_tenant() re-checks them itself — the database is the last
        // line of defence, not this code (proven by isolation test T12).
        if (tenant.status !== "suspended") {
          throw new PilotError(
            "invalid_request",
            `tenant '${tenant.slug}' is ${tenant.status} — suspend it first, then delete it. ` +
              "A live tenant is never dropped by accident.",
          );
        }
        if (confirmSlug !== tenant.slug) {
          throw new PilotError(
            "invalid_request",
            `confirm slug mismatch — type '${tenant.slug}' exactly to delete ${tenant.name}`,
          );
        }

        const { error } = await ctx.db.rpc("drop_tenant", {
          p_tenant_id: id,
          p_confirm_slug: confirmSlug,
        });
        if (error) throw mapDbError(error, ctx.requestId, "drop_tenant");
        return {
          body: {
            request_id: ctx.requestId,
            deleted: true,
            id,
            slug: tenant.slug,
          },
        };
      }

      // ---- PATCH: update -------------------------------------------------
      const body = await readJsonObject(ctx.req);
      const id = requireUuid(body.id, "id");
      const current = await getTenant(ctx.db, id, ctx.requestId);

      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) {
        patch.name = optString(body, "name", { required: true, min: 1, max: 100 });
      }
      if (body.website_url !== undefined) {
        patch.website_url = body.website_url === null ? null : optString(body, "website_url", { max: 300 });
      }
      if (body.status !== undefined) {
        patch.status = optString(body, "status", { required: true, values: ["active", "suspended"] });
      }
      if (body.settings !== undefined) {
        // Merge over the CURRENT row so a partial editor form (e.g. only
        // combos changed) keeps every other key, then validate strictly.
        const merged = {
          ...(typeof current.settings === "object" && current.settings !== null && !Array.isArray(current.settings)
            ? current.settings
            : {}),
          ...(typeof body.settings === "object" && body.settings !== null && !Array.isArray(body.settings)
            ? body.settings
            : {}),
        };
        patch.settings = validatedSettings(merged);
      }
      if (Object.keys(patch).length === 0) {
        throw new PilotError("invalid_request", "nothing to update (name, website_url, status or settings)");
      }

      const { data: updated, error } = await ctx.db
        .from("tenants")
        .update(patch)
        .eq("id", id)
        .select("id,slug,name,website_url,status,embedding_model,embedding_dim,settings,created_at")
        .maybeSingle();
      if (error) throw mapDbError(error, ctx.requestId, "tenants.update");
      return { body: { request_id: ctx.requestId, tenant: updated } };
    },
  ),
);
