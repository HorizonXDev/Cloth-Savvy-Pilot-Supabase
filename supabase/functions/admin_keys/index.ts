// functions/admin_keys — dashboard API-key administration.
//
//   GET    ?tenant_id=<uuid>   list keys (prefix only — never hashes)
//   POST   {tenant_id, environment: "live"|"sandbox", label?}
//          -> generate + register via create_api_key(); the plaintext is
//             returned EXACTLY ONCE in the response and never stored/logged
//   PATCH  {tenant_id, key_id} -> revoke (sets revoked_at, idempotent)
//
// Auth: shared ADMIN_TOKEN bearer (see _admin/admin.ts); NOT metered.
// Key material rules (decision D3): plaintext exists only in this response;
// the DB stores sha256 + display prefix; nothing here is ever logged.

import {
  adminOrigins,
  getTenant,
  newApiSecretKey,
  requireUuid,
  sha256HexOf,
  verifyAdmin,
  withHash,
} from "../_admin/admin.ts";
import { readEnv } from "../_pilot/env.ts";
import { PilotError } from "../_pilot/errors.ts";
import { handle } from "../_pilot/http.ts";
import { mapDbError } from "../_pilot/pgerror.ts";
import { optString, readJsonObject } from "../_pilot/validation.ts";

const KEY_COLUMNS = "id,key_prefix,environment,label,created_at,last_used_at,revoked_at";

Deno.serve((req) =>
  handle(
    req,
    readEnv(),
    { endpoint: "admin.keys", auth: false, methods: ["GET", "POST", "PATCH"], corsOrigins: adminOrigins(readEnv()) },
    async (ctx) => {
      await verifyAdmin(ctx.req, ctx.env, ctx.requestId);

      if (ctx.req.method === "GET") {
        const url = new URL(ctx.req.url);
        const tenantId = requireUuid(url.searchParams.get("tenant_id"), "tenant_id");
        await getTenant(ctx.db, tenantId, ctx.requestId); // 400 on unknown tenant
        const { data, error } = await ctx.db
          .from("api_keys")
          .select(KEY_COLUMNS)
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
          .limit(500);
        if (error) throw mapDbError(error, ctx.requestId, "api_keys.list");
        return { body: { request_id: ctx.requestId, keys: data ?? [] } };
      }

      if (ctx.req.method === "POST") {
        const body = await readJsonObject(ctx.req);
        const tenantId = requireUuid(body.tenant_id, "tenant_id");
        const envRaw = optString(body, "environment", {
          required: true,
          values: ["live", "sandbox"],
        })!;
        const environment: "live" | "sandbox" = envRaw === "sandbox" ? "sandbox" : "live";
        const label = body.label === undefined || body.label === null
          ? null
          : optString(body, "label", { max: 100 }) ?? null;
        await getTenant(ctx.db, tenantId, ctx.requestId);

        const key = await withHash(newApiSecretKey(environment));
        const { data: keyId, error } = await ctx.db.rpc("create_api_key", {
          p_tenant_id: tenantId,
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
            // SHOWN ONCE — the dashboard must display this and move on.
            plaintext: key.plaintext,
            warning: "store this key now — it is never shown again",
            key: row,
          },
        };
      }

      // ---- PATCH: revoke -------------------------------------------------
      const body = await readJsonObject(ctx.req);
      const tenantId = requireUuid(body.tenant_id, "tenant_id");
      const keyId = requireUuid(body.key_id, "key_id");
      const { data: row, error } = await ctx.db
        .from("api_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("id", keyId)
        .is("revoked_at", null)
        .select(KEY_COLUMNS)
        .maybeSingle();
      if (error) throw mapDbError(error, ctx.requestId, "api_keys.revoke");
      if (!row) {
        // Already revoked (or unknown) — read it so the response is honest.
        const { data: existing, error: selErr } = await ctx.db
          .from("api_keys")
          .select(KEY_COLUMNS)
          .eq("tenant_id", tenantId)
          .eq("id", keyId)
          .maybeSingle();
        if (selErr) throw mapDbError(selErr, ctx.requestId, "api_keys.select");
        if (!existing) {
          throw new PilotError("invalid_request", "no key with that id for this tenant");
        }
        return { body: { request_id: ctx.requestId, key: existing, already_revoked: true } };
      }
      return { body: { request_id: ctx.requestId, key: row } };
    },
  ),
);
