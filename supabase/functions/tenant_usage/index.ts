// functions/tenant_usage — the portal's usage view + usage/cost summary.
//
//   GET ?days=7 (1..90)
//   -> { totals:{calls,units}, month_to_date:{calls,units},
//        by_endpoint:[{endpoint,calls,units,codes:{}}],
//        by_key:[{key_id,prefix,environment,calls}],
//        by_day:[{day,calls}], rate_limit_per_min, currency, truncated,
//        vton:{rate_limit_per_min,monthly_cap,calls_this_month} }
//
// `vton` mirrors the P0-3 quota enforced by _pilot/rate_limit.ts, so the
// portal can show "12 / 100 try-ons this month" without guessing. The count
// excludes calls that were themselves refused by a quota check (429/402) —
// exactly what the limiter counts — so the number matches what is enforced.
//
// Same aggregation engine as admin_usage (fetch ≤10000 rows for the
// window, aggregate in-function — honest at pilot scale, zero new SQL
// objects so schema_audit stays green), but the tenant_id is the
// SESSION's: there is no tenant_id parameter on this route at all, so
// one tenant cannot read another's numbers by asking.
//
// month_to_date = UTC calendar month so far — the "billing" block the
// portal shows. There is deliberately NO currency math here: the pilot
// has no pricing model (decision log), so the summary is honest units +
// calls, ready to be multiplied once pricing exists.
//
// Auth: portal session. NOT metered (viewing usage is not usage).

import { readEnv } from "../_pilot/env.ts";
import { handle } from "../_pilot/http.ts";
import { mapDbError } from "../_pilot/pgerror.ts";
import { resolvePortalSession, tenantOrigins } from "../_tenant/tenant.ts";

const MAX_ROWS = 10000;

interface EventRow {
  created_at: string;
  endpoint: string | null;
  key_id: string;
  status_code: number | null;
  units: number;
}

Deno.serve((req) =>
  handle(
    req,
    readEnv(),
    { endpoint: "tenant.usage", auth: false, methods: ["GET"], corsOrigins: tenantOrigins(readEnv()) },
    async (ctx) => {
      const session = await resolvePortalSession(ctx.req, ctx.db, ctx.requestId);

      const url = new URL(ctx.req.url);
      const daysRaw = Number(url.searchParams.get("days") ?? "7");
      const days = Number.isInteger(daysRaw) && daysRaw >= 1 && daysRaw <= 90 ? daysRaw : 7;
      const from = new Date(Date.now() - days * 24 * 3600 * 1000);

      const { data: keys, error: keysErr } = await ctx.db
        .from("api_keys")
        .select("id,key_prefix,environment,revoked_at")
        .eq("tenant_id", session.tenantId)
        .limit(500);
      if (keysErr) throw mapDbError(keysErr, ctx.requestId, "api_keys.list");

      const { data: events, error: evErr } = await ctx.db
        .from("usage_events")
        .select("created_at,endpoint,key_id,status_code,units")
        .eq("tenant_id", session.tenantId)
        .gte("created_at", from.toISOString())
        .order("created_at", { ascending: false })
        .limit(MAX_ROWS);
      if (evErr) throw mapDbError(evErr, ctx.requestId, "usage_events.list");
      const rows = (events ?? []) as EventRow[];
      const truncated = rows.length >= MAX_ROWS;

      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);

      // P0-3 quota mirror: billable try-on calls this UTC month, tenant-wide.
      // A head count is cheap and exact; 429/402 rows are excluded because the
      // limiter excludes them too (a blocked call must not consume the cap).
      const { count: vtonCount, error: vtonErr } = await ctx.db
        .from("usage_events")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", session.tenantId)
        .eq("endpoint", "vton")
        .gt("created_at", monthStart.toISOString())
        .not("status_code", "in", "(429,402)");
      if (vtonErr) throw mapDbError(vtonErr, ctx.requestId, "usage_events.vton_count");

      const endpointMap = new Map<string, { calls: number; units: number; codes: Map<number, number> }>();
      const keyMap = new Map<string, number>();
      const dayMap = new Map<string, number>();
      let calls = 0;
      let units = 0;
      let mtdCalls = 0;
      let mtdUnits = 0;

      for (const row of rows) {
        const rowUnits = row.units ?? 1;
        calls++;
        units += rowUnits;
        if (new Date(row.created_at) >= monthStart) {
          mtdCalls++;
          mtdUnits += rowUnits;
        }

        const ep = row.endpoint ?? "(unknown)";
        let e = endpointMap.get(ep);
        if (!e) {
          e = { calls: 0, units: 0, codes: new Map() };
          endpointMap.set(ep, e);
        }
        e.calls++;
        e.units += rowUnits;
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
          tenant_id: session.tenantId,
          days,
          from: from.toISOString(),
          totals: { calls, units },
          month_to_date: { calls: mtdCalls, units: mtdUnits },
          // Display values the portal renders as-is (no pricing applied).
          currency: session.settings.currency,
          rate_limit_per_min: session.settings.rate_limit_per_min,
          vton: {
            rate_limit_per_min: session.settings.vton_rate_limit_per_min,
            monthly_cap: session.settings.vton_monthly_cap,
            calls_this_month: vtonCount ?? 0,
          },
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
