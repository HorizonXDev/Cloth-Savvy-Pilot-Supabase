// _pilot/import_row.ts — ONE validator for a catalog row, shared by the
// tenant portal's staging path and by everything that writes a row into the
// queue.
//
// Why it is shared: the CSV that bit us in production (2026-10-26) failed
// for a reason the wizard reported badly. Validation rules for external_id /
// title / section / colours / price must be identical everywhere a row can
// enter the catalogue, or the tenant's portal would accept what the owner's
// import rejects (or vice versa) and the failure surfaces much later.
//
// VECTORS ARE NOT THIS FILE'S BUSINESS (owner decision, 2026-10-26): a
// row's embedding comes from its IMAGE, produced offline by the owner's
// FashionCLIP run and applied by id through admin_catalog
// ?op=embeddings_merge. Title / category / colours / section / price are
// FILTERS ONLY. The SEARCH QUERY is still embedded (CLIP's text tower, same
// joint 512-d space as the image vectors) — but nothing in the catalog is
// ever embedded from its text.
//
// No imports by design: pure, testable, usable from any function.

export const ATTRS_MAX_CHARS = 4096;

export interface ParsedRow {
  external_id: string;
  title: string;
  section: string;
  category: string | null;
  gender: string | null;
  colors: string[];
  price: number | null;
  in_stock: boolean;
  product_url: string | null;
  image_url: string | null;
  attributes: Record<string, unknown>;
  status: "active" | "archived";
}

/** Validate one import row. Throws PilotError invalid_request with a precise
 * reason — the caller turns that into a per-row failure entry.
 *
 * (Imported verbatim from admin_catalog on 2026-10-26 when the tenant portal
 * gained the same upload capability — the error class is thrown by the
 * caller's own module here to keep this file dependency-free.) */
export function parseImportRow(
  raw: unknown,
  index: number,
  fail: (why: string) => never,
): ParsedRow {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail("must be a JSON object");
  }
  const r = raw as Record<string, unknown>;
  const external_id = reqStr(r, "external_id", 1, 200, fail);
  const title = reqStr(r, "title", 1, 300, fail);
  const section = reqStr(r, "section", 1, 40, fail);
  if (!isPilotSection(section)) {
    return fail(`'section' must be one of: ${SECTIONS.join(", ")}`);
  }
  const category = optStr(r, "category", 100, fail);
  const gender = optStr(r, "gender", 40, fail);
  const colors = optColors(r, "colors", fail);
  const price = optNum(r, "price", fail);
  const in_stock = optBool(r, "in_stock", fail);
  const product_url = optStr(r, "product_url", 500, fail);
  const image_url = optStr(r, "image_url", 500, fail);
  let attributes: Record<string, unknown> = {};
  if (r.attributes !== undefined && r.attributes !== null) {
    if (typeof r.attributes !== "object" || Array.isArray(r.attributes)) {
      return fail("'attributes' must be an object");
    }
    if (JSON.stringify(r.attributes).length > ATTRS_MAX_CHARS) {
      return fail(`'attributes' must be at most ${ATTRS_MAX_CHARS} chars of JSON`);
    }
    attributes = r.attributes as Record<string, unknown>;
  }
  const status = r.status === undefined || r.status === null
    ? "active"
    : oneOf(r.status, ["active", "archived"], "status", fail);

  return {
    external_id, title, section, category, gender, colors, price, in_stock,
    product_url, image_url, attributes, status: status as "active" | "archived",
  };
}

// ---- the section enum, in one place ---------------------------------------
// (mirrors _pilot/sections.ts — duplicated rather than imported so this file
//  stays dependency-free; the values are asserted identical by pilot.test.ts)
export const SECTIONS = [
  "top", "bottom", "dress", "saree", "blouse", "dupatta", "outerwear",
  "footwear", "bag", "jewellery", "accessory",
] as const;

export function isPilotSection(v: string): boolean {
  return (SECTIONS as readonly string[]).includes(v);
}

// ---- small validators (same messages as the original admin implementation) --
type Fail = (why: string) => never;

function reqStr(o: Record<string, unknown>, k: string, min: number, max: number, fail: Fail): string {
  const v = o[k];
  if (v === undefined || v === null) return fail(`${k} is required`);
  if (typeof v !== "string") return fail(`${k} must be a string`);
  const s = v.trim();
  if (s.length < min) return fail(`${k} must be at least ${min} chars`);
  if (s.length > max) return fail(`${k} must be at most ${max} chars`);
  return s;
}

function optStr(o: Record<string, unknown>, k: string, max: number, fail: Fail): string | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return fail(`${k} must be a string`);
  const s = v.trim();
  if (s === "") return null;
  if (s.length > max) return fail(`${k} must be at most ${max} chars`);
  return s;
}

function optColors(o: Record<string, unknown>, k: string, fail: Fail): string[] {
  const v = o[k];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return fail(`${k} must be an array of strings`);
  if (v.length === 0) return [];
  if (v.length > 10) return fail(`${k} must contain at most 10 colors`);
  return v.map((item, i) => {
    if (typeof item !== "string") return fail(`${k}[${i}] must be a string`);
    const s = item.trim().toLowerCase();
    if (s === "") return fail(`${k}[${i}] must not be empty`);
    if (s.length > 40) return fail(`${k}[${i}] must be at most 40 chars`);
    return s;
  });
}

function optNum(o: Record<string, unknown>, k: string, fail: Fail): number | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return fail(`${k} must be a number`);
  if (v < 0) return fail(`${k} must be >= 0`);
  if (v > 9.99e9) return fail(`${k} must be <= 9990000000`);
  return v;
}

function optBool(o: Record<string, unknown>, k: string, fail: Fail): boolean {
  const v = o[k];
  if (v === undefined || v === null) return true;
  if (typeof v !== "boolean") return fail(`${k} must be a boolean`);
  return v;
}

function oneOf(v: unknown, allowed: readonly string[], k: string, fail: Fail): string {
  if (typeof v !== "string" || !allowed.includes(v)) {
    return fail(`${k} must be one of: ${allowed.join(", ")}`);
  }
  return v;
}
