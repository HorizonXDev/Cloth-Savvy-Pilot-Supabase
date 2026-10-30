// _pilot/pilot.test.ts — unit tests for the pure _pilot logic.
//
// Run (no network, no permissions needed — every import is a relative file):
//   npx -y deno@2.1.4 run supabase/functions/_pilot/pilot.test.ts
//   (or plain `deno run ...` if Deno is installed — this is a check()-
//    style script; `deno test` discovers 0 tests and passes vacuously)
//
// Covered areas required by the brief: validation, recipe lookup,
// assembly/dedupe, error mapping, key format. Local asserts only — no
// remote std imports, so the suite is fully offline.

import {
  environmentForPrefix,
  KEY_BODY_LENGTH,
  parseApiKey,
} from "./key_format.ts";
import {
  decideExisting,
  IDEMPOTENCY_HEADER,
  type IdempotencyRow,
  readIdempotencyKey,
  requestHash,
} from "./idempotency.ts";
import {
  optBool,
  optColorList,
  optInt,
  optString,
  readJsonObject,
} from "./validation.ts";
import {
  DEMO_DEFAULT_COMBOS,
  DEFAULT_MIN_SIMILARITY,
  DEFAULT_RATE_LIMIT_PER_MIN,
  DEFAULT_VTON_MONTHLY_CAP,
  DEFAULT_VTON_RATE_LIMIT_PER_MIN,
  normalizeOccasion,
  parseTenantSettings,
} from "./settings.ts";
import { getRecipe, listOccasions } from "./recipes.ts";
import {
  assemble,
  chunkTexts,
  fallbackText,
  type ComboPlan,
} from "./combos_core.ts";
import {
  errorEnvelope,
  internalMessage,
  PilotError,
  statusForCode,
  type ErrorCode,
} from "./errors.ts";
import type { ProductRow } from "./types.ts";

// ---------------------------------------------------------------- tiny assert
let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEq<T>(got: T, want: T, msg = ""): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${msg} got=${g} want=${w}`);
}
function assertThrowsPilot(fn: () => unknown, code: string): PilotError {
  try {
    fn();
  } catch (e) {
    assert(e instanceof PilotError, `wanted PilotError, got ${e}`);
    assert(e.code === code, `wanted code=${code}, got ${e.code}`);
    return e;
  }
  throw new Error("did not throw");
}
async function assertThrowsPilotAsync(
  fn: () => Promise<unknown>,
  code: string,
): Promise<PilotError> {
  try {
    await fn();
  } catch (e) {
    assert(e instanceof PilotError, `wanted PilotError, got ${e}`);
    assert(e.code === code, `wanted code=${code}, got ${e.code}`);
    return e;
  }
  throw new Error("did not throw");
}

function post(body: string): Request {
  return new Request("http://local.test/x", { method: "POST", body });
}

// ------------------------------------------------------------------- key format
check("key format: valid sk_live_ (43-char body)", () => {
  const r = parseApiKey("sk_live_" + "a".repeat(KEY_BODY_LENGTH));
  assert(r.ok, JSON.stringify(r));
  assertEq(r.prefix, "sk_live_");
  assertEq(environmentForPrefix(r.prefix), "live");
});
check("key format: valid sk_test_ -> sandbox", () => {
  const r = parseApiKey("sk_test_" + "Ab_9".repeat(10) + "Abc"); // 43 chars
  assert(r.ok, JSON.stringify(r));
  assert(r.prefix.length + KEY_BODY_LENGTH === 51, "51 chars total");
  assertEq(environmentForPrefix(r.prefix), "sandbox");
});
check("key format: pk_ rejected (reserved family)", () => {
  const r = parseApiKey("pk_" + "a".repeat(KEY_BODY_LENGTH));
  assert(!r.ok && r.reason === "prefix", JSON.stringify(r));
});
check("key format: wrong length / charset / empty", () => {
  assertEq(parseApiKey("sk_live_" + "a".repeat(42)).ok, false);
  assertEq(parseApiKey("sk_live_" + "a".repeat(44)).ok, false);
  const bad = parseApiKey("sk_live_" + "!".repeat(KEY_BODY_LENGTH));
  assert(!bad.ok && bad.reason === "charset", JSON.stringify(bad));
  assertEq(parseApiKey("").ok, false);
  assertEq(parseApiKey(null).ok, false);
  assertEq(parseApiKey(undefined).ok, false);
  assertEq(parseApiKey("sk_live_nounderscorebody").ok, false);
});

// ------------------------------------------------------------------- validation
check("validation: optString required/max/enum/trim", () => {
  assertThrowsPilot(() => optString({}, "q", { required: true }), "invalid_request");
  assertThrowsPilot(() => optString({ q: "x".repeat(301) }, "q", { max: 300 }), "invalid_request");
  assertThrowsPilot(() => optString({ g: "other" }, "g", { values: ["men", "women"] }), "invalid_request");
  assertThrowsPilot(() => optString({ q: 5 }, "q", {}), "invalid_request");
  assertEq(optString({ q: "  hi  " }, "q", {}), "hi");
  assertEq(optString({}, "q", { max: 300 }), undefined);
});
check("validation: optInt bounds + default + non-integer", () => {
  assertEq(optInt({}, "n", { default: 3 }), 3);
  assertEq(optInt({ n: 5 }, "n", { min: 1, max: 5 }), 5);
  assertThrowsPilot(() => optInt({ n: 0 }, "n", { min: 1, max: 5 }), "invalid_request");
  assertThrowsPilot(() => optInt({ n: 6 }, "n", { min: 1, max: 5 }), "invalid_request");
  assertThrowsPilot(() => optInt({ n: 1.5 }, "n", {}), "invalid_request");
  assertThrowsPilot(() => optInt({ n: "2" }, "n", {}), "invalid_request");
});
check("validation: optBool default + non-boolean", () => {
  assertEq(optBool({}, "flag", true), true);
  assertEq(optBool({ flag: false }, "flag", true), false);
  assertThrowsPilot(() => optBool({ flag: "yes" }, "flag", true), "invalid_request");
});
check("validation: optColorList caps, normalizes, rejects junk", () => {
  assertEq(optColorList({ c: [" Blue ", "RED"] }, "c"), ["blue", "red"]);
  assertThrowsPilot(() => optColorList({ c: Array(11).fill("a") }, "c"), "invalid_request");
  assertThrowsPilot(() => optColorList({ c: [] }, "c"), "invalid_request");
  assertThrowsPilot(() => optColorList({ c: [1] }, "c"), "invalid_request");
  assertThrowsPilot(() => optColorList({ c: ["x".repeat(41)] }, "c"), "invalid_request");
  assertThrowsPilot(() => optColorList({ c: "blue" }, "c"), "invalid_request");
});
// body limits (async — run directly, check() is sync by design)
await (async () => {
  try {
    await (async () => {
      await assertThrowsPilotAsync(() => readJsonObject(post("")), "invalid_request");
      await assertThrowsPilotAsync(() => readJsonObject(post("not json")), "invalid_request");
      await assertThrowsPilotAsync(() => readJsonObject(post("[1,2]")), "invalid_request");
      await assertThrowsPilotAsync(
        () => readJsonObject(post(JSON.stringify({ pad: "y".repeat(40000) }))),
        "invalid_request",
      );
      const okBody = await readJsonObject(post("{\"q\":\"x\"}"));
      assertEq(okBody["q"], "x");
    })();
    passed++;
  } catch (e) {
    failures.push(`validation: body limits: ${e instanceof Error ? e.message : e}`);
  }
})();

// --------------------------------------------------------------- recipe lookup
check("recipes: getRecipe normalizes input; unknown -> null", () => {
  const { settings } = parseTenantSettings({
    combos: { wedding: ["saree", "blouse", "jewellery"] },
  });
  assertEq(getRecipe(settings, " Wedding "), ["saree", "blouse", "jewellery"]);
  assertEq(getRecipe(settings, "WEDDING-DAY"), null); // normalized key absent
  assertEq(normalizeOccasion("  Wedding Day "), "wedding_day");
  assertEq(getRecipe(settings, "office"), null); // only provided keys exist
});
check("recipes: listOccasions sorted + copies", () => {
  const { settings } = parseTenantSettings({
    combos: { zeta: ["top"], alpha: ["bag"] },
  });
  assertEq(listOccasions(settings).map((o) => o.occasion), ["alpha", "zeta"]);
  const first = listOccasions(settings)[0].sections;
  first.push("MUTATED");
  assertEq(listOccasions(settings)[0].sections, ["bag"], "returned copy");
});
check("settings: documented defaults when absent/garbage", () => {
  const { settings, issues } = parseTenantSettings(null);
  assertEq(settings.min_similarity, DEFAULT_MIN_SIMILARITY);
  assertEq(settings.rate_limit_per_min, DEFAULT_RATE_LIMIT_PER_MIN);
  assertEq(settings.combos, DEMO_DEFAULT_COMBOS);
  assertEq(issues.length, 0);
  settings.combos["injected"] = ["top"]; // mutation must not leak into the default
  assertEq(parseTenantSettings(null).settings.combos, DEMO_DEFAULT_COMBOS);

  const bad = parseTenantSettings({
    min_similarity: 4,
    rate_limit_per_min: 0,
    default_limit: 999,
    currency: 42,
  });
  assertEq(bad.settings.min_similarity, DEFAULT_MIN_SIMILARITY);
  assertEq(bad.settings.rate_limit_per_min, DEFAULT_RATE_LIMIT_PER_MIN);
  assertEq(bad.settings.default_limit, 10);
  assertEq(bad.settings.currency, null);
  assert(bad.issues.length >= 4, `issues=${bad.issues.length}`);
});
check("settings: vton quota defaults, ranges, 0 = cap disabled", () => {
  const base = parseTenantSettings(null).settings;
  assertEq(base.vton_rate_limit_per_min, DEFAULT_VTON_RATE_LIMIT_PER_MIN);
  assertEq(base.vton_monthly_cap, DEFAULT_VTON_MONTHLY_CAP);

  const tuned = parseTenantSettings({ vton_rate_limit_per_min: 1, vton_monthly_cap: 0 }).settings;
  assertEq(tuned.vton_rate_limit_per_min, 1);
  assertEq(tuned.vton_monthly_cap, 0, "0 must disable the cap, not fall back");

  const bad = parseTenantSettings({ vton_rate_limit_per_min: 0, vton_monthly_cap: -5 });
  assertEq(bad.settings.vton_rate_limit_per_min, DEFAULT_VTON_RATE_LIMIT_PER_MIN);
  assertEq(bad.settings.vton_monthly_cap, DEFAULT_VTON_MONTHLY_CAP);
  assert(bad.issues.length >= 2, `issues=${bad.issues.join("; ")}`);

  const floats = parseTenantSettings({ vton_rate_limit_per_min: 1.5, vton_monthly_cap: 2.5 });
  assertEq(floats.settings.vton_rate_limit_per_min, DEFAULT_VTON_RATE_LIMIT_PER_MIN);
  assertEq(floats.settings.vton_monthly_cap, DEFAULT_VTON_MONTHLY_CAP);
});
check("settings: bad recipe drops only that occasion; all-bad -> defaults", () => {
  const mixed = parseTenantSettings({
    combos: {
      good: ["top", "bottom"],
      bad_section: ["layer"], // "layer" is not a pilot section
      too_many: ["top", "bottom", "dress", "saree", "blouse", "dupatta",
        "outerwear", "footwear", "bag"], // > 8
      empty: [],
    },
  });
  assertEq(Object.keys(mixed.settings.combos), ["good"]);
  assertEq(mixed.settings.combos["good"], ["top", "bottom"]);
  assert(mixed.issues.length >= 1, "issues reported");

  const allBad = parseTenantSettings({ combos: { nope: ["hoodie"] } });
  assertEq(allBad.settings.combos, DEMO_DEFAULT_COMBOS, "fallback to defaults");
});

// ---------------------------------------------------- assembly / dedupe / status
function prod(id: string, sim = 0.9): ProductRow {
  return { external_id: id, similarity: sim } as unknown as ProductRow;
}
const plans2x2: ComboPlan[] = [
  { title: "one", items: [{ section: "top", description: "t" }, { section: "bottom", description: "b" }] },
  { title: "two", items: [{ section: "top", description: "t" }, { section: "bottom", description: "b" }] },
];
check("combos: chunkTexts batches of <=8", () => {
  const chunks = chunkTexts(Array.from({ length: 10 }, (_, i) => `t${i}`));
  assertEq(chunks.map((c) => c.length), [8, 2]);
  assertEq(chunkTexts(["a"]).length, 1);
});
check("combos: fallbackText uses facets, <=300 chars", () => {
  const txt = fallbackText("top", {
    section: "top",
    categories: ["kurta", "shirt"],
    colors: ["blue", "white"],
  }, {});
  assert(txt.includes("top") && txt.includes("kurta") && txt.includes("blue"), txt);
  const long = fallbackText("top", {
    section: "top",
    categories: Array.from({ length: 20 }, (_, i) => `category_with_long_name_${i}`),
    colors: ["x"],
  }, {});
  assert(long.length <= 300, `len=${long.length}`);
});
check("combos: cross-combo dedupe -> partial + missing_sections", () => {
  const cands = new Map<string, ProductRow[]>([
    ["0:top", [prod("shared", 0.95), prod("t2", 0.9)]],
    ["0:bottom", [prod("b1", 0.92)]],
    ["1:top", [prod("shared", 0.95), prod("t3", 0.88)]],
    ["1:bottom", [prod("b2", 0.91)]],
  ]);
  const res = assemble(plans2x2, cands, null);
  assertEq(res.status, "ok", "second-best fills the gap — still complete");
  assertEq(res.combos[0].items.map((i) => i.product.external_id), ["shared", "b1"]);
  assertEq(res.combos[1].items.map((i) => i.product.external_id), ["t3", "b2"]);
  assertEq(res.combos[1].missing_sections, [], "filled with next-best, no repeat");
  // stronger: candidate lists where ONLY the shared product exists for combo 2
  const cands2 = new Map<string, ProductRow[]>([
    ["0:top", [prod("only", 0.95)]],
    ["0:bottom", [prod("b1", 0.92)]],
    ["1:top", [prod("only", 0.95)]],
    ["1:bottom", [prod("b2", 0.91)]],
  ]);
  const res2 = assemble(plans2x2, cands2, null);
  assertEq(res2.status, "partial");
  assertEq(res2.combos[1].missing_sections, ["top"], "never backfilled with junk");
});
check("combos: status ok / no_match", () => {
  const full = new Map<string, ProductRow[]>([
    ["0:top", [prod("a")]], ["0:bottom", [prod("b")]],
    ["1:top", [prod("c")]], ["1:bottom", [prod("d")]],
  ]);
  assertEq(assemble(plans2x2, full, null).status, "ok");
  const none = new Map<string, ProductRow[]>();
  const res = assemble(plans2x2, none, null);
  assertEq(res.status, "no_match");
  assertEq(res.combos[0].missing_sections, ["top", "bottom"]);
});
check("combos: anchor owns its section in EVERY combo (dedupe exception)", () => {
  const anchor = prod("base", 0.7);
  const cands = new Map<string, ProductRow[]>([
    ["0:top", [prod("other", 0.99)]],   // must be ignored for the anchor section
    ["1:top", [prod("other", 0.99)]],
    ["0:bottom", [prod("b1")]],
    ["1:bottom", [prod("b2")]],
  ]);
  const res = assemble(plans2x2, cands, { section: "top", product: anchor });
  assertEq(res.status, "ok");
  assertEq(res.combos[0].items[0].product.external_id, "base");
  assertEq(res.combos[1].items[0].product.external_id, "base", "in every combo");
  assertEq(res.combos[0].items[0].similarity, null, "anchor has no similarity");
  assertEq(res.combos.map((c) => c.missing_sections), [[], []]);
});

// ----------------------------------------------------------------- error mapping
check("errors: code -> status for every stable code", () => {
  const want: Record<ErrorCode, number> = {
    invalid_request: 400,
    unauthorized: 401,
    forbidden: 403,
    rate_limited: 429,
    quota_exceeded: 402,
    quota_unavailable: 503,
    unsupported_occasion: 422,
    upstream_llm: 502,
    upstream_encoder: 503,
    internal: 500,
  };
  for (const [code, status] of Object.entries(want)) {
    assertEq(statusForCode(code as ErrorCode), status, `${code}: `);
    assertEq(new PilotError(code as ErrorCode, "m").status, status, `${code} ctor: `);
  }
});
check("errors: envelope shape + extra headers ride along", () => {
  const env = errorEnvelope("req-123", "rate_limited", "slow down");
  assertEq(Object.keys(env), ["error"]);
  assertEq(Object.keys(env.error), ["code", "message", "request_id"]);
  assertEq(env.error, { code: "rate_limited", message: "slow down", request_id: "req-123" });
  const e = new PilotError("rate_limited", "m", { "Retry-After": "60" });
  assertEq(e.headers["Retry-After"], "60");
});
check("errors: internal message leaks nothing", () => {
  const m = internalMessage().toLowerCase();
  for (const needle of ["sql", "select", "stack", "trace", "key", "tenant"]) {
    assert(!m.includes(needle), `internal message mentions ${needle}`);
  }
  assert(m.includes("request_id"), "tells the caller what to quote");
});

// ------------------------------------------------------------------ idempotency
check("idempotency: header absent -> feature unused", () => {
  assertEq(readIdempotencyKey(new Request("http://x/")), null);
});
check("idempotency: valid key is trimmed and accepted", () => {
  const req = new Request("http://x/", {
    headers: { [IDEMPOTENCY_HEADER]: "  retry-abc_123:xyz.my-key  " },
  });
  assertEq(readIdempotencyKey(req), "retry-abc_123:xyz.my-key");
});
check("idempotency: malformed keys are refused", () => {
  for (const bad of ["short", "has spaces here", "a".repeat(129), "bad*char/key"]) {
    const req = new Request("http://x/", { headers: { [IDEMPOTENCY_HEADER]: bad } });
    let code = "";
    try {
      readIdempotencyKey(req);
    } catch (e) {
      code = e instanceof PilotError ? e.code : "not-a-pilot-error";
    }
    assertEq(code, "invalid_request", `key ${JSON.stringify(bad.slice(0, 20))}: `);
  }
});
async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

await checkAsync("idempotency: request hash is stable and body-sensitive", async () => {
  const a = await requestHash({ op: "tryon", category: "tops" });
  const b = await requestHash({ op: "tryon", category: "tops" });
  const c = await requestHash({ op: "tryon", category: "bottoms" });
  assertEq(a, b);
  assert(a !== c, "different bodies must hash differently");
  assertEq(a.length, 64, "sha256 hex: ");
});
check("idempotency: a finished key replays the stored response", () => {
  const row: IdempotencyRow = {
    request_hash: "h1",
    status: "done",
    response: { image: "data:image/png;base64,AAA" },
    created_at: new Date().toISOString(),
  };
  assertEq(decideExisting(row, "h1", Date.now()), {
    action: "replay",
    response: row.response,
  });
});
check("idempotency: same key + different body is a mismatch, never a replay", () => {
  const now = Date.now();
  for (const status of ["done", "in_progress"] as const) {
    const row: IdempotencyRow = {
      request_hash: "h1",
      status,
      response: { image: "x" },
      created_at: new Date(now).toISOString(),
    };
    assertEq(decideExisting(row, "h2", now), { action: "mismatch" }, `${status}: `);
  }
});
check("idempotency: in-flight duplicate waits, stale reservation is taken over", () => {
  const now = Date.now();
  const fresh: IdempotencyRow = {
    request_hash: "h1",
    status: "in_progress",
    response: null,
    created_at: new Date(now - 60_000).toISOString(), // 1 min
  };
  assertEq(decideExisting(fresh, "h1", now), { action: "in_flight" });

  const stale: IdempotencyRow = {
    ...fresh,
    created_at: new Date(now - 11 * 60_000).toISOString(), // 11 min
  };
  assertEq(decideExisting(stale, "h1", now), { action: "take_over" });

  const broken: IdempotencyRow = { ...fresh, created_at: "not-a-date" };
  assertEq(decideExisting(broken, "h1", now), { action: "in_flight" });
});

// ---------------------------------------------------------------------- summary
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error("  ✗ " + f);
}
console.log(`\nRESULT: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) Deno.exit(1);
