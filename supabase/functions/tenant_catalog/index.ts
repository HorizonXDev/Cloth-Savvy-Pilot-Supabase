// functions/tenant_catalog — the TENANT's catalog: browse AND mutate.
//
//   GET  ?op=products[&section=&status=&q=&page=&page_size=]
//        paginated browse of THE SESSION'S TENANT's products
//   GET  ?op=runs              recent ingestion_runs of the session's tenant
//   GET  ?op=staging[&status=&limit=]
//        the import queue: rows this tenant uploaded, waiting for the owner's
//        embedding pipeline (pending / failed / merged)
//
//   POST {op:"stage_start",   rows_total, source_file?}     -> open a run
//        {op:"stage_batch",   run_id, rows[1..50], source_file?}
//        {op:"stage_finish",  run_id, status:"done"|"failed", notes?}
//        {op:"stage_update",  stage_id, <row fields>}       -> fix a queued row
//        {op:"stage_delete",  stage_id}                     -> drop a queued row
//        {op:"product_update", product_id, <row fields>}    -> edit a live product
//        {op:"product_delete", product_id}                  -> remove a live product
//
// OWNERSHIP DECISION (2026-10-26): catalog mutation belongs to the tenant.
// Upload / edit / archive / delete all happen HERE; the admin dashboard keeps
// oversight (it can read everything) but no longer uploads. The owner's step
// starts after staging: they export the id->url table from the admin
// dashboard, run their FashionCLIP image pipeline over it (Colab), and upload
// the generated vectors back — applied BY ID to these rows.
//
//   CSV upload   -> catalog_staging (pending, no vector yet)
//   owner merges -> products (IMAGE vector, applied by external_id)
//   text edits NEVER produce vectors: title / category / colours / section /
//   price are FILTERS ONLY. Changing image_url flags needs_reembed so the row
//   appears in the owner's next export instead of keeping a stale vector.
//
// SEPARATION: the tenant_id is the SESSION's — never a query parameter, never
// a body field (T15 at the portal layer). There is no admin code path here:
// no tenant create/suspend/drop, no cross-tenant read, no admin credential
// accepted. A body that carries tenant_id is ignored like any unknown field.
//
// Auth: portal session. Portal traffic is NOT metered (browsing your own
// catalogue must not consume API quota).

import { readEnv } from "../_pilot/env.ts";
import { PilotError } from "../_pilot/errors.ts";
import { handle } from "../_pilot/http.ts";
import { parseImportRow, type ParsedRow } from "../_pilot/import_row.ts";
import { mapDbError } from "../_pilot/pgerror.ts";
import { ALLOWED_SECTIONS, isSection } from "../_pilot/sections.ts";
import { optInt, optString, readJsonObject } from "../_pilot/validation.ts";

// Bulk body cap: staging batches carry up to 50 catalog rows (titles, urls,
// colours, attributes ≈ up to ~1 MB worst case). The default 32 KB guard in
// validation.ts would reject a full batch of wide rows.
const MAX_BODY_BYTES = 1024 * 1024;
import { resolvePortalSession, tenantOrigins } from "../_tenant/tenant.ts";

const PRODUCT_COLUMNS =
  "id,external_id,title,section,category,gender,colors,price,in_stock,product_url,image_url,status,source,attributes,needs_reembed,created_at,updated_at";
const STAGING_COLUMNS =
  "id,external_id,payload,status,error,source_file,run_id,product_id,created_at,updated_at,merged_at";
const STAGE_BATCH_MAX = 50;

function escapeIlike(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

function reqUuid(v: unknown, field: string): string {
  if (
    typeof v !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  ) {
    throw new PilotError("invalid_request", `${field} must be a UUID`);
  }
  return v;
}

/** Message for a per-row Postgres failure (never the raw SQL). */
function rowErrorReason(err: { code?: string; message?: string } | null): string {
  const code = err?.code ?? "";
  if (code === "23505") return "duplicate external_id — already queued or already live";
  if (code === "23514") return "rejected by a database constraint (section / status / model)";
  return "database rejected the row";
}

/** The validated row as it is stored in catalog_staging.payload. */
function payloadOf(r: ParsedRow): Record<string, unknown> {
  return {
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
    status: r.status,
  };
}

Deno.serve((req) =>
  handle(
    req,
    readEnv(),
    {
      endpoint: "tenant.catalog",
      auth: false,
      methods: ["GET", "POST"],
      corsOrigins: tenantOrigins(readEnv()),
    },
    async (ctx) => {
      const session = await resolvePortalSession(ctx.req, ctx.db, ctx.requestId);

      // ================================================================== GET
      if (ctx.req.method === "GET") {
        const url = new URL(ctx.req.url);
        const op = url.searchParams.get("op") ?? "products";

        if (op === "runs") {
          const { data, error } = await ctx.db
            .from("ingestion_runs")
            .select("id,status,rows_total,rows_ok,rows_failed,started_at,finished_at,notes")
            .eq("tenant_id", session.tenantId)
            .order("started_at", { ascending: false })
            .limit(50);
          if (error) throw mapDbError(error, ctx.requestId, "ingestion_runs.list");
          return { body: { request_id: ctx.requestId, runs: data ?? [] } };
        }

        if (op === "staging") {
          const status = url.searchParams.get("status");
          if (status && !["pending", "failed", "merged"].includes(status)) {
            throw new PilotError("invalid_request", "status must be pending, failed or merged");
          }
          const limit = optInt(
            { limit: Number(url.searchParams.get("limit") ?? "100") },
            "limit",
            { min: 1, max: 500 },
          )!;
          let q = ctx.db
            .from("catalog_staging")
            .select(STAGING_COLUMNS, { count: "exact" })
            .eq("tenant_id", session.tenantId);
          if (status) q = q.eq("status", status);
          const { data, error, count } = await q
            .order("created_at", { ascending: false })
            .limit(limit);
          if (error) throw mapDbError(error, ctx.requestId, "catalog_staging.list");
          return {
            body: { request_id: ctx.requestId, rows: data ?? [], total: count ?? 0 },
          };
        }

        if (op !== "products") {
          throw new PilotError("invalid_request", "op must be one of: products, runs, staging");
        }

        const page = optInt({ page: Number(url.searchParams.get("page") ?? "0") }, "page", {
          min: 0,
          max: 100000,
        })!;
        const pageSize = optInt({ page_size: Number(url.searchParams.get("page_size") ?? "25") }, "page_size", {
          min: 1,
          max: 100,
        })!;
        const section = url.searchParams.get("section");
        const status = url.searchParams.get("status");
        const q = url.searchParams.get("q");

        let query = ctx.db
          .from("products")
          .select(PRODUCT_COLUMNS, { count: "exact" })
          .eq("tenant_id", session.tenantId); // SCOPING: session tenant only
        if (section) {
          if (!isSection(section)) {
            throw new PilotError(
              "invalid_request",
              `section must be one of: ${ALLOWED_SECTIONS.join(", ")}`,
            );
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

      // ================================================================= POST
      const body = await readJsonObject(ctx.req, MAX_BODY_BYTES);
      const op = optString(body, "op", { required: true, max: 40 })!;
      const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
      // Validate a candidate row with THE shared rules; messages carry no
      // "row N" prefix here because these are single-row operations.
      const validate = (raw: unknown): ParsedRow =>
        parseImportRow(raw, 0, (why) => {
          throw new PilotError("invalid_request", why);
        });

      // ---------------------------------------------------- staging: upload
      if (op === "stage_start") {
        const rowsTotal = optInt(body, "rows_total", { required: true, min: 1, max: 1000000 })!;
        const sourceFile = has("source_file")
          ? optString(body, "source_file", { max: 200 }) ?? null
          : null;
        const notes = has("notes") ? optString(body, "notes", { max: 1000 }) ?? null : null;
        const { data: run, error } = await ctx.db
          .from("ingestion_runs")
          .insert({
            tenant_id: session.tenantId,
            status: "running",
            rows_total: rowsTotal,
            notes: notes ?? sourceFile,
          })
          .select("id,status,rows_total,rows_ok,rows_failed,started_at,finished_at,notes")
          .single();
        if (error) throw mapDbError(error, ctx.requestId, "ingestion_runs.insert");
        return { status: 201, body: { request_id: ctx.requestId, run } };
      }

      if (op === "stage_batch") {
        const runId = reqUuid(body.run_id, "run_id");
        const rawRows = body.rows;
        if (!Array.isArray(rawRows) || rawRows.length < 1 || rawRows.length > STAGE_BATCH_MAX) {
          throw new PilotError("invalid_request", `rows must be an array of 1..${STAGE_BATCH_MAX} rows`);
        }
        const sourceFile = has("source_file")
          ? optString(body, "source_file", { max: 200 }) ?? null
          : null;

        const { data: run, error: runErr } = await ctx.db
          .from("ingestion_runs")
          .select("id,status")
          .eq("id", runId)
          .eq("tenant_id", session.tenantId) // SCOPING
          .maybeSingle();
        if (runErr) throw mapDbError(runErr, ctx.requestId, "ingestion_runs.select");
        if (!run) throw new PilotError("invalid_request", "no upload run with that id for this tenant");
        if (run.status !== "running") {
          throw new PilotError("invalid_request", `run is '${run.status}', not 'running' — start a new upload`);
        }

        // 1. validate every row with the shared rules; failures collected
        const failed: Array<{ index: number; external_id: string | null; reason: string }> = [];
        const valid: Array<{ i: number; row: ParsedRow }> = [];
        rawRows.forEach((raw, i) => {
          try {
            valid.push({
              i,
              row: parseImportRow(raw, i, (why) => {
                throw new PilotError("invalid_request", `row ${i}: ${why}`);
              }),
            });
          } catch (e) {
            const reason = e instanceof PilotError ? e.message : "row could not be parsed";
            const ext =
              typeof raw === "object" && raw !== null && typeof (raw as Record<string, unknown>).external_id === "string"
                ? (raw as Record<string, unknown>).external_id as string
                : null;
            failed.push({ index: i, external_id: ext, reason });
          }
        });

        // 2. queue them — NO embedding here: the owner's pipeline does that
        let ok = 0;
        for (const { i, row } of valid) {
          const { error: insErr } = await ctx.db.from("catalog_staging").insert({
            tenant_id: session.tenantId,
            external_id: row.external_id,
            payload: payloadOf(row),
            status: "pending",
            source_file: sourceFile,
            run_id: runId,
          });
          if (insErr) {
            failed.push({ index: i, external_id: row.external_id, reason: rowErrorReason(insErr) });
          } else ok++;
        }

        return {
          body: {
            request_id: ctx.requestId,
            batch: { ok, failed: failed.length },
            failed,
          },
        };
      }

      if (op === "stage_finish") {
        const runId = reqUuid(body.run_id, "run_id");
        const status = optString(body, "status", { required: true, values: ["done", "failed"] })!;
        const notes = has("notes") ? optString(body, "notes", { max: 1000 }) ?? null : null;

        const { data: run, error: runErr } = await ctx.db
          .from("ingestion_runs")
          .select("id,status,rows_total")
          .eq("id", runId)
          .eq("tenant_id", session.tenantId)
          .maybeSingle();
        if (runErr) throw mapDbError(runErr, ctx.requestId, "ingestion_runs.select");
        if (!run) throw new PilotError("invalid_request", "no upload run with that id for this tenant");
        if (run.status !== "running") {
          throw new PilotError("invalid_request", `run is '${run.status}', not 'running'`);
        }

        // counters describe what actually reached the QUEUE (not products —
        // merging is the pipeline's job and is tracked per row in staging)
        const { count: queued, error: cntErr } = await ctx.db
          .from("catalog_staging")
          .select("id", { count: "exact", head: true })
          .eq("run_id", runId)
          .eq("tenant_id", session.tenantId);
        if (cntErr) throw mapDbError(cntErr, ctx.requestId, "catalog_staging.count");
        const queuedCount = queued ?? 0;

        const { data: updated, error } = await ctx.db
          .from("ingestion_runs")
          .update({
            status,
            finished_at: new Date().toISOString(),
            rows_ok: queuedCount,
            rows_failed: Math.max(0, run.rows_total - queuedCount),
            ...(notes ? { notes } : {}),
          })
          .eq("id", runId)
          .eq("tenant_id", session.tenantId)
          .select("id,status,rows_total,rows_ok,rows_failed,started_at,finished_at,notes")
          .single();
        if (error) throw mapDbError(error, ctx.requestId, "ingestion_runs.finish");
        return { body: { request_id: ctx.requestId, run: updated } };
      }

      if (op === "stage_update" || op === "stage_delete") {
        const stageId = reqUuid(body.stage_id, "stage_id");
        const { data: existing, error: exErr } = await ctx.db
          .from("catalog_staging")
          .select(`${STAGING_COLUMNS}`)
          .eq("id", stageId)
          .eq("tenant_id", session.tenantId) // SCOPING
          .maybeSingle();
        if (exErr) throw mapDbError(exErr, ctx.requestId, "catalog_staging.select");
        if (!existing) throw new PilotError("invalid_request", "no queued row with that id for this tenant");

        if (op === "stage_delete") {
          if (existing.status === "merged") {
            throw new PilotError(
              "invalid_request",
              "that row was already merged — delete the product itself instead",
            );
          }
          const { error } = await ctx.db
            .from("catalog_staging")
            .delete()
            .eq("id", stageId)
            .eq("tenant_id", session.tenantId);
          if (error) throw mapDbError(error, ctx.requestId, "catalog_staging.delete");
          return { body: { request_id: ctx.requestId, deleted: true } };
        }

        if (existing.status === "merged") {
          throw new PilotError("invalid_request", "a merged row cannot be edited — edit the product instead");
        }

        // merge the current payload with the changed fields, revalidate the
        // WHOLE row (the CHECK on the table requires all three keys present)
        const current = existing.payload as Record<string, unknown>;
        const candidate: Record<string, unknown> = { ...current };
        for (const k of [
          "title", "section", "category", "gender", "colors", "price",
          "in_stock", "product_url", "image_url", "status",
        ]) {
          if (has(k)) candidate[k] = body[k];
        }
        candidate.external_id = existing.external_id; // immutable once queued
        const parsed = validate(candidate);

        const { data: row, error } = await ctx.db
          .from("catalog_staging")
          .update({
            payload: payloadOf(parsed),
            status: "pending", // a fixed row re-enters the queue
            error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", stageId)
          .eq("tenant_id", session.tenantId)
          .select(STAGING_COLUMNS)
          .single();
        if (error) throw mapDbError(error, ctx.requestId, "catalog_staging.update");
        return { body: { request_id: ctx.requestId, row } };
      }

      // ---------------------------------------------------- live products
      if (op === "product_update" || op === "product_delete") {
        const productId = reqUuid(body.product_id, "product_id");
        // SCOPING: every one of these queries is bound to the session tenant —
        // a product id belonging to another tenant simply does not match.
        const { data: current, error: curErr } = await ctx.db
          .from("products")
          .select(PRODUCT_COLUMNS)
          .eq("id", productId)
          .eq("tenant_id", session.tenantId)
          .maybeSingle();
        if (curErr) throw mapDbError(curErr, ctx.requestId, "products.select");
        if (!current) throw new PilotError("invalid_request", "no product with that id for this tenant");

        if (op === "product_delete") {
          const { error } = await ctx.db
            .from("products")
            .delete()
            .eq("id", productId)
            .eq("tenant_id", session.tenantId);
          if (error) throw mapDbError(error, ctx.requestId, "products.delete");
          return { body: { request_id: ctx.requestId, deleted: true, external_id: current.external_id } };
        }

        // Build the candidate from the EXISTING row + the provided fields, so
        // one validator covers both the CSV path and this one.
        const candidate: Record<string, unknown> = {
          external_id: current.external_id,
          title: current.title,
          section: current.section,
          category: current.category,
          gender: current.gender,
          colors: current.colors ?? [],
          price: current.price === null || current.price === undefined ? null : Number(current.price),
          in_stock: current.in_stock,
          product_url: current.product_url,
          image_url: current.image_url,
          attributes: current.attributes ?? {},
          status: current.status,
        };
        for (const k of [
          "title", "section", "category", "gender", "colors", "price",
          "in_stock", "product_url", "image_url", "status", "attributes",
        ]) {
          if (has(k)) candidate[k] = body[k];
        }
        const parsed = validate(candidate);

        // Vectors are IMAGE-derived (owner decision): a text edit must NOT
        // touch the vector — it only changes what rows the SQL filters match.
        // An image change DOES invalidate the stored vector, so the row is
        // flagged and rides into the owner's export until new vectors arrive
        // (admin_catalog ?op=embed_export), rather than matching silently on
        // a picture it no longer looks like.
        const imageChanged = parsed.image_url !== (current.image_url ?? null);
        const needsReembed = imageChanged || current.needs_reembed === true;

        const { data: product, error } = await ctx.db
          .from("products")
          .update({
            title: parsed.title,
            section: parsed.section,
            category: parsed.category,
            gender: parsed.gender,
            colors: parsed.colors,
            price: parsed.price,
            in_stock: parsed.in_stock,
            product_url: parsed.product_url,
            image_url: parsed.image_url,
            attributes: parsed.attributes,
            status: parsed.status,
            embedding_model: session.tenantModel, // products_guard enforces this
            needs_reembed: needsReembed,
          })
          .eq("id", productId)
          .eq("tenant_id", session.tenantId)
          .select(PRODUCT_COLUMNS)
          .single();
        if (error) throw mapDbError(error, ctx.requestId, "products.update");
        return {
          body: {
            request_id: ctx.requestId,
            product,
            needs_reembed: needsReembed,
            image_changed: imageChanged,
          },
        };
      }

      throw new PilotError(
        "invalid_request",
        "op must be one of: stage_start, stage_batch, stage_finish, stage_update, stage_delete, product_update, product_delete",
      );
    },
  ),
);
