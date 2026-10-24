// _pilot/sections.ts — the 11 pilot product sections, the single vocabulary
// for the whole API layer. Mirrors the CHECK constraint on products.section
// (migrations/0003_products.sql) and search_products' guard (0007).
// The consumer app's CATEGORY_MAP (top/bottom/dress/footwear/layer/accessory)
// is deliberately NOT used: "layer" does not exist here (it is "outerwear")
// and saree/blouse/dupatta/jewellery/bag have no consumer counterpart.

export const ALLOWED_SECTIONS = [
  "top", "bottom", "dress", "saree", "blouse", "dupatta", "outerwear",
  "footwear", "bag", "jewellery", "accessory",
] as const;

export type Section = (typeof ALLOWED_SECTIONS)[number];

export function isSection(value: unknown): value is Section {
  return typeof value === "string" && (ALLOWED_SECTIONS as readonly string[]).includes(value);
}
