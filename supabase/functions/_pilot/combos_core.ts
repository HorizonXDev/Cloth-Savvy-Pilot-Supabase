// _pilot/combos_core.ts — pure combo assembly logic (unit-tested in Deno).
//
// Responsibilities: chunking texts for the encoder's ≤8-text batches,
// the deterministic recipe-fallback plan, greedy product de-duplication
// (no product repeated within a combo OR across combos, with one documented
// exception: an anchor base product fills its section in every combo), and
// the overall response status.
//
// Honesty rules (plan §1.5 / §2-S14): a section that clears no threshold is
// reported in `missing_sections` — NEVER filled with a weak or wrong-section
// product. This is the deliberate opposite of the consumer's
// findClosestItem() "always return the best raw match" behaviour.

import type { ProductRow } from "./types.ts";

export interface ComboFacets {
  section: string;
  categories: string[];
  colors: string[];
}

export interface ComboPlanItem {
  section: string;
  description: string; // ≤300 chars, produced by the LLM or the fallback
}
export interface ComboPlan {
  title: string;
  items: ComboPlanItem[];
}

/** The encoder accepts 1–8 texts per call → chunk the (combo × section)
 * description list into batches of ≤8. */
export function chunkTexts(texts: string[], size = 8): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < texts.length; i += size) out.push(texts.slice(i, i + size));
  return out;
}

/** Deterministic recipe-fallback text for one section: label + the tenant's
 * real facet vocabulary (so the embedding carries the brand's actual
 * categories and colours, not invented ones). ≤300 chars by construction. */
export function fallbackText(
  section: string,
  facets: ComboFacets | undefined,
  pref: { colors?: string[] },
): string {
  const parts: string[] = [section];
  const colors = (pref.colors && pref.colors.length > 0 ? pref.colors : (facets?.colors ?? [])).slice(0, 3);
  const cats = (facets?.categories ?? []).slice(0, 3);
  if (cats.length > 0) parts.push(cats.join(", "));
  if (colors.length > 0) parts.push("in " + colors.join(", "));
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text.length > 300 ? text.slice(0, 300) : text;
}

/** n_combos identical deterministic plans (dedupe below differentiates the
 * products each combo receives, by similarity order). */
export function fallbackPlans(
  sections: string[],
  facetsBySection: Map<string, ComboFacets>,
  nCombos: number,
  pref: { colors?: string[] },
): ComboPlan[] {
  const items = sections.map((section) => ({
    section,
    description: fallbackText(section, facetsBySection.get(section), pref),
  }));
  return Array.from({ length: nCombos }, () => ({
    title: "suggested combo",
    items: items.map((i) => ({ ...i })),
  }));
}

export interface AssembledCombo {
  id: string;
  title: string;
  items: { section: string; similarity: number | null; product: ProductRow }[];
  missing_sections: string[];
}

export interface SearchResult {
  combos: AssembledCombo[];
  status: "ok" | "partial" | "no_match";
}

/** Greedy fill in (combo, section) plan order: each (combo, section) picks
 * its most similar candidate not already used inside this combo or in any
 * other combo. `anchor` (optional) is pre-placed into its section in EVERY
 * combo — the one documented exception to cross-combo dedupe, because the
 * point of base_external_id is "build around this garment". */
export function assemble(
  plans: ComboPlan[],
  candidates: Map<string, ProductRow[]>, // "comboIndex:section" -> rows (sorted by similarity desc)
  anchor: { section: string; product: ProductRow } | null,
): SearchResult {
  const usedExternalIds = new Set<string>();
  const combos: AssembledCombo[] = [];

  plans.forEach((plan, comboIndex) => {
    const itemsInCombo: AssembledCombo["items"] = [];
    const usedInCombo = new Set<string>();

    for (const planned of plan.items) {
      // Anchor pre-placement (documented exception to cross-combo dedupe).
      if (anchor && anchor.section === planned.section) {
        if (!usedInCombo.has(anchor.product.external_id)) {
          itemsInCombo.push({ section: planned.section, similarity: null, product: anchor.product });
          usedInCombo.add(anchor.product.external_id);
          usedExternalIds.add(anchor.product.external_id);
        }
        continue; // never search this section: the anchor owns it
      }

      const rows = candidates.get(`${comboIndex}:${planned.section}`) ?? [];
      const chosen = rows.find((r) => !usedInCombo.has(r.external_id) && !usedExternalIds.has(r.external_id));
      if (chosen) {
        itemsInCombo.push({ section: planned.section, similarity: chosen.similarity ?? null, product: chosen });
        usedInCombo.add(chosen.external_id);
        usedExternalIds.add(chosen.external_id);
      }
      // else: no product clears the threshold (or all are used) -> missing.
    }

    const plannedSections = new Set(plan.items.map((i) => i.section));
    const present = new Set(itemsInCombo.map((i) => i.section));
    const missing = [...plannedSections].filter((s) => !present.has(s));

    combos.push({
      id: `c${comboIndex + 1}`,
      title: plan.title,
      items: itemsInCombo,
      missing_sections: missing,
    });
  });

  const anyItems = combos.some((c) => c.items.length > 0);
  const allComplete = combos.length > 0 && combos.every((c) => c.missing_sections.length === 0);
  const status: SearchResult["status"] = allComplete ? "ok" : anyItems ? "partial" : "no_match";
  return { combos, status };
}
