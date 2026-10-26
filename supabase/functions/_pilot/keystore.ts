// _pilot/keystore.ts — sk_ key generation + hashing (pure, shared).
//
// Split out of _admin/admin.ts so BOTH credential families can mint keys
// without either importing the other's module:
//   * admin_keys/* mints for any tenant (ADMIN_TOKEN guard), and
//   * tenant_keys/* mints only for the session's tenant (portal guard).
// Key material rules (decision D3, unchanged): plaintext exists only in
// the issuance response — never stored, never logged; the DB keeps
// sha256 hex + a display prefix; pk_ is reserved and never issued.

export interface NewKey {
  plaintext: string; // shown to the caller ONCE, never stored or logged
  keyHash: string; // sha256 hex — the only thing that reaches the DB
  keyPrefix: string; // display fragment, e.g. sk_live_a1b2
  environment: "live" | "sandbox";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generate an sk_ key exactly like tools/issue_key.py does:
 * `sk_live_` / `sk_test_` + 43 URL-safe chars (32 random bytes, base64url
 * unpadded); display prefix = prefix + first 4 body chars.
 * NOTE: the sandbox family is `sk_test_` (key_format.ts D3) — NOT sk_sandbox_. */
export function newApiSecretKey(environment: "live" | "sandbox"): NewKey {
  const prefix = environment === "live" ? "sk_live_" : "sk_test_";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const body = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const plaintext = prefix + body;
  return {
    plaintext,
    keyHash: "", // filled by withHash
    keyPrefix: plaintext.slice(0, prefix.length + 4),
    environment,
  };
}

export async function withHash(key: NewKey): Promise<NewKey> {
  key.keyHash = await sha256Hex(key.plaintext);
  return key;
}

export async function sha256HexOf(text: string): Promise<string> {
  return sha256Hex(text);
}
