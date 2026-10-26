// functions/admin_usage — dashboard usage view.
//
//   GET ?tenant_id=<uuid>&days=7 (1..90)
//   -> { totals:{calls,units}, by_endpoint:[{endpoint,calls,units,codes:{}}],
//        by_key:[{key_id,prefix,environment,calls}], by_day:[{day,calls}],
//        truncated }
//
// Reads usage_events with the service-role client (SELECT is the only read
// privilege it has — the table is append-only by design). Rows are fetched
// for the window (cap 10000, newest first) and aggregated here: pilot scale
// makes that honest and cheap, and it needs NO new SQL objects, so
// schema_audit stays green. `truncated` tells the truth when the cap hit.
//
// Auth: shared ADMIN_TOKEN bearer; NOT metered (metering must never count
// the meter).

import { adminOrigins, getTenant, requireUuid, verifyAdmin } from "../_admin/admin.ts";
import { readEnv } from "../_pilot/env.ts";
import { handle } from "../_pilot/http.ts";
import { mapDbError } from "../_pilot/pgerror.ts";

const MAX_ROWS = 10000;

Deno.serve((req) =>
  handle(
    req,
    readEnv(),
    { endpoint: "admin.usage", auth: false, methods: ["GET"], corsOrigins: adminOrigins(readEnv()) },
    async (ctx) => {
      await verifyAdmin(ctx.req, ctx.env);

      const url = new URL(ctx.req.url);
      const tenantId = requireUuid(url.searchParams.get("tenant_id"), "tenant_id");
      const daysRaw = Number(url.searchParams.get("days") ?? "7");
      const days = Number.isInteger(daysRaw) && daysRaw >= 1 && daysRaw <= 90 ? daysRaw : 7;
      await getTenant(ctx.db, tenantId, ctx.requestId);

      const from = new Date(Date.now() - days * 24 * 3600 * 1000);

      const { data: keys, error: keysErr } = await ctx.db
        .from("api_keys")
        .select("id,key_prefix,environment,revoked_at")
        .eq("tenant_id", tenantId)
        .limit(500);
      if (keysErr) throw mapDbError(keysErr, ctx.requestId, "api_keys.list");

      const { data: events, error: evErr } = await ctx.db
        .from("usage_events")
        .select("created_at,endpoint,key_id,status_code,units")
        .eq("tenant_id", tenantId)
        .gte("created_at", from.toISOString())
        .order("created_at", { ascending: false })
        .limit(MAX_ROWS);
      if (evErr) throw mapDbError(evErr, ctx.requestId, "usage_events.list");
      const rows = events ?? [];
      const truncated = rows.length >= MAX_ROWS;

      const endpointMap = new Map<string, { calls: number; units: number; codes: Map<number, number> }>();
      const keyMap = new Map<string, number>();
      const dayMap = new Map<string, number>();
      let calls = 0;
      let units = 0;

      for (const row of rows as Array<{
        created_at: string; endpoint: string | null; key_id: string;
        status_code: number | null; units: number;
      }>) {
        calls++;
        units += row.units ?? 1;

        const ep = row.endpoint ?? "(unknown)";
        let e = endpointMap.get(ep);
        if (!e) {
          e = { calls: 0, units: 0, codes: new Map() };
          endpointMap.set(ep, e);
        }
        e.calls++;
        e.units += row.units ?? 1;
        if (row.status_code !== null) {
          e.codes.set(row.status_code, (e.codes.get(row.status_code) ?? 0) + 1);
        }

        keyMap.set(row.key_id, (keyMap.get(row.key_id) ?? 0) + 1);

        const day = row.created_at.slice(0, 10); // UTC YYYY-MM-DD
        dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
      }

      const keyPrefix = new Map(
        ((keys ?? []) as Array<{ id: string; key_prefix: string | null; environment: string }>)
          .map((k) => [k.id, { prefix: k.key_prefix ?? "(no prefix)", environment: k.environment }]),
      );

      return {
        body: {
          request_id: ctx.requestId,
          tenant_id: tenantId,
          days,
          from: from.toISOString(),
          totals: { calls, units },
          by_endpoint: [...endpointMap.entries()]
            .map(([endpoint, v]) => ({
              endpoint,
              calls: v.calls,
              units: v.units,
              codes: Object.fromEntries([...v.codes.entries()].sort((a, b) => a[0] - b[0])),
            }))
            .sort((a, b) => b.calls - a.calls),
          by_key: [...keyMap.entries()]
            .map(([keyId, n]) => ({
              key_id: keyId,
              prefix: keyPrefix.get(keyId)?.prefix ?? "(deleted key)",
              environment: keyPrefix.get(keyId)?.environment ?? "?",
              calls: n,
            }))
            .sort((a, b) => b.calls - a.calls),
          by_day: [...dayMap.entries()]
            .map(([day, n]) => ({ day, calls: n }))
            .sort((a, b) => a.day.localeCompare(b.day)),
          truncated,
        },
      };
    },
  ),
);
