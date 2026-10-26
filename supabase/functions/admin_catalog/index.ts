// functions/admin_catalog — dashboard catalog administration + QA.
//
//   GET  ?op=products&tenant_id=…[&section=&status=&q=&page=&page_size=]
//        paginated product browse (no embeddings in the payload)
//   GET  ?op=runs&tenant_id=…           recent ingestion_runs
//   GET  ?op=health                     db ping + encoder relay (admin view)
//   POST {op:"search", …}               search preview on any tenant: embed
//        the typed query with the real encoder, run search_products, show
//        similarity-ranked results — exactly what a tenant's callers see.
//   POST {op:"import_start", tenant_id, rows_total, notes?}
//        open an ingestion_runs row (status "running")
//   POST {op:"import_batch", tenant_id, run_id, rows:[…1..50]}
//        embed + insert one batch; per-row failures are returned AND counted
//        (rows_ok/rows_failed) — never a silent drop. ALL texts are embedded
//        BEFORE any insert so an encoder 503 leaves the batch untouched and
//        cleanly retryable.
//   POST {op:"import_finish", tenant_id, run_id, status:"done"|"failed", notes?}
//   POST {op:"set_status", tenant_id, product_ids:[…1..100], status:"active"|"archived"}
//
// Import row shape (unknown fields ignored):
//   {external_id*, title*, section* (pilot section enum), category?, gender?,
//    colors? [≤10], price?, in_stock?, product_url?, image_url?,
//    attributes? object ≤4KB, status? "active"|"archived"}
// Products are inserted with source:"csv" and the TENANT's embedding_model
// (the products_guard trigger enforces the match); the embedding is the
// FashionCLIP text embedding of "title + category + colors" — the same
// vector space search_products queries. Auth: shared ADMIN_TOKEN bearer.

import { encoderHealth, embedTexts } from "../_pilot/encoder.ts";
import { parseImportRow as parseImportRowShared, type ParsedRow } from "../_pilot/import_row.ts";
import { readEnv } from "../_pilot/env.ts";
import { PilotError } from "../_pilot/errors.ts";
import { handle } from "../_pilot/http.ts";
import { mapDbError } from "../_pilot/pgerror.ts";
import { isSection, ALLOWED_SECTIONS } from "../_pilot/sections.ts";
import { parseTenantSettings } from "../_pilot/settings.ts";
import type { ProductRow } from "../_pilot/types.ts";
import {
  optBool,
  optColorList,
  optInt,
  optNumber,
  optString,
  readJsonObject,
} from "../_pilot/validation.ts";
import { adminOrigins, getTenant, requireUuid, verifyAdmin } from "../_admin/admin.ts";

const PRODUCT_COLUMNS =
  "id,external_id,title,section,category,gender,colors,price,in_stock,product_url,image_url,status,source,attributes,created_at,updated_at";
const IMPORT_BATCH_MAX = 50;
const EMBED_CHUNK = 8; // encoder batch limit

/** Validate one import row. Throws PilotError invalid_request with a precise
 * reason — the caller turns that into a per-row failure entry.
 *
 * The RULES live in _pilot/import_row.ts so the tenant portal's staging path
 * validates identically (2026-10-26); only the error class differs. */
function parseImportRow(raw: unknown, index: number): ParsedRow {
  const fail = (why: string): never => {
    throw new PilotError("invalid_request", `row ${index}: ${why}`);
  };
  return parseImportRowShared(raw, index, fail);
}

function escapeIlike(q: string): string {
  return q.replace(/([\\%_])/g, "\\$1");
}

/** Map a per-row Postgres failure to a short admin-facing reason. */
function rowErrorReason(err: { code?: string; message?: string } | null): string {
  const code = err?.code ?? "unknown";
  if (code === "23505") return "duplicate external_id (already imported for this tenant)";
  if (code === "23514") {
    const m = (err?.message ?? "").replace(/\s+/g, " ").slice(0, 160);
    return `rejected by a database check: ${m || "check constraint"}`;
  }
  if (code === "23503") return "foreign-key violation (tenant missing?)";
  return `database error ${code}`;
}

Deno.serve((req) =>
  handle(
    req,
    readEnv(),
    { endpoint: "admin.catalog", auth: false, methods: ["GET", "POST"], corsOrigins: adminOrigins(readEnv()) },
    async (ctx) => {
      await verifyAdmin(ctx.req, ctx.env);

      // ----------------------------------------------------------------- GET
      if (ctx.req.method === "GET") {
        const url = new URL(ctx.req.url);
        const op = url.searchParams.get("op") ?? "products";

        if (op === "health") {
          const t0 = performance.now();
          let dbStatus: "ok" | "degraded" = "ok";
          let dbDetail: string | undefined;
          try {
            const { error } = await ctx.db
              .from("tenants")
              .select("id", { count: "exact", head: true });
            if (error) {
              dbStatus = "degraded";
              dbDetail = error.code ?? "query failed";
            }
          } catch {
            dbStatus = "degraded";
            dbDetail = "unreachable";
          }
          const enc = await encoderHealth(ctx.env);
          return {
            body: {
              request_id: ctx.requestId,
              status: dbStatus === "ok" && enc.status === "ok" ? "ok" : "degraded",
              latency_ms: Math.round(performance.now() - t0),
              database: { status: dbStatus, ...(dbDetail ? { detail: dbDetail } : {}) },
              encoder: enc,
            },
          };
        }

        const tenantId = requireUuid(url.searchParams.get("tenant_id"), "tenant_id");
        await getTenant(ctx.db, tenantId, ctx.requestId);

        if (op === "runs") {
          const { data, error } = await ctx.db
            .from("ingestion_runs")
            .select("id,status,rows_total,rows_ok,rows_failed,started_at,finished_at,notes")
            .eq("tenant_id", tenantId)
            .order("started_at", { ascending: false })
            .limit(50);
          if (error) throw mapDbError(error, ctx.requestId, "ingestion_runs.list");
          return { body: { request_id: ctx.requestId, runs: data ?? [] } };
        }

        if (op === "staging") {
          // The owner's pipeline queue: what a tenant uploaded and has NOT
          // merged yet (2026-10-26 — catalog mutation moved to the portal;
          // this is the admin view of it, read-only).
          const s = url.searchParams.get("status");
          if (s && !["pending", "failed", "merged"].includes(s)) {
            throw new PilotError("invalid_request", "status must be pending, failed or merged");
          }
          const limit = optInt({ limit: Number(url.searchParams.get("limit") ?? "100") }, "limit", { min: 1, max: 500 })!;
          let q2 = ctx.db
            .from("catalog_staging")
            .select("id,external_id,payload,status,error,source_file,run_id,product_id,created_at,updated_at,merged_at", { count: "exact" })
            .eq("tenant_id", tenantId);
          if (s) q2 = q2.eq("status", s);
          const rows2 = await q2.order("created_at", { ascending: false }).limit(limit);
          if (rows2.error) throw mapDbError(rows2.error, ctx.requestId, "catalog_staging.list");
          return { body: { request_id: ctx.requestId, rows: rows2.data ?? [], total: rows2.count ?? 0 } };
        }

        if (op !== "products") {
          throw new PilotError("invalid_request", "op must be one of: products, runs, health, staging");
        }

        const page = optInt({ page: Number(url.searchParams.get("page") ?? "0") }, "page", { min: 0, max: 100000 })!;
        const pageSize = optInt({ page_size: Number(url.searchParams.get("page_size") ?? "25") }, "page_size", { min: 1, max: 100 })!;
        const section = url.searchParams.get("section");
        const status = url.searchParams.get("status");
        const q = url.searchParams.get("q");

        let query = ctx.db
          .from("products")
          .select(PRODUCT_COLUMNS, { count: "exact" })
          .eq("tenant_id", tenantId);
        if (section) {
          if (!isSection(section)) {
            throw new PilotError("invalid_request", `section must be one of: ${ALLOWED_SECTIONS.join(", ")}`);
          }
          query = query.eq("section", section);
        }
        if (status) {
          if (status !== "active" && status !== "archived") {
            throw new PilotError("invalid_request", "status must be active or archived");
          }
          query = query.eq("status", status);
        }
        if (q && q.trim() !== "") {
          query = query.ilike("title", `%${escapeIlike(q.trim())}%`);
        }
        const { data, error, count } = await query
          .order("updated_at", { ascending: false })
          .range(page * pageSize, page * pageSize + pageSize - 1);
        if (error) throw mapDbError(error, ctx.requestId, "products.list");
        return {
          body: {
            request_id: ctx.requestId,
            products: data ?? [],
            total: count ?? 0,
            page,
            page_size: pageSize,
          },
        };
      }

      // ---------------------------------------------------------------- POST
      const body = await readJsonObject(ctx.req);
      const op = optString(body, "op", { required: true, max: 40 })!;
      const tenantId = requireUuid(body.tenant_id, "tenant_id");
      const tenant = await getTenant(ctx.db, tenantId, ctx.requestId);

      // ---- search preview -----------------------------------------------
      if (op === "search") {
        const settings = parseTenantSettings(tenant.settings).settings;
        const query = optString(body, "query", { required: true, min: 1, max: 300 })!;
        let section: string | undefined;
        if (body.section !== undefined && body.section !== null) {
          section = optString(body, "section", { required: true })!;
          if (!isSection(section)) {
            throw new PilotError("invalid_request", `section must be one of: ${ALLOWED_SECTIONS.join(", ")}`);
          }
        }
        const limit = optInt(body, "limit", { min: 1, max: 50, default: settings.default_limit })!;
        const minSimilarity = optNumber(body, "min_similarity", {
          min: 0, max: 1, default: settings.min_similarity,
        })!;
        const colors = optColorList(body, "colors");
        const maxPrice = optNumber(body, "max_price", { min: 0 });
        const inStockOnly = optBool(body, "in_stock_only", true)!;

        const { embeddings } = await embedTexts(ctx.env, [query], tenant.embedding_model);
        const { data, error } = await ctx.db.rpc("search_products", {
          p_tenant_id: tenantId,
          p_query: JSON.stringify(embeddings[0]),
          p_embedding_model: tenant.embedding_model,
          p_section: section ?? null,
          p_limit: limit,
          p_min_similarity: minSimilarity,
          p_in_stock_only: inStockOnly,
          p_max_price: maxPrice ?? null,
          p_colors: colors ?? null,
        });
        if (error) throw mapDbError(error, ctx.requestId, "search_products");
        const rows = (data ?? []) as ProductRow[];
        return {
          body: {
            request_id: ctx.requestId,
            items: rows.map((row) => ({
              section: row.section,
              similarity: row.similarity ?? null,
              product: {
                external_id: row.external_id,
                title: row.title,
                price: row.price === null ? null : Number(row.price),
                image_url: row.image_url,
                colors: row.colors ?? [],
                in_stock: row.in_stock,
              },
            })),
            no_match: rows.length === 0,
          },
        };
      }

      // ---- ingestion ------------------------------------------------------
      if (op === "import_start") {
        const rowsTotal = optInt(body, "rows_total", { required: true, min: 0, max: 1000000 })!;
        const notes = body.notes === undefined || body.notes === null
          ? null
          : optString(body, "notes", { max: 1000 }) ?? null;
        const { data: run, error } = await ctx.db
          .from("ingestion_runs")
          .insert({ tenant_id: tenantId, status: "running", rows_total: rowsTotal, notes })
          .select("id,status,rows_total,rows_ok,rows_failed,started_at,finished_at,notes")
          .single();
        if (error) throw mapDbError(error, ctx.requestId, "ingestion_runs.insert");
        return { status: 201, body: { request_id: ctx.requestId, run } };
      }

      if (op === "import_batch") {
        const runId = requireUuid(body.run_id, "run_id");
        const rawRows = body.rows;
        if (!Array.isArray(rawRows) || rawRows.length < 1 || rawRows.length > IMPORT_BATCH_MAX) {
          throw new PilotError("invalid_request", `rows must be an array of 1..${IMPORT_BATCH_MAX} rows`);
        }

        const { data: run, error: runErr } = await ctx.db
          .from("ingestion_runs")
          .select("id,status,rows_ok,rows_failed")
          .eq("id", runId)
          .eq("tenant_id", tenantId)
          .maybeSingle();
        if (runErr) throw mapDbError(runErr, ctx.requestId, "ingestion_runs.select");
        if (!run) throw new PilotError("invalid_request", "no ingestion run with that id for this tenant");
        if (run.status !== "running") {
          throw new PilotError("invalid_request", `run is '${run.status}', not 'running' — start a new run`);
        }

        // 1. Validate every row; failures are collected, never silently dropped.
        const failed: Array<{ index: number; external_id: string | null; reason: string }> = [];
        const valid: ParsedRow[] = [];
        rawRows.forEach((raw, i) => {
          try {
            valid.push(parseImportRow(raw, i));
          } catch (e) {
            const reason = e instanceof PilotError ? e.message : "row could not be parsed";
            const ext = (typeof raw === "object" && raw !== null && typeof (raw as Record<string, unknown>).external_id === "string")
              ? (raw as Record<string, unknown>).external_id as string
              : null;
            failed.push({ index: i, external_id: ext, reason });
          }
        });

        // 2. Embed ALL valid texts FIRST (chunked to the encoder's batch cap).
        //    If the encoder fails we 503 with nothing inserted — the batch is
        //    cleanly retryable and no counters moved (honesty over progress).
        let embeddings: number[][] = [];
        if (valid.length > 0) {
          const vectors: number[][] = [];
          for (let i = 0; i < valid.length; i += EMBED_CHUNK) {
            const chunk = valid.slice(i, i + EMBED_CHUNK).map((r) => r.embedText);
            const res = await embedTexts(ctx.env, chunk, tenant.embedding_model);
            vectors.push(...res.embeddings);
          }
          embeddings = vectors;
        }

        // 3. Insert row by row; per-row DB failures are reported + counted.
        const inserted: string[] = [];
        let ok = 0;
        try {
          for (let i = 0; i < valid.length; i++) {
            const r = valid[i];
            const { error: insErr } = await ctx.db.from("products").insert({
              tenant_id: tenantId,
              external_id: r.external_id,
              title: r.title,
              section: r.section,
              category: r.category,
              gender: r.gender,
              colors: r.colors,
              price: r.price,
              in_stock: r.in_stock,
              product_url: r.product_url,
              image_url: r.image_url,
              attributes: r.attributes,
              embedding: JSON.stringify(embeddings[i]),
              embedding_model: tenant.embedding_model,
              status: r.status,
              source: "csv",
            });
            if (insErr) {
              failed.push({ index: i, external_id: r.external_id, reason: rowErrorReason(insErr) });
            } else {
              inserted.push(r.external_id);
              ok++;
            }
          }
        } finally {
          // 4. Whatever happened above, the run counters reflect reality.
          if (ok > 0 || failed.length > 0) {
            const nextOk = (run.rows_ok ?? 0) + ok;
            const nextFailed = (run.rows_failed ?? 0) + failed.length;
            const { error: cntErr } = await ctx.db
              .from("ingestion_runs")
              .update({ rows_ok: nextOk, rows_failed: nextFailed })
              .eq("id", runId);
            if (cntErr) throw mapDbError(cntErr, ctx.requestId, "ingestion_runs.counters");
          }
        }

        return {
          body: {
            request_id: ctx.requestId,
            batch: { ok, failed: failed.length },
            inserted,
            failed,
          },
        };
      }

      if (op === "import_finish") {
        const runId = requireUuid(body.run_id, "run_id");
        const status = optString(body, "status", { required: true, values: ["done", "failed"] })!;
        const notes = body.notes === undefined || body.notes === null
          ? undefined
          : optString(body, "notes", { max: 1000 });
        const { data: run, error } = await ctx.db
          .from("ingestion_runs")
          .update({
            status,
            finished_at: new Date().toISOString(),
            ...(notes !== undefined ? { notes } : {}),
          })
          .eq("id", runId)
          .eq("tenant_id", tenantId)
          .select("id,status,rows_total,rows_ok,rows_failed,started_at,finished_at,notes")
          .maybeSingle();
        if (error) throw mapDbError(error, ctx.requestId, "ingestion_runs.finish");
        if (!run) throw new PilotError("invalid_request", "no ingestion run with that id for this tenant");
        return { body: { request_id: ctx.requestId, run } };
      }

      // ---- set_status (archive / unarchive) ------------------------------
      if (op === "set_status") {
        const status = optString(body, "status", { required: true, values: ["active", "archived"] })!;
        const idsRaw = body.product_ids;
        if (!Array.isArray(idsRaw) || idsRaw.length < 1 || idsRaw.length > 100) {
          throw new PilotError("invalid_request", "product_ids must be an array of 1..100 UUIDs");
        }
        const ids = idsRaw.map((v, i) => requireUuid(v, `product_ids[${i}]`));
        const { data: updated, error } = await ctx.db
          .from("products")
          .update({ status })
          .eq("tenant_id", tenantId)
          .in("id", ids)
          .select("id");
        if (error) throw mapDbError(error, ctx.requestId, "products.set_status");
        return {
          body: {
            request_id: ctx.requestId,
            updated: (updated ?? []).length,
            requested: ids.length,
            status,
          },
        };
      }

      throw new PilotError(
        "invalid_request",
        "op must be one of: search, import_start, import_batch, import_finish, set_status",
      );
    },
  ),
);
