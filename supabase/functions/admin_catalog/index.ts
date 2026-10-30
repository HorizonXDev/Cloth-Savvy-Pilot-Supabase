// functions/admin_catalog — dashboard catalog administration + QA.
//
//   GET  ?op=products&tenant_id=...[&section=&status=&q=&page=&page_size=]
//        paginated product browse (no embeddings in the payload)
//   GET  ?op=runs&tenant_id=...            recent ingestion_runs
//   GET  ?op=health                      db ping + encoder relay (admin view)
//   GET  ?op=staging&tenant_id=[&status=&limit=&offset=]
//        the tenant's upload queue, read-only
//   GET  ?op=embed_export&tenant_id=[&limit=&offset=]
//        THE PIPELINE INPUT: everything that still needs an IMAGE vector —
//        queued staging rows plus live products whose image_url changed
//        (needs_reembed) — as {external_id, image_url, title, section,
//        reason}. Paging: two independent windows, client loops the offset
//        until it has collected `total` rows.
//   POST {op:"search", ...}               search preview on any tenant: embed
//        the typed QUERY with the real encoder, run search_products, show
//        similarity-ranked results. (Query is text; catalog vectors are
//        images — CLIP's towers share one 512-d space, which is why this
//        cosine works.)
//   POST {op:"embeddings_merge", tenant_id, rows:[...1..500], source?}
//        the owner's generated vectors, applied BY ID. Each row is
//        {external_id, embedding:[512 finite numbers]}. Body cap 8 MB (a
//        500-row merge is ~4–6 MB); the dashboard sends 64-row chunks (~0.6 MB)
//        so every request stays under this cap AND the platform ingress. A match against a
//        queued staging row upserts `products` from the staged payload plus
//        that vector and marks the row merged; a match against a product
//        flagged needs_reembed just swaps the vector and clears the flag.
//        Bad rows come back in `skipped` with the reason — never a silent
//        drop. Re-uploading the same file is safe (upsert). When `source`
//        (the filename) is supplied an ingestion_runs row records the merge
//        so the tenant's history tells the same story you see here.
//   POST {op:"set_status", tenant_id, product_ids:[...1..100], status:"active"|"archived"}
//
// Text is NEVER embedded into the catalog (owner decision, 2026-10-26):
// title / category / colours / section / price are SQL filters only, and the
// old import_* text-embedding ops left with the admin upload UI. Products
// land with source:"csv" and the TENANT's embedding_model (products_guard
// enforces the match). Auth: shared ADMIN_TOKEN bearer.

import { encoderHealth, embedTexts } from "../_pilot/encoder.ts";
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
  "id,external_id,title,section,category,gender,colors,price,in_stock,product_url,image_url,status,source,attributes,needs_reembed,created_at,updated_at";
const MERGE_MAX = 500; // rows accepted per embeddings_merge call
// Bulk body cap for this admin-token route: embeddings_merge carries up to
// MERGE_MAX vectors (500 × ~8–12 KB ≈ 4–6 MB). The default 32 KB guard in
// validation.ts is right for ordinary routes but rejected every real merge
// ("request body exceeds 32768 bytes"). The dashboard chunks at 64 rows
// (~0.6 MB), leaving big headroom below — and below the platform ingress.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const VECTOR_DIM = 512; // matches p_embedding_dim and the encoder output

function escapeIlike(q: string): string {
  return q.replace(/([\\%_])/g, "\\$1");
}

Deno.serve((req) =>
  handle(
    req,
    readEnv(),
    { endpoint: "admin.catalog", auth: false, methods: ["GET", "POST"], corsOrigins: adminOrigins(readEnv()) },
    async (ctx) => {
      await verifyAdmin(ctx.req, ctx.env, ctx.requestId);

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

        if (op === "embed_export") {
          // Everything that still needs an IMAGE vector, as the pipeline's
          // id->url table. Rows with no image_url are returned anyway (with
          // image_url null) so the dashboard can name them instead of
          // silently dropping them from the file.
          const offset = optInt({ offset: Number(url.searchParams.get("offset") ?? "0") }, "offset", { min: 0, max: 1000000 })!;
          const limit = optInt({ limit: Number(url.searchParams.get("limit") ?? "500") }, "limit", { min: 1, max: 500 })!;

          const st = await ctx.db
            .from("catalog_staging")
            .select("external_id,payload,status,error", { count: "exact" })
            .eq("tenant_id", tenantId)
            .in("status", ["pending", "failed"])
            .order("created_at", { ascending: true })
            .range(offset, offset + limit - 1);
          if (st.error) throw mapDbError(st.error, ctx.requestId, "catalog_staging.export");

          const pf = await ctx.db
            .from("products")
            .select("external_id,title,section,image_url", { count: "exact" })
            .eq("tenant_id", tenantId)
            .eq("needs_reembed", true)
            .order("updated_at", { ascending: true })
            .range(offset, offset + limit - 1);
          if (pf.error) throw mapDbError(pf.error, ctx.requestId, "products.export");

          const rows = [
            ...(st.data ?? []).map((r) => {
              const p = (r.payload ?? {}) as Record<string, unknown>;
              return {
                external_id: r.external_id,
                image_url: typeof p.image_url === "string" && p.image_url !== "" ? p.image_url : null,
                title: typeof p.title === "string" ? p.title : null,
                section: typeof p.section === "string" ? p.section : null,
                reason: r.status === "failed" ? `queue: ${r.error ?? "failed"}` : "queued",
              };
            }),
            ...(pf.data ?? []).map((r) => ({
              external_id: r.external_id,
              image_url: r.image_url ?? null,
              title: r.title,
              section: r.section,
              reason: "image changed",
            })),
          ];

          return {
            body: {
              request_id: ctx.requestId,
              rows,
              total: (st.count ?? 0) + (pf.count ?? 0),
              no_image_url: rows.filter((r) => r.image_url === null).length,
              offset,
              limit,
            },
          };
        }

        if (op !== "products") {
          throw new PilotError("invalid_request", "op must be one of: products, runs, health, staging, embed_export");
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
      const body = await readJsonObject(ctx.req, MAX_BODY_BYTES);
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

      // ---- the owner's vectors, applied BY ID -----------------------------
      if (op === "embeddings_merge") {
        const rawRows = body.rows;
        if (!Array.isArray(rawRows) || rawRows.length < 1 || rawRows.length > MERGE_MAX) {
          throw new PilotError("invalid_request", `rows must be an array of 1..${MERGE_MAX}`);
        }
        const source = body.source === undefined || body.source === null
          ? null
          : optString(body, "source", { max: 200 }) ?? null;

        const merged: string[] = [];
        const skipped: Array<{ external_id: string | null; reason: string }> = [];

        for (const raw of rawRows) {
          const rec = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
          const ext = typeof rec.external_id === "string" && rec.external_id.trim() !== ""
            ? rec.external_id.trim()
            : null;
          if (!ext) {
            skipped.push({ external_id: null, reason: "missing external_id" });
            continue;
          }
          const vec = rec.embedding as unknown;
          if (
            !Array.isArray(vec) ||
            vec.length !== VECTOR_DIM ||
            !vec.every((n) => typeof n === "number" && Number.isFinite(n))
          ) {
            skipped.push({
              external_id: ext,
              reason: `embedding must be ${VECTOR_DIM} finite numbers (got ${
                Array.isArray(vec) ? `${vec.length} values` : typeof vec
              })`,
            });
            continue;
          }
          const vector = JSON.stringify(vec);

          try {
            // 1. a queued row for this id, if one exists
            const st = await ctx.db
              .from("catalog_staging")
              .select("id,payload")
              .eq("tenant_id", tenantId)
              .eq("external_id", ext)
              .in("status", ["pending", "failed"])
              .order("created_at", { ascending: false })
              .limit(1);
            if (st.error) throw st.error;
            const stage = (st.data ?? [])[0];

            // 2. a product already carrying this id for this tenant
            const ex = await ctx.db
              .from("products")
              .select("id")
              .eq("tenant_id", tenantId)
              .eq("external_id", ext)
              .limit(1);
            if (ex.error) throw ex.error;
            const existing = (ex.data ?? [])[0];

            let productId = existing?.id as string | undefined;

            if (stage) {
              // staged payload passed the shared validator on upload, so the
              // columns below are present and well-formed by construction.
              const p = (stage.payload ?? {}) as Record<string, unknown>;
              const fields = {
                title: p.title as string,
                section: p.section as string,
                category: (p.category as string | null) ?? null,
                gender: (p.gender as string | null) ?? null,
                colors: Array.isArray(p.colors) ? (p.colors as string[]) : [],
                price: p.price === null || p.price === undefined ? null : Number(p.price),
                in_stock: p.in_stock !== false,
                product_url: (p.product_url as string | null) ?? null,
                image_url: (p.image_url as string | null) ?? null,
                attributes: (p.attributes as Record<string, unknown>) ?? {},
                status: p.status === "archived" ? "archived" : "active",
                embedding: vector,
                embedding_model: tenant.embedding_model,
                needs_reembed: false,
              };
              if (existing) {
                const up = await ctx.db
                  .from("products")
                  .update(fields)
                  .eq("id", existing.id)
                  .eq("tenant_id", tenantId) // SCOPING
                  .select("id");
                if (up.error) throw up.error;
              } else {
                const ins = await ctx.db
                  .from("products")
                  .insert({ tenant_id: tenantId, external_id: ext, source: "csv", ...fields })
                  .select("id");
                if (ins.error) throw ins.error;
                productId = (ins.data ?? [])[0]?.id;
              }

              const mark = await ctx.db
                .from("catalog_staging")
                .update({
                  status: "merged",
                  product_id: productId ?? null,
                  error: null,
                  merged_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                })
                .eq("id", stage.id)
                .eq("tenant_id", tenantId); // SCOPING
              if (mark.error) throw mark.error;
            } else if (existing) {
              // no queue entry: this is a needs_reembed (or re-upload) swap
              const up = await ctx.db
                .from("products")
                .update({
                  embedding: vector,
                  embedding_model: tenant.embedding_model,
                  needs_reembed: false,
                })
                .eq("id", existing.id)
                .eq("tenant_id", tenantId) // SCOPING
                .select("id");
              if (up.error) throw up.error;
            } else {
              skipped.push({
                external_id: ext,
                reason: "no queued row and no product with that external_id for this tenant",
              });
              continue;
            }

            merged.push(ext);
          } catch (e) {
            skipped.push({
              external_id: ext,
              reason: e instanceof Error ? e.message.slice(0, 200) : "database error",
            });
          }
        }

        // record the merge in the tenant's own history when a filename came in
        if (source) {
          const { error: runErr } = await ctx.db.from("ingestion_runs").insert({
            tenant_id: tenantId,
            status: "done",
            rows_total: rawRows.length,
            rows_ok: merged.length,
            rows_failed: skipped.length,
            finished_at: new Date().toISOString(),
            notes: `${source} (embeddings merged)`,
          });
          if (runErr) throw mapDbError(runErr, ctx.requestId, "ingestion_runs.insert");
        }

        return {
          body: {
            request_id: ctx.requestId,
            merged,
            skipped,
            counts: { submitted: rawRows.length, merged: merged.length, skipped: skipped.length },
            ...(source ? { source } : {}),
          },
        };
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
        "op must be one of: search, embeddings_merge, set_status",
      );
    },
  ),
);
