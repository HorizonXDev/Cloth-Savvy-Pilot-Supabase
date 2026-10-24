// tests/serve_local.ts — host-side harness that serves the four pilot Edge
// Functions OUTSIDE Docker, for tests/api_tests.py.
//
// WHY THIS EXISTS (found 2026-10-24 on the local stack, CLI v2.118):
//   1. `supabase start`'s edge-runtime container lives on the project's
//      Docker network, where127.0.0.1 is the container itself — the
//      encoder/LLM test stubs (loopback-only on the HOST) are unreachable,
//      so every encoder/LLM call 503s ("transport failure … TypeError").
//   2. Local Kong attaches its own `cors` plugin to /functions/v1/* and
//      OVERRIDES our Access-Control-Allow-Origin with "*" (verified: our
//      other CORS headers pass through, ACAO alone is replaced). The
//      allowlist behavior ("never *, never echo a disallowed origin") can
//      therefore only be asserted against the functions served directly.
// The functions are plain fetch handlers registered via Deno.serve, so a
// host Deno process serves them faithfully — use the SAME Deno version the
// supabase edge-runtime pins (v2.1.4). Hosted behaviour is unaffected and
// is checked by tests/live_smoke.py against the deployed project.
//
// Normally SPAWNED AUTOMATICALLY by api_tests.py. To run it by hand:
//   npx -y deno@2.1.4 run --allow-net --allow-env --allow-read tests/serve_local.ts 54431
//
// Env: loads supabase/functions/.env (the same file `functions serve`
// uses); SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY already present in the
// process environment always win over the file.

const PORT = Number(Deno.args[0] ?? 54431);
const FN_NAMES = ["health", "search", "occasions", "combos"];

// --- load supabase/functions/.env (process env wins) --------------------
try {
  const text = await Deno.readTextFile(new URL("../supabase/functions/.env", import.meta.url));
  const existing = Deno.env.toObject();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in existing)) Deno.env.set(m[1], val);
  }
} catch {
  // no file — platform/process env only (same as a deployed function)
}

// --- capture each function's Deno.serve handler at import time -----------
type FetchHandler = (req: Request) => Response | Promise<Response>;
const realServe = Deno.serve.bind(Deno);
let captured: FetchHandler | null = null;
// deno-lint-ignore no-explicit-any
const hijack = (a: any, b?: any) => {
  captured = (typeof a === "function" ? a : b) as FetchHandler;
  // The edge runtime's shim also returns a serve handle; ours is inert.
  return { finished: Promise.resolve() };
};
try {
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = hijack;
} catch {
  Object.defineProperty(Deno, "serve", { value: hijack, configurable: true, writable: true });
}

const handlers = new Map<string, FetchHandler>();
for (const name of FN_NAMES) {
  captured = null;
  await import(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url).href);
  if (!captured) {
    console.error(`serve_local: supabase/functions/${name}/index.ts did not call Deno.serve`);
    Deno.exit(1);
  }
  handlers.set(name, captured);
}

// --- router: /functions/v1/<name> (and the stripped /<name> form) --------
realServe({ port: PORT, hostname: "127.0.0.1" }, (req) => {
  const path = new URL(req.url).pathname;
  const m = path.match(/^(?:\/functions\/v1)?\/([a-z][a-z0-9_]*)$/);
  const handler = m ? handlers.get(m[1]) : undefined;
  if (!handler) {
    return new Response(
      JSON.stringify({ error: { code: "not_found", message: `no local function for ${path}` } }),
      { status: 404, headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  }
  return handler(req);
});
console.log(`serve_local: ${FN_NAMES.join(", ")} on http://127.0.0.1:${PORT}/functions/v1/<name>`);
