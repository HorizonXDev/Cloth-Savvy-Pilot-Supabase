// functions/tenant_keys — the portal's API-key management, scoped to the
// session's tenant and NOTHING else.
//
//   GET    -> list keys (prefix only — never hashes)
//   POST   {environment: "live"|"sandbox", label?}
//          -> mint a key for THE SESSION'S TENANT; plaintext returned
//             EXACTLY ONCE (same show-once contract as admin_keys)
//   PATCH  {key_id} -> revoke one of THE SESSION'S TENANT's keys
//
// SEPARATION NOTE: unlike admin_keys, this route NEVER reads a tenant_id
// from body or query — it comes from resolvePortalSession only (the T15
// rule, applied at the portal layer). A body that carries tenant_id (or
// any tenant-ish field) is ignored exactly like any unknown field: the
// answer is always the session's own tenant. Cross-tenant key operations
// are therefore not expressible here — there is no code path for them.
//
// Key material (decision D3, unchanged): plaintext exists only in the
// POST response; the DB stores sha256 + display prefix; nothing logged.
//
// Auth: portal session. NOT metered.

import { readEnv } from "../_pilot/env.ts";
import { PilotError } from "../_pilot/errors.ts";
import { handle } from "../_pilot/http.ts";
import { newApiSecretKey, withHash } from "../_pilot/keystore.ts";
import { mapDbError } from "../_pilot/pgerror.ts";
import { optString, readJsonObject } from "../_pilot/validation.ts";
import { resolvePortalSession, tenantOrigins } from "../_tenant/tenant.ts";

const KEY_COLUMNS = "id,key_prefix,environment,label,created_at,last_used_at,revoked_at";

Deno.serve((req) =>
  handle(
    req,
    readEnv(),
    {
      endpoint: "tenant.keys",
      auth: false,
      methods: ["GET", "POST", "PATCH"],
      corsOrigins: tenantOrigins(readEnv()),
    },
    async (ctx) => {
      const session = await resolvePortalSession(ctx.req, ctx.db, ctx.requestId);

      if (ctx.req.method === "GET") {
        const { data, error } = await ctx.db
          .from("api_keys")
          .select(KEY_COLUMNS)
          .eq("tenant_id", session.tenantId)
          .order("created_at", { ascending: false })
          .limit(500);
        if (error) throw mapDbError(error, ctx.requestId, "api_keys.list");
        return { body: { request_id: ctx.requestId, keys: data ?? [] } };
      }

      if (ctx.req.method === "POST") {
        const body = await readJsonObject(ctx.req);
        const envRaw = optString(body, "environment", {
          required: true,
          values: ["live", "sandbox"],
        })!;
        const environment: "live" | "sandbox" = envRaw === "sandbox" ? "sandbox" : "live";
        const label = body.label === undefined || body.label === null
          ? null
          : optString(body, "label", { max: 100 }) ?? null;
        // NOTE: body.tenant_id (if present) is an unknown field here —
        // ignored by design. The tenant comes from the session.

        const key = await withHash(newApiSecretKey(environment));
        const { data: keyId, error } = await ctx.db.rpc("create_api_key", {
          p_tenant_id: session.tenantId,
          p_key_hash: key.keyHash,
          p_key_prefix: key.keyPrefix,
          p_environment: environment,
          p_label: label,
        });
        if (error) throw mapDbError(error, ctx.requestId, "create_api_key");
        if (typeof keyId !== "string") {
          throw new PilotError("internal", "create_api_key did not return a key id");
        }
        const { data: row, error: selErr } = await ctx.db
          .from("api_keys")
          .select(KEY_COLUMNS)
          .eq("id", keyId)
          .maybeSingle();
        if (selErr) throw mapDbError(selErr, ctx.requestId, "api_keys.select");
        return {
          status: 201,
          body: {
            request_id: ctx.requestId,
            // SHOWN ONCE — the portal must display this and move on.
            plaintext: key.plaintext,
            warning: "store this key now — it is never shown again",
            key: row,
          },
        };
      }

      // ---- PATCH: revoke -------------------------------------------------
      const body = await readJsonObject(ctx.req);
      const keyIdRaw = body.key_id;
      if (typeof keyIdRaw !== "string" || keyIdRaw === "") {
        throw new PilotError("invalid_request", "field 'key_id' is required");
      }
      const { data: row, error } = await ctx.db
        .from("api_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("tenant_id", session.tenantId) // SCOPING: session tenant only
        .eq("id", keyIdRaw)
        .is("revoked_at", null)
        .select(KEY_COLUMNS)
        .maybeSingle();
      if (error) throw mapDbError(error, ctx.requestId, "api_keys.revoke");
      if (!row) {
        const { data: existing, error: selErr } = await ctx.db
          .from("api_keys")
          .select(KEY_COLUMNS)
          .eq("tenant_id", session.tenantId)
          .eq("id", keyIdRaw)
          .maybeSingle();
        if (selErr) throw mapDbError(selErr, ctx.requestId, "api_keys.select");
        if (!existing) {
          // Unknown id for THIS tenant — never reveal whether it exists elsewhere.
          throw new PilotError("invalid_request", "no key with that id for your tenant");
        }
        return { body: { request_id: ctx.requestId, key: existing, already_revoked: true } };
      }
      return { body: { request_id: ctx.requestId, key: row } };
    },
  ),
);
