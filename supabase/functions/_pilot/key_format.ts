// _pilot/key_format.ts — pure key-format rules (unit-tested in Deno).
//
// Decision D3 (fixed):
//   * Server keys: "sk_live_" / "sk_test_" + 43 random URL-safe chars
//     (secrets.token_urlsafe(32) in tools/issue_key.py → exactly 43 chars),
//     51 chars total. Stored ONLY as SHA-256 hex (64 lowercase hex chars,
//     matching the api_keys.key_hash CHECK).
//   * "pk_" is RESERVED for a future browser-safe key family and must never
//     be issued; a request presenting a pk_ key is unauthorized (401) — it
//     is not a server key.
//   * The prefix family tells us nothing on its own: the authoritative
//     environment is the api_keys.environment column, resolved by hash.

export const KEY_BODY_LENGTH = 43; // random URL-safe chars after the prefix
export const KEY_PREFIXES = ["sk_live_", "sk_test_"] as const;
export type KeyPrefix = (typeof KEY_PREFIXES)[number];

export type KeyParse =
  | { ok: true; prefix: KeyPrefix }
  | { ok: false; reason: "empty" | "prefix" | "length" | "charset" };

export function parseApiKey(raw: string | null | undefined): KeyParse {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "empty" };
  const prefix = KEY_PREFIXES.find((p) => raw.startsWith(p));
  if (!prefix) return { ok: false, reason: "prefix" };
  const body = raw.slice(prefix.length);
  if (body.length !== KEY_BODY_LENGTH) return { ok: false, reason: "length" };
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return { ok: false, reason: "charset" };
  return { ok: true, prefix };
}

/** Environment the prefix family implies (used for logging/metering labels
 * only — the DB row is authoritative). */
export function environmentForPrefix(prefix: KeyPrefix): "live" | "sandbox" {
  return prefix === "sk_live_" ? "live" : "sandbox";
}
