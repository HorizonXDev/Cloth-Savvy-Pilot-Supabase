// _pilot/validation.ts — body parsing + field validation (pure, unit-tested).
//
// Limits (kept deliberately small — this is a server-to-server API):
//   * whole body      ≤ 32 KB by default (checked on Content-Length and actual
//                      bytes). Routes that legitimately carry bulk payloads
//                      pass a bigger cap to readJsonObject: admin_catalog
//                      (embeddings_merge — 500 vectors ≈ up to 8 MB) and
//                      tenant_catalog (CSV staging batches — 1 MB). The 32 KB
//                      default keeps every other route tight.
//   * free-text fields ≤ 300 chars unless noted (style_notes, query, …)
//   * color lists     ≤ 10 items, each ≤ 40 chars
//   * unknown fields are IGNORED, never rejected — because tenant_id/slug in
//     the body must be silently ignored (T15), rejecting unknown fields would
//     turn a forged-tenant probe into a 400 instead of the honest 200 with
//     key-derived data. We never read tenant-ish fields at all.

import { PilotError } from "./errors.ts";

export const MAX_BODY_BYTES = 32 * 1024;

/** Parse the request body as JSON. Throws invalid_request (never leaks parse
 * internals) when empty, oversize or not a JSON object.
 *
 * `maxBytes` defaults to the tight 32 KB; bulk routes pass their own cap. */
export async function readJsonObject(
  req: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const len = req.headers.get("Content-Length");
  if (len !== null && Number(len) > maxBytes) {
    throw new PilotError("invalid_request", `request body exceeds ${maxBytes} bytes`);
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new PilotError("invalid_request", "could not read request body");
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > maxBytes) {
    throw new PilotError("invalid_request", `request body exceeds ${maxBytes} bytes`);
  }
  if (text.trim() === "") {
    throw new PilotError("invalid_request", "request body must be a JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PilotError("invalid_request", "request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PilotError("invalid_request", "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function bad(field: string, why: string): PilotError {
  return new PilotError("invalid_request", `field '${field}' ${why}`);
}

export interface StrOpts {
  required?: boolean;
  max?: number;
  min?: number;
  values?: readonly string[]; // enum
}

export function optString(
  obj: Record<string, unknown>,
  field: string,
  opts: StrOpts = {},
): string | undefined {
  const v = obj[field];
  if (v === undefined || v === null) {
    if (opts.required) throw bad(field, "is required");
    return undefined;
  }
  if (typeof v !== "string") throw bad(field, "must be a string");
  const s = v.trim();
  if (opts.required && s === "") throw bad(field, "must not be empty");
  if (opts.min !== undefined && s.length < opts.min) throw bad(field, `must be at least ${opts.min} chars`);
  if (opts.max !== undefined && s.length > opts.max) throw bad(field, `must be at most ${opts.max} chars`);
  if (opts.values && !opts.values.includes(s)) {
    throw bad(field, `must be one of: ${opts.values.join(", ")}`);
  }
  return s;
}

export interface IntOpts {
  required?: boolean;
  min?: number;
  max?: number;
  default?: number;
}

export function optInt(
  obj: Record<string, unknown>,
  field: string,
  opts: IntOpts = {},
): number | undefined {
  const v = obj[field];
  if (v === undefined || v === null) {
    if (opts.required) throw bad(field, "is required");
    return opts.default;
  }
  if (typeof v !== "number" || !Number.isInteger(v)) throw bad(field, "must be an integer");
  if (opts.min !== undefined && v < opts.min) throw bad(field, `must be >= ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw bad(field, `must be <= ${opts.max}`);
  return v;
}

export function optNumber(
  obj: Record<string, unknown>,
  field: string,
  opts: { min?: number; max?: number; default?: number } = {},
): number | undefined {
  const v = obj[field];
  if (v === undefined || v === null) return opts.default;
  if (typeof v !== "number" || !Number.isFinite(v)) throw bad(field, "must be a number");
  if (opts.min !== undefined && v < opts.min) throw bad(field, `must be >= ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw bad(field, `must be <= ${opts.max}`);
  return v;
}

export function optBool(
  obj: Record<string, unknown>,
  field: string,
  defaultValue?: boolean,
): boolean | undefined {
  const v = obj[field];
  if (v === undefined || v === null) return defaultValue;
  if (typeof v !== "boolean") throw bad(field, "must be a boolean");
  return v;
}

/** Color list: ≤10 items, each a trimmed lowercase string ≤40 chars. */
export function optColorList(
  obj: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const v = obj[field];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw bad(field, "must be an array of strings");
  if (v.length === 0) throw bad(field, "must contain at least one color");
  if (v.length > 10) throw bad(field, "must contain at most 10 colors");
  return v.map((item, i) => {
    if (typeof item !== "string") throw bad(`${field}[${i}]`, "must be a string");
    const s = item.trim().toLowerCase();
    if (s === "") throw bad(`${field}[${i}]`, "must not be empty");
    if (s.length > 40) throw bad(`${field}[${i}]`, "must be at most 40 chars");
    return s;
  });
}
