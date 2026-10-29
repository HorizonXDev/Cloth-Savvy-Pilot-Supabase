// _pilot/settings.ts — tenants.settings reader + validator (pure,
// unit-tested). The JSON shape is documented in docs/settings.md.
//
// Shape (all keys optional; every bad value falls back to its default and is
// reported in `issues` so the caller can log it — a broken settings row must
// never 500 a request):
//
//   {
//     "currency": "INR",                       // string, <= 8 chars
//     "min_similarity": 0.25,                  // 0..1
//     "default_limit": 10,                     // int 1..50
//     "rate_limit_per_min": 60,                // int 1..10000
//     "vton_rate_limit_per_min": 3,            // int 1..1000 (GPU route)
//     "vton_monthly_cap": 100,                 // int 0..100000 (0 = off)
//     "combos": {                              // occasion -> ordered sections
//       "wedding": ["saree", "blouse", "jewellery"],
//       "office":  ["top", "bottom", "accessory"]
//     }
//   }
//
// Documented defaults (used when a key is absent or invalid):
//   currency          null          (unknown — responses omit it)
//   min_similarity    0.25
//   default_limit     10
//   rate_limit_per_min 60           (decision D4)
//   vton_rate_limit_per_min 3       (P0-3: try-on is the only GPU route)
//   vton_monthly_cap 100            (P0-3: per UTC month, 0 = no cap)
//   combos            DEMO_DEFAULT_COMBOS below — a small GENERIC occasion
//                     list that works for any brand (no saree/kurta
//                     assumption). Real tenants must set their own recipes
//                     (examples in docs/settings.md and README).

import { isSection } from "./sections.ts";
import type { TenantSettings } from "./types.ts";

export const DEFAULT_MIN_SIMILARITY = 0.25;
export const DEFAULT_LIMIT = 10;
export const DEFAULT_RATE_LIMIT_PER_MIN = 60;
// P0-3 — `/vton` runs GPU work, so it gets its own much tighter window and a
// monthly ceiling. Both are per tenant settings; these are the documented
// defaults used when a tenant has not set them.
export const DEFAULT_VTON_RATE_LIMIT_PER_MIN = 3;
export const DEFAULT_VTON_MONTHLY_CAP = 100;
export const MAX_OCCASIONS = 50;
export const MAX_SECTIONS_PER_RECIPE = 8; // = one encoder batch of section labels

export const DEMO_DEFAULT_COMBOS: Record<string, string[]> = {
  casual: ["top", "bottom", "footwear"],
  office: ["top", "bottom", "accessory"],
  festive: ["dress", "jewellery", "bag"],
};

/** Occasion keys are compared trimmed + lowercase + spaces/dashes → "_". */
export function normalizeOccasion(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export interface ParsedSettings {
  settings: TenantSettings;
  issues: string[]; // human-readable; caller logs them, never returns them
}

export function parseTenantSettings(raw: unknown): ParsedSettings {
  const issues: string[] = [];
  const out: TenantSettings = {
    currency: null,
    min_similarity: DEFAULT_MIN_SIMILARITY,
    default_limit: DEFAULT_LIMIT,
    rate_limit_per_min: DEFAULT_RATE_LIMIT_PER_MIN,
    vton_rate_limit_per_min: DEFAULT_VTON_RATE_LIMIT_PER_MIN,
    vton_monthly_cap: DEFAULT_VTON_MONTHLY_CAP,
    combos: structuredClone(DEMO_DEFAULT_COMBOS),
  };

  if (raw === null || raw === undefined) {
    return { settings: out, issues }; // no settings row content -> pure defaults
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    issues.push("settings is not a JSON object — using all defaults");
    return { settings: out, issues };
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.currency === "string" && obj.currency.trim() !== "" && obj.currency.length <= 8) {
    out.currency = obj.currency.trim();
  } else if (obj.currency !== undefined) {
    issues.push("currency invalid (want short non-empty string) — using null");
  }

  if (typeof obj.min_similarity === "number" && Number.isFinite(obj.min_similarity) &&
      obj.min_similarity >= 0 && obj.min_similarity <= 1) {
    out.min_similarity = obj.min_similarity;
  } else if (obj.min_similarity !== undefined) {
    issues.push("min_similarity invalid (want 0..1) — using default");
  }

  if (typeof obj.default_limit === "number" && Number.isInteger(obj.default_limit) &&
      obj.default_limit >= 1 && obj.default_limit <= 50) {
    out.default_limit = obj.default_limit;
  } else if (obj.default_limit !== undefined) {
    issues.push("default_limit invalid (want int 1..50) — using default");
  }

  if (typeof obj.rate_limit_per_min === "number" && Number.isInteger(obj.rate_limit_per_min) &&
      obj.rate_limit_per_min >= 1 && obj.rate_limit_per_min <= 10000) {
    out.rate_limit_per_min = obj.rate_limit_per_min;
  } else if (obj.rate_limit_per_min !== undefined) {
    issues.push("rate_limit_per_min invalid (want int 1..10000) — using default");
  }

  if (typeof obj.vton_rate_limit_per_min === "number" &&
      Number.isInteger(obj.vton_rate_limit_per_min) &&
      obj.vton_rate_limit_per_min >= 1 && obj.vton_rate_limit_per_min <= 1000) {
    out.vton_rate_limit_per_min = obj.vton_rate_limit_per_min;
  } else if (obj.vton_rate_limit_per_min !== undefined) {
    issues.push("vton_rate_limit_per_min invalid (want int 1..1000) — using default");
  }

  if (typeof obj.vton_monthly_cap === "number" && Number.isInteger(obj.vton_monthly_cap) &&
      obj.vton_monthly_cap >= 0 && obj.vton_monthly_cap <= 100000) {
    out.vton_monthly_cap = obj.vton_monthly_cap; // 0 = cap disabled
  } else if (obj.vton_monthly_cap !== undefined) {
    issues.push("vton_monthly_cap invalid (want int 0..100000) — using default");
  }

  if (obj.combos !== undefined) {
    const combos = parseCombos(obj.combos, issues);
    if (combos !== null) out.combos = combos;
  }

  return { settings: out, issues };
}

function parseCombos(raw: unknown, issues: string[]): Record<string, string[]> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push("combos is not an object — using the documented demo defaults");
    return null;
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_OCCASIONS) {
    issues.push(`combos has more than ${MAX_OCCASIONS} occasions — using the documented demo defaults`);
    return null;
  }
  const out: Record<string, string[]> = {};
  let dropped = 0;
  for (const [occasionRaw, sectionsRaw] of entries) {
    const occasion = normalizeOccasion(occasionRaw);
    if (occasion === "" || occasion.length > 60) {
      dropped++;
      continue;
    }
    if (!Array.isArray(sectionsRaw) || sectionsRaw.length === 0 ||
        sectionsRaw.length > MAX_SECTIONS_PER_RECIPE ||
        !sectionsRaw.every((s) => isSection(s))) {
      dropped++;
      continue; // a bad recipe drops ONLY that occasion, not the whole map
    }
    out[occasion] = sectionsRaw as string[];
  }
  if (dropped > 0) {
    issues.push(`${dropped} combo recipe(s) dropped (empty/oversized/not pilot sections)`);
  }
  if (Object.keys(out).length === 0 && entries.length > 0) {
    issues.push("no valid combo recipes remained — using the documented demo defaults");
    return structuredClone(DEMO_DEFAULT_COMBOS);
  }
  return out;
}
