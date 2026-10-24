// functions/search — POST /v1/search
//
// Body:  {query (1..300 chars, required), section?, limit?, min_similarity?,
//         colors?, max_price?, in_stock_only?}
// Flow:  validate → auth (tenant from key only) → rate limit → embed the
//        query via the encoder (10 s + one retry) → search_products with the
//        TENANT's embedding_model and min_similarity (default from
//        tenants.settings) → response.
// Resp:  {request_id, items:[{section, similarity, product:{external_id,
//         title, price, product_url, image_url, colors, in_stock}}],
//         no_match:boolean}
// Honesty: no match = HTTP 200 + items:[] + no_match:true — never an error,
// never padded with weak results (plan §1.5; opposite of the consumer's
// findClosestItem fallback).

import { embedTexts } from "../_pilot/encoder.ts";
import { PilotError } from "../_pilot/errors.ts";
import { handle } from "../_pilot/http.ts";
import { readEnv } from "../_pilot/env.ts";
import { mapDbError } from "../_pilot/pgerror.ts";
import { isSection } from "../_pilot/sections.ts";
import {
  optBool,
  optColorList,
  optInt,
  optNumber,
  optString,
  readJsonObject,
} from "../_pilot/validation.ts";
import type { ProductRow } from "../_pilot/types.ts";

interface SearchBody {
  query: string;
  section?: string;
  limit: number;
  min_similarity: number;
  colors?: string[];
  max_price?: number;
  in_stock_only: boolean;
}

function parseBody(body: Record<string, unknown>, defaults: {
  limit: number; min_similarity: number;
}): SearchBody {
  const query = optString(body, "query", { required: true, min: 1, max: 300 })!;

  let section: string | undefined;
  if (body.section !== undefined && body.section !== null) {
    if (!isSection(body.section)) {
      throw new PilotError(
        "invalid_request",
        "field 'section' must be one of: top, bottom, dress, saree, blouse, dupatta, outerwear, footwear, bag, jewellery, accessory",
      );
    }
    section = body.section;
  }

  return {
    query,
    section,
    limit: optInt(body, "limit", { min: 1, max: 50, default: defaults.limit })!,
    min_similarity: optNumber(body, "min_similarity", {
      min: 0, max: 1, default: defaults.min_similarity,
    })!,
    colors: optColorList(body, "colors"),
    max_price: optNumber(body, "max_price", { min: 0 }),
    in_stock_only: optBool(body, "in_stock_only", true)!,
  };
}

Deno.serve((req) =>
  handle(req, readEnv(), { endpoint: "search", auth: true, methods: ["POST"] }, async (ctx) => {
    const auth = ctx.auth!;
    const parsed = parseBody(await readJsonObject(ctx.req), {
      limit: auth.settings.default_limit,
      min_similarity: auth.settings.min_similarity,
    });

    // --- embed the query (one text, one encoder call) ---------------------
    const tEmbed = performance.now();
    const { embeddings } = await embedTexts(ctx.env, [parsed.query], auth.tenantModel);
    ctx.timings.embed = performance.now() - tEmbed;

    // --- tenant-scoped search; tenant/model only from the resolved key ----
    const tSearch = performance.now();
    const { data, error } = await ctx.db.rpc("search_products", {
      p_tenant_id: auth.tenantId,
      p_query: JSON.stringify(embeddings[0]), // pgvector casts the text form
      p_embedding_model: auth.tenantModel,
      p_section: parsed.section ?? null,
      p_limit: parsed.limit,
      p_min_similarity: parsed.min_similarity,
      p_in_stock_only: parsed.in_stock_only,
      p_max_price: parsed.max_price ?? null,
      p_colors: parsed.colors ?? null,
    });
    ctx.timings.search = performance.now() - tSearch;
    if (error) throw mapDbError(error, ctx.requestId, "search_products");

    const rows = (data ?? []) as ProductRow[];
    const items = rows.map((row) => ({
      section: row.section,
      similarity: row.similarity ?? null,
      product: {
        external_id: row.external_id,
        title: row.title,
        price: row.price === null ? null : Number(row.price),
        product_url: row.product_url,
        image_url: row.image_url,
        colors: row.colors ?? [],
        in_stock: row.in_stock,
      },
    }));

    return {
      body: {
        request_id: ctx.requestId,
        items,
        no_match: items.length === 0,
      },
    };
  }),
);
