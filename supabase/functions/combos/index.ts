// functions/combos — POST /v1/combos  (recipe skeleton + LLM step, decision D2)
//
// Body:  {occasion (required), gender?, max_price?, colors?, style_notes?
//         (≤300), n_combos? (1..5, default 3), base_external_id?}
//
// Flow:  validate → auth → rate limit → recipe for the occasion (unknown →
//        422 unsupported_occasion listing the valid ones) → catalog_facets →
//        LLM (Groq, JSON mode, strict schema, one retry) OR deterministic
//        recipe fallback → ONE encoder call per ≤8 unique texts →
//        search_products per (combo, section) IN PARALLEL with filters →
//        greedy assembly, no product repeated within or across combos →
//        response with honest missing_sections.
//
// Resp:  {request_id, status:"ok"|"partial"|"no_match", occasion,
//         combos:[{id,title,items:[{section,similarity,product}],
//                  missing_sections:[...]}],
//         meta:{model, engine:"llm"|"recipe_fallback",
//               latency_ms:{llm,embed,search,total}}}
//        + Server-Timing header (llm, embed, search, total).
//
// What was ported from the consumer combo functions (plan §1.3/1.4) and what
// was not:
//   PORTED: the stage order (compose brief → LLM JSON-mode → validate →
//           embed → vector match → assemble), response_format json_object,
//           low temperature, PII-aware logging.
//   NOT ported: hardcoded occasions/blueprints (prompt-blueprints.ts),
//           CATEGORY_MAP sections (styling-helpers.ts), the "always return
//           the best raw match" fallback (findClosestItem), bare JSON.parse
//           with no schema validation, CORS "*", user-credit consumption,
//           waitUntil background jobs, outfit persistence.
//
// base_external_id anchors its section: the product is looked up in the
// tenant's catalog and pre-placed in EVERY combo's matching section
// (similarity: null — we did not match it, it is the given base). Other
// sections are searched around it. Documented exception to the cross-combo
// dedupe, see combos_core.assemble.

import { embedTexts, ENCODER_MAX_CHARS } from "../_pilot/encoder.ts";
import { assemble, chunkTexts, fallbackPlans, type ComboFacets, type ComboPlan } from "../_pilot/combos_core.ts";
import { PilotError } from "../_pilot/errors.ts";
import { handle } from "../_pilot/http.ts";
import { readEnv } from "../_pilot/env.ts";
import { chatJson } from "../_pilot/llm.ts";
import { logInfo, logWarn } from "../_pilot/logger.ts";
import { mapDbError } from "../_pilot/pgerror.ts";
import { getRecipe, listOccasions } from "../_pilot/recipes.ts";
import { normalizeOccasion } from "../_pilot/settings.ts";
import { isSection } from "../_pilot/sections.ts";
import {
  optColorList,
  optInt,
  optNumber,
  optString,
  readJsonObject,
} from "../_pilot/validation.ts";
import type { ProductRow } from "../_pilot/types.ts";

interface CombinationsBody {
  occasion: string;
  gender?: string;
  max_price?: number;
  colors?: string[];
  style_notes?: string;
  n_combos: number;
  base_external_id?: string;
}

const CANDIDATES_PER_SECTION = 3; // rows fetched per (combo, section) before dedupe

const SYSTEM_PROMPT = [
  "You are a fashion stylist for ONE online clothing brand.",
  "You ONLY describe products the brand actually sells, using the exact",
  "categories and colours given to you. You never invent brands, categories,",
  "colours or garments outside the provided catalogue vocabulary.",
  "Reply with STRICT JSON only — no prose, no markdown fences.",
  'Shape: {"combos":[{"title":"<=6 words","items":[{"section":"<given section>",',
  '"description":"<=180 chars naming ONE product of that section"}]}]}',
  "Every combo must contain EXACTLY the given sections (same set), one item",
  "each, and the colours/style must be coherent ACROSS each combo's items.",
].join(" ");

function parseCombinations(raw: unknown, recipeSections: string[], nCombos: number): ComboPlan[] {
  if (typeof raw !== "object" || raw === null) throw new Error("root not an object");
  const combos = (raw as { combos?: unknown }).combos;
  if (!Array.isArray(combos) || combos.length !== nCombos) {
    throw new Error(`expected exactly ${nCombos} combos`);
  }
  const wanted = new Set(recipeSections);
  return combos.map((c, i) => {
    if (typeof c !== "object" || c === null) throw new Error(`combo ${i} not an object`);
    const title = typeof (c as { title?: unknown }).title === "string"
      ? ((c as { title: string }).title.trim().slice(0, 80) || "suggested combo")
      : "suggested combo";
    const items = (c as { items?: unknown }).items;
    if (!Array.isArray(items) || items.length !== recipeSections.length) {
      throw new Error(`combo ${i} must have ${recipeSections.length} items`);
    }
    const seen = new Set<string>();
    const parsedItems = items.map((it) => {
      if (typeof it !== "object" || it === null) throw new Error(`combo ${i} item not an object`);
      const section = (it as { section?: unknown }).section;
      const description = (it as { description?: unknown }).description;
      if (!isSection(section) || !wanted.has(section) || seen.has(section)) {
        throw new Error(`combo ${i} has an invalid or duplicate section`);
      }
      if (typeof description !== "string" || description.trim().length < 3 ||
          description.length > ENCODER_MAX_CHARS) {
        throw new Error(`combo ${i} section ${section}: bad description`);
      }
      seen.add(section);
      return { section, description: description.trim() };
    });
    // Same section set as the recipe (order may differ).
    if (seen.size !== wanted.size) throw new Error(`combo ${i} section set mismatch`);
    return { title, items: parsedItems };
  });
}

Deno.serve((req) =>
  handle(req, readEnv(), { endpoint: "combos", auth: true, methods: ["POST"] }, async (ctx) => {
    const t0 = performance.now();
    const auth = ctx.auth!;
    const body = await readJsonObject(ctx.req);

    // ---- 1. validate ------------------------------------------------------
    const occasionRaw = optString(body, "occasion", { required: true, min: 1, max: 60 })!;
    const parsed: CombinationsBody = {
      occasion: occasionRaw,
      gender: optString(body, "gender", { values: ["female", "male", "unisex"] }),
      max_price: optNumber(body, "max_price", { min: 0 }),
      colors: optColorList(body, "colors"),
      style_notes: optString(body, "style_notes", { max: 300 }),
      n_combos: optInt(body, "n_combos", { min: 1, max: 5, default: 3 })!,
      base_external_id: optString(body, "base_external_id", { max: 120 }),
    };

    // ---- 2. recipe for the occasion (server-owned list) -------------------
    const recipe = getRecipe(auth.settings, parsed.occasion);
    if (!recipe) {
      const valid = listOccasions(auth.settings).map((o) => o.occasion);
      throw new PilotError(
        "unsupported_occasion",
        `unknown occasion '${normalizeOccasion(parsed.occasion)}' — ` +
          (valid.length ? `valid occasions: ${valid.join(", ")}` : "this tenant has no occasions configured"),
      );
    }
    const occasion = normalizeOccasion(parsed.occasion);

    // ---- 3. catalogue facets (what the brand actually sells) --------------
    const tFacets = performance.now();
    const { data: facetRows, error: facetErr } = await ctx.db.rpc("catalog_facets", {
      p_tenant_id: auth.tenantId,
    });
    if (facetErr) throw mapDbError(facetErr, ctx.requestId, "catalog_facets");
    const facets = new Map<string, ComboFacets>();
    for (const row of (facetRows ?? []) as ComboFacets[]) {
      facets.set(row.section, {
        section: row.section,
        categories: row.categories ?? [],
        colors: row.colors ?? [],
      });
    }
    ctx.timings.facets = performance.now() - tFacets;

    // ---- 3b. optional anchor product --------------------------------------
    let anchor: { section: string; product: ProductRow } | null = null;
    if (parsed.base_external_id) {
      const { data: anchorRows, error: anchorErr } = await ctx.db.rpc("product_by_external_id", {
        p_tenant_id: auth.tenantId,
        p_external_id: parsed.base_external_id,
      });
      if (anchorErr) throw mapDbError(anchorErr, ctx.requestId, "product_by_external_id");
      const row = (anchorRows ?? [])[0] as ProductRow | undefined;
      if (row && recipe.includes(row.section)) {
        anchor = { section: row.section, product: row };
      } else if (row) {
        logWarn("combos: anchor section not in recipe — ignoring anchor", {
          request_id: ctx.requestId, anchor_section: row.section,
        });
      } else {
        logInfo("combos: base_external_id not found — continuing without anchor", {
          request_id: ctx.requestId,
        });
      }
    }

    // ---- 4. LLM step (or deterministic recipe fallback) -------------------
    let engine: "llm" | "recipe_fallback" = "llm";
    let plans: ComboPlan[] | null = null;
    let llmMs = 0;

    const tLlm = performance.now();
    if (!ctx.env.GROQ_API_KEY) {
      engine = "recipe_fallback";
      logInfo("combos: GROQ_API_KEY missing — using recipe fallback", { request_id: ctx.requestId });
    } else {
      try {
        const constraints = [
          `Occasion: ${occasion}`,
          `Sections (exact): ${recipe.join(", ")}`,
          `Number of combos: ${parsed.n_combos}`,
          parsed.gender ? `Gender: ${parsed.gender}` : null,
          parsed.max_price !== undefined ? `Max price: ${parsed.max_price}` : null,
          parsed.colors?.length ? `Preferred colours: ${parsed.colors.join(", ")}` : null,
          parsed.style_notes ? `Style notes: ${parsed.style_notes}` : null,
          anchor ? `Base garment in section "${anchor.section}": ${anchor.product.title} — build each combo around it.` : null,
        ].filter(Boolean).join("\n");
        const facetLines = recipe.map((section) => {
          const f = facets.get(section);
          return `"${section}": categories=[${(f?.categories ?? []).join(", ")}] ` +
            `colours=[${(f?.colors ?? []).join(", ")}]`;
        }).join("\n");

        const res = await chatJson<ComboPlan[]>(ctx.env, {
          system: SYSTEM_PROMPT,
          user: `${constraints}\n\nCatalogue vocabulary per section (use ONLY these):\n${facetLines}`,
          validate: (llmRoot) => parseCombinations(llmRoot, recipe, parsed.n_combos),
        });
        plans = res.data;
      } catch (e) {
        engine = "recipe_fallback";
        logWarn("combos: LLM step failed — falling back to recipe engine", {
          request_id: ctx.requestId,
          reason: e instanceof PilotError ? e.code : "validation",
        });
      }
    }
    llmMs = performance.now() - tLlm;
    ctx.timings.llm = llmMs;

    if (plans === null) {
      plans = fallbackPlans(recipe, facets, parsed.n_combos, { colors: parsed.colors });
    }

    // ---- 5. ONE encoder batch per ≤8 unique texts -------------------------
    const wantedTexts = plans.flatMap((p) => p.items.map((i) => i.description));
    const uniqueTexts = [...new Set(wantedTexts)];
    const tEmbed = performance.now();
    const vectorByText = new Map<string, number[]>();
    for (const batch of chunkTexts(uniqueTexts, 8)) {
      const res = await embedTexts(ctx.env, batch, auth.tenantModel);
      batch.forEach((text, i) => vectorByText.set(text, res.embeddings[i]));
    }
    ctx.timings.embed = performance.now() - tEmbed;

    // ---- 6. search per (combo, section) IN PARALLEL -----------------------
    const tSearch = performance.now();
    // PostgREST builders are PromiseLike (not Promise) — Promise.all accepts
    // both, so the list is typed as thenables.
    const searchJobs: PromiseLike<void>[] = [];
    const candidates = new Map<string, ProductRow[]>();
    plans.forEach((plan, comboIndex) => {
      plan.items.forEach((item) => {
        if (anchor && anchor.section === item.section) return; // anchored
        const vector = vectorByText.get(item.description);
        if (!vector) return; // impossible (built from the same list) — guard anyway
        const job = ctx.db.rpc("search_products", {
          p_tenant_id: auth.tenantId,
          p_query: JSON.stringify(vector),
          p_embedding_model: auth.tenantModel,
          p_section: item.section,
          p_limit: CANDIDATES_PER_SECTION,
          p_min_similarity: auth.settings.min_similarity,
          p_in_stock_only: true,
          p_max_price: parsed.max_price ?? null,
          p_colors: parsed.colors ?? null,
        }).then(({ data, error }) => {
          if (error) {
            logWarn("combos: section search failed", {
              request_id: ctx.requestId, section: item.section, pg_code: error.code ?? null,
            });
            return; // section stays missing — never fill with junk
          }
          candidates.set(`${comboIndex}:${item.section}`, (data ?? []) as ProductRow[]);
        });
        searchJobs.push(job);
      });
    });
    await Promise.all(searchJobs);
    ctx.timings.search = performance.now() - tSearch;

    // ---- 7. assemble (dedupe + honest missing sections) -------------------
    const assembled = assemble(plans, candidates, anchor);

    ctx.timings.total = Math.round(performance.now() - t0);
    return {
      body: {
        request_id: ctx.requestId,
        status: assembled.status,
        occasion,
        combos: assembled.combos.map((c) => ({
          id: c.id,
          title: c.title,
          items: c.items.map((it) => ({
            section: it.section,
            similarity: it.similarity,
            product: {
              external_id: it.product.external_id,
              title: it.product.title,
              price: it.product.price === null ? null : Number(it.product.price),
              product_url: it.product.product_url,
              image_url: it.product.image_url,
              colors: it.product.colors ?? [],
              in_stock: it.product.in_stock,
            },
          })),
          missing_sections: c.missing_sections,
        })),
        meta: {
          model: auth.tenantModel,
          engine,
          latency_ms: {
            llm: Math.round(llmMs),
            embed: Math.round(ctx.timings.embed),
            search: Math.round(ctx.timings.search),
            total: ctx.timings.total,
          },
        },
      },
    };
  }),
);
