// _pilot/recipes.ts — occasion → sections lookup (pure, unit-tested).
//
// The server OWNS the occasion list: it is exactly the tenant's `combos` keys
// (validated by settings.ts). No occasion is hardcoded anywhere in this API
// layer — the consumer app's three hardcoded occasion lists
// (create_occasion.dart, prompt-blueprints.ts, USAGE_BY_BLUEPRINT) are
// deliberately not inherited.

import { normalizeOccasion } from "./settings.ts";
import type { TenantSettings } from "./types.ts";

export interface OccasionRecipe {
  occasion: string;
  sections: string[];
}

/** Every occasion the tenant has a recipe for, sorted for stable output. */
export function listOccasions(settings: TenantSettings): OccasionRecipe[] {
  return Object.entries(settings.combos)
    .map(([occasion, sections]) => ({ occasion, sections: [...sections] }))
    .sort((a, b) => a.occasion.localeCompare(b.occasion));
}

/** Recipe for one occasion (input is normalized first), or null when the
 * tenant has no recipe for it → the endpoint answers 422
 * unsupported_occasion listing the valid ones. */
export function getRecipe(settings: TenantSettings, occasionRaw: string): string[] | null {
  const key = normalizeOccasion(occasionRaw);
  const sections = settings.combos[key];
  return sections ? [...sections] : null;
}
