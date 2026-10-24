#!/usr/bin/env python3
"""HTTP API tests for the pilot Edge Functions — LOCAL Docker stack ONLY.

Standard library only (no pip installs). Runs against the local Supabase
stack + the two LOCAL stubs this repo ships (tests/stub_encoder.py,
tests/stub_llm.py). It NEVER touches the live Modal encoder, any real LLM
or any hosted project.

Run order (README "Running the tests — API layer"):
  supabase start
  python tests/api_tests.py          (spawns the local Deno harness
                                      tests/serve_local.ts AND the two stubs
                                      itself; export PILOT_FUNCTIONS_URL to
                                      target an already-served instance
                                      instead of the harness)
  python tests/cleanup_test_tenants.py

Guards: requires PILOT_SUPABASE_URL + PILOT_SUPABASE_SERVICE_KEY from the
environment or a .env (beside this script or the project root). The URL must
be localhost unless PILOT_ALLOW_REMOTE=1 + PILOT_PROJECT_REF appears in it.
PILOT_FUNCTIONS_URL defaults to the local harness (tests/serve_local.ts on
127.0.0.1:54431): the Docker edge-runtime cannot reach the loopback stubs,
and local Kong's cors plugin masks our Access-Control-Allow-Origin with
"*" — both found 2026-10-24; see the harness header for details.
Keys are never printed; plaintext test keys go ONLY to tests/.test_keys.

Exit codes: 0 = all passed, 1 = at least one FAIL, 2 = refused to run.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import secrets
import shutil
import subprocess
import sys
import time
import uuid
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
KEY_FILE = os.path.join(SCRIPT_DIR, ".test_keys")
TIMEOUT_S = 60
DIM = 512
# Canonical model string (Step 0a): encoder model + pinned revision prefix.
CANONICAL_MODEL = "fashion-clip@7e3ba62"
ENC_REVISION = "7e3ba62ce16b379a1ab479346b66f192e76f51b7"
STUB_ENCODER_PORT = int(os.environ.get("STUB_ENCODER_PORT", "8841"))
STUB_LLM_PORT = int(os.environ.get("STUB_LLM_PORT", "8842"))
STUB_ENCODER_TOKEN = "local-stub-encoder-token"   # local-only, not a secret
ALLOWED_ORIGIN = "http://localhost:3000"
# Local functions are served by tests/serve_local.ts (host Deno harness):
# the Docker edge-runtime runs on the project network where 127.0.0.1 is the
# container (loopback stubs unreachable), and local Kong's cors plugin
# overrides our ACAO with "*" (verified 2026-10-24). Export
# PILOT_FUNCTIONS_URL to target another instance (e.g. the Kong URL).
HARNESS_PORT = int(os.environ.get("PILOT_HARNESS_PORT", "54431"))
HARNESS_URL = f"http://127.0.0.1:{HARNESS_PORT}/functions/v1"
HARNESS_LOG = os.path.join(SCRIPT_DIR, ".harness_run.log")

# Deterministic embedding shared with the stub -> exact-vector fixtures.
sys.path.insert(0, SCRIPT_DIR)
from stub_encoder import embed_text  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


class Refused(RuntimeError):
    pass


class TestError(RuntimeError):
    pass


def record(name: str, ok: bool, detail: str) -> bool:
    RESULTS.append((name, ok, detail))
    print(f"  {name}  {'PASS' if ok else 'FAIL'}  {detail}", flush=True)
    return ok


def load_dotenv_if_present() -> None:
    for env_path in (os.path.join(SCRIPT_DIR, ".env"),
                     os.path.join(PROJECT_DIR, ".env")):
        if not os.path.isfile(env_path):
            continue
        try:
            with open(env_path, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    key, value = key.strip(), value.strip().strip('"').strip("'")
                    if key and key not in os.environ:
                        os.environ[key] = value
        except OSError:
            pass


def require_config() -> tuple[str, str, str]:
    missing = [k for k in ("PILOT_SUPABASE_URL", "PILOT_SUPABASE_SERVICE_KEY")
               if not os.environ.get(k)]
    if missing:
        raise Refused("missing environment variable(s): " + ", ".join(missing) +
                      " (copy .env.example to .env or export them)")
    base = os.environ["PILOT_SUPABASE_URL"].rstrip("/")
    parsed = urlparse.urlparse(base)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise Refused(f"PILOT_SUPABASE_URL is not a URL: {base!r}")
    svc = os.environ["PILOT_SUPABASE_SERVICE_KEY"]
    fns = os.environ.get("PILOT_FUNCTIONS_URL") or HARNESS_URL
    return base, svc, fns.rstrip("/")


def check_target_allowed(base: str) -> None:
    host = (urlparse.urlparse(base).hostname or "").lower()
    if host in ("127.0.0.1", "localhost", "::1"):
        return
    if os.environ.get("PILOT_ALLOW_REMOTE") != "1":
        raise Refused(f"target host {host!r} is not localhost; "
                      "set PILOT_ALLOW_REMOTE=1 + PILOT_PROJECT_REF to allow hosted")
    ref = (os.environ.get("PILOT_PROJECT_REF") or "").strip()
    if not ref or ref not in base:
        raise Refused("PILOT_ALLOW_REMOTE=1 requires PILOT_PROJECT_REF in the URL")


# --------------------------------------------------------------------- HTTP
def http(base: str, key: str | None, method: str, path: str,
         body=None, headers: dict | None = None, raw: bytes | None = None):
    url = base + path
    data = raw
    hdrs = {"Accept": "application/json"}
    if key:
        hdrs["apikey"] = key
        hdrs["Authorization"] = f"Bearer {key}"
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    if headers:
        hdrs.update(headers)
    req = urlrequest.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urlrequest.urlopen(req, timeout=TIMEOUT_S) as resp:
            text = resp.read().decode("utf-8", "replace")
            return resp.status, resp.headers, text
    except urlerror.HTTPError as exc:
        return exc.code, exc.headers, exc.read().decode("utf-8", "replace")
    except urlerror.URLError as exc:
        raise TestError(f"network failure {method} {path}: {exc.reason}") from exc


def j(base, key, method, path, body=None, headers=None, raw=None):
    status, hdrs, text = http(base, key, method, path, body=body,
                              headers=headers, raw=raw)
    try:
        parsed = json.loads(text) if text else None
    except json.JSONDecodeError:
        parsed = None
    return status, parsed, text, hdrs


def rest_ok(base, key, method, path, body=None, headers=None):
    status, parsed, text, _ = j(base, key, method, path, body, headers)
    if status >= 300:
        raise TestError(f"{method} {path} -> {status}: {text[:300]}")
    return parsed


def rpc(base, key, name, payload=None):
    return j(base, key, "POST", f"/rest/v1/rpc/{name}",
             body=(payload if payload is not None else {}))


def api(fns, key, method, path, body=None, headers=None):
    """Call a /functions/v1 endpoint (no service key — API keys only)."""
    return j(fns, key, method, path, body=body, headers=headers)


def err_code(parsed) -> str:
    if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
        return str(parsed["error"].get("code", ""))
    return ""


def vec(text: str) -> str:
    return json.dumps(embed_text(text))


# ------------------------------------------------------------------ stubs
def stub_up(port: int, path: str = "/__stub/stats") -> bool:
    try:
        with urlrequest.urlopen(f"http://127.0.0.1:{port}{path}", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def ensure_stubs() -> list[subprocess.Popen]:
    procs: list[subprocess.Popen] = []
    if not stub_up(STUB_ENCODER_PORT):
        env = dict(os.environ, STUB_ENCODER_TOKEN=STUB_ENCODER_TOKEN)
        procs.append(subprocess.Popen(
            [sys.executable, os.path.join(SCRIPT_DIR, "stub_encoder.py"),
             "--port", str(STUB_ENCODER_PORT)],
            cwd=PROJECT_DIR, env=env))
    if not stub_up(STUB_LLM_PORT):
        procs.append(subprocess.Popen(
            [sys.executable, os.path.join(SCRIPT_DIR, "stub_llm.py"),
             "--port", str(STUB_LLM_PORT)],
            cwd=PROJECT_DIR))
    for _ in range(50):
        if stub_up(STUB_ENCODER_PORT) and stub_up(STUB_LLM_PORT):
            return procs
        time.sleep(0.2)
    raise Refused("stub servers did not come up on "
                  f"{STUB_ENCODER_PORT}/{STUB_LLM_PORT}")


def stub_config(port: int, payload: dict) -> None:
    http(f"http://127.0.0.1:{port}", None, "POST", "/__stub/config", body=payload)


def stub_stats(port: int) -> dict:
    _, _, text = http(f"http://127.0.0.1:{port}", None, "GET", "/__stub/stats")
    return json.loads(text)


# ----------------------------------------------------------------- harness
def harness_up() -> bool:
    try:
        with urlrequest.urlopen(f"{HARNESS_URL}/health", timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def ensure_harness(base: str, svc: str) -> subprocess.Popen | None:
    """Spawn tests/serve_local.ts (host Deno harness) unless one answers.
    Returns the process (terminate in teardown) or None if already up."""
    if harness_up():
        return None
    npx = shutil.which("npx") or "npx"
    cmd = [npx, "-y", "deno@2.1.4", "run", "--allow-net", "--allow-env",
           "--allow-read",  # dynamic import of the function modules
           os.path.join(SCRIPT_DIR, "serve_local.ts"), str(HARNESS_PORT)]
    if os.name == "nt":
        cmd = ["cmd", "/c"] + cmd
    env = dict(os.environ, SUPABASE_URL=base, SUPABASE_SERVICE_ROLE_KEY=svc)
    log_fh = open(HARNESS_LOG, "w", encoding="utf-8")
    proc = subprocess.Popen(cmd, cwd=PROJECT_DIR, env=env,
                            stdout=log_fh, stderr=subprocess.STDOUT)
    proc._log_fh = log_fh  # type: ignore[attr-defined]  # closed in teardown

    def probe() -> str:
        """'up' | 'down:…' (nothing listening yet) | 'http_<n>' (server IS
        up but the handler failed — e.g. missing env; don't keep waiting)."""
        try:
            with urlrequest.urlopen(f"{HARNESS_URL}/health", timeout=5) as r:
                return "up" if r.status == 200 else f"http_{r.status}"
        except urlerror.HTTPError as exc:
            return f"http_{exc.code}"
        except Exception as exc:  # noqa: BLE001 - refused/timeout = still down
            return f"down: {type(exc).__name__}"

    def bail(msg: str) -> None:
        # Never leave the child running when we refuse to start the suite
        # (the outer harness_proc is only assigned on success).
        kill_proc_tree(proc)
        log_fh.close()
        raise Refused(msg)

    # First run may download deno via npx — be patient (cold start >30s seen).
    for _ in range(450):
        state = probe()
        if state == "up":
            return proc
        if state.startswith("http_"):
            bail(f"local harness is serving on :{HARNESS_PORT} but health "
                 f"returned {state[5:]} — likely missing SUPABASE_URL env; "
                 f"see {HARNESS_LOG}")
        if proc.poll() is not None:
            bail("serve_local.ts exited early — see "
                 f"{HARNESS_LOG}; to debug run:\n  npx -y deno@2.1.4 "
                 "run --allow-net --allow-env --allow-read "
                 "tests/serve_local.ts")
        time.sleep(0.2)
    bail(f"local harness did not come up on :{HARNESS_PORT} "
         f"(last probe: {probe()}) — see {HARNESS_LOG}")
    return None  # unreachable; bail() always raises


def kill_proc_tree(p: subprocess.Popen) -> None:
    """Terminate a spawned process AND its children.

    On Windows the harness is spawned as `cmd /c npx deno@… run …`, so a
    plain terminate() kills only cmd.exe and leaves the deno listener alive
    (observed 2026-10-24). taskkill /T walks the tree; other platforms use
    terminate() (stubs are direct child processes there).
    """
    if p.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)],
                       capture_output=True)
    else:
        p.terminate()


# ---------------------------------------------------------------- fixtures
def gen_key(prefix: str) -> str:
    return prefix + secrets.token_urlsafe(32)  # 43 chars -> 51 total


def make_key(base: str, svc: str, tenant_id: str, prefix: str,
             label: str, revoked: bool = False) -> tuple[str, str]:
    """Register a key via create_api_key; returns (plaintext, key_id)."""
    plaintext = gen_key(prefix)
    key_hash = hashlib.sha256(plaintext.encode()).hexdigest()
    env_name = "live" if prefix == "sk_live_" else "sandbox"
    status, parsed, text, _ = j(base, svc, "POST", "/rest/v1/rpc/create_api_key",
                                body={"p_tenant_id": tenant_id, "p_key_hash": key_hash,
                                      "p_key_prefix": plaintext[:12],
                                      "p_environment": env_name, "p_label": label})
    if status not in (200, 201):
        raise TestError(f"create_api_key({label}) -> {status}: {text[:200]}")
    key_id = parsed if isinstance(parsed, str) else str(parsed)
    if revoked:
        from datetime import datetime, timezone
        st, _, t2, _ = j(base, svc, "PATCH",
                         f"/rest/v1/api_keys?id=eq.{key_id}",
                         body={"revoked_at": datetime.now(timezone.utc).isoformat()})
        if st >= 300:
            raise TestError(f"revoking {label} failed: {st} {t2[:200]}")
    return plaintext, key_id


def insert_product(base: str, svc: str, tid: str, external_id: str, title: str,
                   section: str, text_for_vec: str, category: str | None = None,
                   colors: list[str] | None = None, price: float = 999.0) -> None:
    row = {
        "tenant_id": tid, "external_id": external_id, "title": title,
        "section": section, "category": category, "colors": colors or [],
        "price": price, "in_stock": True, "status": "active", "source": "manual",
        "product_url": f"https://example.invalid/p/{external_id}",
        "image_url": f"https://example.invalid/i/{external_id}.jpg",
        "attributes": {}, "embedding": vec(text_for_vec),
        "embedding_model": CANONICAL_MODEL,
    }
    rest_ok(base, svc, "POST", "/rest/v1/products", body=row,
            headers={"Prefer": "return=minimal"})


def drop_leftover_tenants(base: str, svc: str) -> None:
    """Remove leftovers of THIS suite's slugs (test_api_a/test_api_b) so a
    re-run starts clean. Never touches other tenants."""
    status, rows, text, _ = j(base, svc, "GET",
                              "/rest/v1/tenants?select=id,slug&limit=1000")
    if status != 200:
        return
    for t in rows or []:
        slug = t.get("slug", "")
        if slug in ("test_api_a", "test_api_b"):
            j(base, svc, "PATCH", f"/rest/v1/tenants?id=eq.{t['id']}",
              body={"status": "suspended"})
            j(base, svc, "POST", "/rest/v1/rpc/drop_tenant",
              body={"p_tenant_id": t["id"], "p_confirm_slug": slug})


# ------------------------------------------------------------ test cases

class Fx:
    """Ids and secrets shared across tests (never printed)."""
    base = ""
    svc = ""
    fns = ""
    tid_a = tid_b = ""
    kid_a_live = kid_a_sandbox = kid_a_revoked = ""
    kid_b_main = kid_b_r1 = kid_b_r2 = ""
    key_a_live = key_a_sandbox = key_a_revoked = ""
    key_b_main = key_b_r1 = key_b_r2 = ""


def a01_health(fx: Fx) -> None:
    status, parsed, text, _ = api(fx.fns, None, "GET", "/health")
    ok = (status == 200 and isinstance(parsed, dict)
          and parsed.get("status") == "ok"
          and parsed.get("dependencies", {}).get("database", {}).get("status") == "ok"
          and parsed.get("dependencies", {}).get("encoder", {}).get("model") == CANONICAL_MODEL
          and "request_id" in parsed)
    record("A01 health 200 ok + deps", ok,
           f"http={status} status={parsed.get('status') if isinstance(parsed, dict) else '?'}")


def a02_missing_auth(fx: Fx) -> None:
    status, parsed, text, _ = api(fx.fns, None, "POST", "/search", body={"query": "x"})
    ok = status == 401 and err_code(parsed) == "unauthorized" and "request_id" in text
    record("A02 401 missing Authorization", ok, f"http={status} code={err_code(parsed)}")


def a03_wrong_prefix(fx: Fx) -> None:
    bad_pk = "pk_live_" + secrets.token_urlsafe(32)      # reserved family, never issued
    bad_len = "sk_live_short"                            # wrong length
    c1 = err_code(api(fx.fns, None, "POST", "/search", body={"query": "x"},
                      headers={"Authorization": f"Bearer {bad_pk}"})[1])
    st2, p2, _, _ = api(fx.fns, None, "POST", "/search", body={"query": "x"},
                        headers={"Authorization": f"Bearer {bad_len}"})
    ok = c1 == "unauthorized" and st2 == 401 and err_code(p2) == "unauthorized"
    record("A03 401 wrong prefix (pk_) / malformed", ok, f"pk={c1} len={err_code(p2)}")


def a04_unknown_key(fx: Fx) -> None:
    ghost = gen_key("sk_live_")
    status, parsed, _, _ = api(fx.fns, None, "POST", "/search",
                               body={"query": "x"},
                               headers={"Authorization": f"Bearer {ghost}"})
    ok = status == 401 and err_code(parsed) == "unauthorized"
    record("A04 401 unknown well-formed key", ok, f"http={status} code={err_code(parsed)}")


def a05_revoked_key(fx: Fx) -> None:
    status, parsed, _, _ = api(fx.fns, None, "POST", "/search",
                               body={"query": "x"},
                               headers={"Authorization": f"Bearer {fx.key_a_revoked}"})
    ok = status == 401 and err_code(parsed) == "unauthorized"
    record("A05 401 revoked key", ok, f"http={status} code={err_code(parsed)}")


def a06_suspended_tenant(fx: Fx) -> None:
    j(fx.base, fx.svc, "PATCH", f"/rest/v1/tenants?id=eq.{fx.tid_a}",
      body={"status": "suspended"})
    try:
        status, parsed, _, _ = api(fx.fns, None, "POST", "/search",
                                   body={"query": "x"},
                                   headers={"Authorization": f"Bearer {fx.key_a_live}"})
    finally:
        j(fx.base, fx.svc, "PATCH", f"/rest/v1/tenants?id=eq.{fx.tid_a}",
          body={"status": "active"})
    ok = status == 403 and err_code(parsed) == "forbidden"
    record("A06 403 suspended tenant", ok, f"http={status} code={err_code(parsed)}")


def a07_search_ok(fx: Fx) -> None:
    status, parsed, text, hdrs = api(fx.fns, None, "POST", "/search",
                                     body={"query": "blue cotton kurta"},
                                     headers={"Authorization": f"Bearer {fx.key_a_live}"})
    keys_ok = isinstance(parsed, dict) and set(parsed.keys()) == {"request_id", "items", "no_match"}
    items = (parsed or {}).get("items", []) if isinstance(parsed, dict) else []
    first = items[0] if items else None
    ok = (status == 200 and keys_ok and parsed.get("no_match") is False
          and len(items) >= 1
          and all(i["product"]["external_id"].startswith("sku-a-") for i in items)
          and first["similarity"] >= 0.99
          and first["section"] == "top"
          and set(first["product"].keys()) == {"external_id", "title", "price",
                                               "product_url", "image_url", "colors", "in_stock"})
    record("A07 search exact match (same tenant)", ok,
           f"http={status} items={len(items)} sim={first['similarity'] if first else '-'}")


def a08_no_match(fx: Fx) -> None:
    status, parsed, _, _ = api(fx.fns, None, "POST", "/search",
                               body={"query": "qzx quantum rocket foam", "min_similarity": 0.9},
                               headers={"Authorization": f"Bearer {fx.key_a_live}"})
    ok = (status == 200 and isinstance(parsed, dict)
          and parsed.get("no_match") is True and parsed.get("items") == [])
    record("A08 no_match = 200 + empty + flag", ok, f"http={status} items={parsed.get('items') if isinstance(parsed, dict) else '?'}")


def a09_t15_forged_tenant(fx: Fx) -> None:
    """T15 promoted to a REAL HTTP check: forged tenant_id in body, query
    and header must all be ignored; tenant A's key never sees tenant B rows
    (identical vectors + canary titles make any leak visible)."""
    body = {"query": "blue cotton kurta",
            "tenant_id": fx.tid_b, "tenant_slug": "test_api_b"}
    path = f"/search?tenant_id={fx.tid_b}"
    status, parsed, raw, _ = api(
        fx.fns, None, "POST", path, body=body,
        headers={"Authorization": f"Bearer {fx.key_a_live}",
                 "X-Tenant-Id": fx.tid_b})
    items = (parsed or {}).get("items", []) if isinstance(parsed, dict) else []
    ok = (status == 200
          and len(items) >= 1
          and all(i["product"]["external_id"].startswith("sku-a-") for i in items)
          and "CANARY-B" not in raw and "sku-b-" not in raw
          and "tenant_id" not in raw)
    record("A09 T15 forged tenant ignored + isolation", ok,
           f"http={status} items={len(items)} leaked_b={'CANARY-B' in raw}")


def a10_model_mismatch(fx: Fx) -> None:
    stub_config(STUB_ENCODER_PORT, {"model": "wrong-model"})
    try:
        status, parsed, _, hdrs = api(fx.fns, None, "POST", "/search",
                                      body={"query": "blue cotton kurta"},
                                      headers={"Authorization": f"Bearer {fx.key_a_live}"})
    finally:
        stub_config(STUB_ENCODER_PORT, {"model": "fashion-clip"})
    ok = (status == 503 and err_code(parsed) == "upstream_encoder"
          and hdrs.get("Retry-After") == "5")
    record("A10 model-string mismatch -> 503", ok,
           f"http={status} code={err_code(parsed)} retry-after={hdrs.get('Retry-After')}")


def a11_encoder_down(fx: Fx) -> None:
    before = stub_stats(STUB_ENCODER_PORT).get("embed_attempts", 0)
    stub_config(STUB_ENCODER_PORT, {"fail_status": 500})
    try:
        status, parsed, _, hdrs = api(fx.fns, None, "POST", "/search",
                                      body={"query": "blue cotton kurta"},
                                      headers={"Authorization": f"Bearer {fx.key_a_live}"})
    finally:
        stub_config(STUB_ENCODER_PORT, {"fail_status": 0})
    delta = stub_stats(STUB_ENCODER_PORT).get("embed_attempts", 0) - before
    ok = (status == 503 and err_code(parsed) == "upstream_encoder"
          and hdrs.get("Retry-After") == "5" and delta >= 2)
    record("A11 encoder 500 -> retry then 503", ok,
           f"http={status} attempts_delta={delta} retry-after={hdrs.get('Retry-After')}")


def a12_unsupported_occasion(fx: Fx) -> None:
    status, parsed, _, _ = api(fx.fns, None, "POST", "/combos",
                               body={"occasion": "rave", "n_combos": 1},
                               headers={"Authorization": f"Bearer {fx.key_a_live}"})
    msg = parsed.get("error", {}).get("message", "") if isinstance(parsed, dict) else ""
    ok = (status == 422 and err_code(parsed) == "unsupported_occasion"
          and "office" in msg and "wedding" in msg)
    record("A12 422 unsupported occasion lists valid", ok,
           f"http={status} code={err_code(parsed)}")


def a13_occasions_per_tenant(fx: Fx) -> None:
    st_a, p_a, _, _ = api(fx.fns, None, "GET", "/occasions",
                          headers={"Authorization": f"Bearer {fx.key_a_live}"})
    st_b, p_b, _, _ = api(fx.fns, None, "GET", "/occasions",
                          headers={"Authorization": f"Bearer {fx.key_b_main}"})
    occ_a = {o["occasion"]: o["sections"] for o in (p_a or {}).get("occasions", [])}
    occ_b = {o["occasion"]: o["sections"] for o in (p_b or {}).get("occasions", [])}
    ok = (st_a == 200 and set(occ_a.keys()) == {"office", "wedding"}
          and occ_a["office"] == ["top", "bottom", "accessory"]
          and st_b == 200 and set(occ_b.keys()) == {"casual"})
    record("A13 occasions from tenant recipes only", ok,
           f"A={sorted(occ_a)} B={sorted(occ_b)}")


# Payload the stub LLM returns for the tenant-A "office" recipe
# (sections: top, bottom, accessory). Only the two `top` descriptions match
# real products; bottom/accessory have NO catalogue rows on purpose so the
# honest missing_sections path is exercised.
LLM_OK_COMBOS = {
    "combos": [
        {"title": "Monday office look", "items": [
            {"section": "top", "description": "blue cotton kurta"},
            {"section": "bottom", "description": "black tailored office trousers"},
            {"section": "accessory", "description": "minimal steel office watch"}]},
        {"title": "Meeting day look", "items": [
            {"section": "top", "description": "blue linen office shirt"},
            {"section": "bottom", "description": "black tailored office trousers"},
            {"section": "accessory", "description": "minimal steel office watch"}]},
    ]
}


def a14_combos_llm_partial(fx: Fx) -> None:
    stub_config(STUB_LLM_PORT, {"mode": "valid", "combos": LLM_OK_COMBOS})
    status, parsed, raw, hdrs = api(
        fx.fns, None, "POST", "/combos",
        body={"occasion": "office", "n_combos": 2},
        headers={"Authorization": f"Bearer {fx.key_a_live}"})
    problems = []
    if status != 200:
        problems.append(f"http={status}")
        parsed = parsed if isinstance(parsed, dict) else {}
    else:
        meta = parsed.get("meta", {})
        if meta.get("engine") != "llm":
            problems.append(f"engine={meta.get('engine')}")
        if meta.get("model") != CANONICAL_MODEL:
            problems.append(f"model={meta.get('model')}")
        if set(meta.get("latency_ms", {}).keys()) != {"llm", "embed", "search", "total"}:
            problems.append("latency_ms keys")
        if parsed.get("status") != "partial":
            problems.append(f"status={parsed.get('status')}")
        combos = parsed.get("combos", [])
        if len(combos) != 2:
            problems.append(f"combos={len(combos)}")
        else:
            c1, c2 = combos
            top1 = [i for i in c1["items"] if i["section"] == "top"]
            top2 = [i for i in c2["items"] if i["section"] == "top"]
            if not top1 or top1[0]["product"]["external_id"] != "sku-a-kurta" or top1[0]["similarity"] < 0.99:
                problems.append("c1 top != sku-a-kurta@1.0")
            if not top2 or top2[0]["product"]["external_id"] != "sku-a-shirt":
                problems.append("c2 top != sku-a-shirt")
            if c1["missing_sections"] != ["bottom", "accessory"]:
                problems.append(f"c1 missing={c1['missing_sections']}")
            if c2["missing_sections"] != ["bottom", "accessory"]:
                problems.append(f"c2 missing={c2['missing_sections']}")
            all_ids = [i["product"]["external_id"] for c in combos for i in c["items"]]
            if len(all_ids) != len(set(all_ids)):
                problems.append("duplicate product across combos")
        st = hdrs.get("Server-Timing", "")
        for part in ("llm;", "embed;", "search;", "total;"):
            if part not in st:
                problems.append(f"Server-Timing missing {part}")
    record("A14 combos LLM path (partial + dedupe)", not problems,
           "; ".join(problems) if problems else "engine=llm partial, tops correct, dedup ok")


def a15_llm_fallback(fx: Fx) -> None:
    before = stub_stats(STUB_LLM_PORT).get("llm_calls", 0)
    stub_config(STUB_LLM_PORT, {"mode": "invalid_json_always"})
    try:
        status, parsed, _, _ = api(
            fx.fns, None, "POST", "/combos",
            body={"occasion": "office", "n_combos": 2},
            headers={"Authorization": f"Bearer {fx.key_a_live}"})
    finally:
        stub_config(STUB_LLM_PORT, {"mode": "valid"})
    delta = stub_stats(STUB_LLM_PORT).get("llm_calls", 0) - before
    problems = []
    if status != 200:
        problems.append(f"http={status}")
    else:
        if parsed.get("meta", {}).get("engine") != "recipe_fallback":
            problems.append(f"engine={parsed.get('meta', {}).get('engine')}")
        if delta != 2:
            problems.append(f"llm_attempts={delta} (want 2 = retry)")
        if parsed.get("status") != "no_match":
            problems.append(f"status={parsed.get('status')}")
        for c in parsed.get("combos", []):
            if c["items"]:
                problems.append("fallback filled items with junk")
            if sorted(c["missing_sections"]) != ["accessory", "bottom", "top"]:
                problems.append(f"missing={c['missing_sections']}")
    record("A15 LLM invalid JSON -> retry -> recipe fallback", not problems,
           "; ".join(problems) if problems else f"engine=recipe_fallback, llm_attempts={delta}, no junk")


def a16_llm_retry_success(fx: Fx) -> None:
    before = stub_stats(STUB_LLM_PORT).get("llm_calls", 0)
    stub_config(STUB_LLM_PORT, {"mode": "invalid_json_once", "combos": LLM_OK_COMBOS})
    try:
        status, parsed, _, _ = api(
            fx.fns, None, "POST", "/combos",
            body={"occasion": "office", "n_combos": 2},
            headers={"Authorization": f"Bearer {fx.key_a_live}"})
    finally:
        stub_config(STUB_LLM_PORT, {"mode": "valid"})
    delta = stub_stats(STUB_LLM_PORT).get("llm_calls", 0) - before
    engine = parsed.get("meta", {}).get("engine") if isinstance(parsed, dict) else None
    ok = status == 200 and engine == "llm" and delta == 2
    record("A16 LLM bad JSON once -> retry succeeds", ok,
           f"http={status} engine={engine} attempts={delta}")


def a17_encoder_slow(fx: Fx) -> None:
    before = stub_stats(STUB_ENCODER_PORT).get("embed_attempts", 0)
    stub_config(STUB_ENCODER_PORT, {"delay_s": 12})   # > the 10 s client timeout
    t0 = time.time()
    try:
        status, parsed, _, hdrs = api(fx.fns, None, "POST", "/search",
                                      body={"query": "blue cotton kurta"},
                                      headers={"Authorization": f"Bearer {fx.key_a_live}"})
    finally:
        stub_config(STUB_ENCODER_PORT, {"delay_s": 0})
    wall = time.time() - t0
    delta = stub_stats(STUB_ENCODER_PORT).get("embed_attempts", 0) - before
    ok = (status == 503 and err_code(parsed) == "upstream_encoder"
          and hdrs.get("Retry-After") == "5" and delta >= 2)
    record("A17 encoder slow -> timeout + one retry -> 503", ok,
           f"http={status} attempts_delta={delta} wall={wall:.1f}s")


def a18_rate_limit_per_key(fx: Fx) -> None:
    settings_b = {"min_similarity": 0.25,
                  "combos": {"casual": ["top", "footwear"]},
                  "rate_limit_per_min": 2}
    j(fx.base, fx.svc, "PATCH", f"/rest/v1/tenants?id=eq.{fx.tid_b}",
      body={"settings": settings_b})
    try:
        codes = []
        hdrs_429: dict = {}
        for _ in range(3):
            st, _, _, hdrs = api(fx.fns, None, "GET", "/occasions",
                                 headers={"Authorization": f"Bearer {fx.key_b_r1}"})
            codes.append(st)
            if st == 429:
                hdrs_429 = hdrs
                break
        st_alt, _, _, _ = api(fx.fns, None, "GET", "/occasions",
                              headers={"Authorization": f"Bearer {fx.key_b_r2}"})
        st_a, _, _, _ = api(fx.fns, None, "GET", "/occasions",
                            headers={"Authorization": f"Bearer {fx.key_a_live}"})
    finally:
        settings_b["rate_limit_per_min"] = 60
        j(fx.base, fx.svc, "PATCH", f"/rest/v1/tenants?id=eq.{fx.tid_b}",
          body={"settings": settings_b})
    problems = []
    if codes != [200, 200, 429]:
        problems.append(f"codes={codes}")
    if hdrs_429.get("Retry-After") != "60":
        problems.append(f"Retry-After={hdrs_429.get('Retry-After')}")
    if st_alt != 200:
        problems.append(f"per-key isolation: 2nd key got {st_alt}")
    if st_a != 200:
        problems.append(f"global isolation: tenant A got {st_a}")
    record("A18 429 per-key rate limit (+Retry-After)", not problems,
           "; ".join(problems) if problems else
           f"codes={codes}, Retry-After=60, 2nd key 200, tenant A 200")


def a19_cors_allowlist(fx: Fx) -> None:
    st1, _, _, h1 = api(fx.fns, None, "OPTIONS", "/search",
                        headers={"Origin": ALLOWED_ORIGIN})
    st2, _, _, h2 = api(fx.fns, None, "OPTIONS", "/search",
                        headers={"Origin": "https://evil.example"})
    st3, _, _, h3 = api(fx.fns, None, "POST", "/search", body={"query": "x"},
                        headers={"Origin": "https://evil.example"})  # 401, no echo
    st4, _, _, h4 = api(fx.fns, None, "POST", "/search", body={"query": "x"},
                        headers={"Origin": ALLOWED_ORIGIN,
                                 "Authorization": f"Bearer {fx.key_a_live}"})
    problems = []
    def acao(h):
        if hasattr(h, "get_all"):
            return h.get_all("Access-Control-Allow-Origin") or []
        v = h.get("Access-Control-Allow-Origin")
        return [v] if v is not None else []
    acao1, acao2, acao3, acao4 = acao(h1), acao(h2), acao(h3), acao(h4)
    if st1 != 204 or acao1 != [ALLOWED_ORIGIN]:
        problems.append(f"allowed preflight {st1} acao={acao1}")
    if acao2 != [] :
        problems.append(f"disallowed preflight acao={acao2}")
    if acao3 != []:
        problems.append(f"disallowed POST status={st3} acao={acao3}")
    if st4 != 200 or acao4 != [ALLOWED_ORIGIN]:
        problems.append(f"allowed POST {st4} acao={acao4}")
    record("A19 CORS allowlist (never *, no echo)", not problems,
           "; ".join(problems) if problems else "allowed ok, disallowed not echoed")


def a20_sandbox_usage(fx: Fx) -> None:
    st, _, _, _ = api(fx.fns, None, "GET", "/occasions",
                      headers={"Authorization": f"Bearer {fx.key_a_sandbox}"})
    rows = rest_ok(fx.base, fx.svc, "GET",
                   f"/rest/v1/usage_events?key_id=eq.{fx.kid_a_sandbox}"
                   "&select=id,endpoint,status_code&limit=10")
    ok = st == 200 and len(rows) >= 1 and all(r["endpoint"] == "occasions" for r in rows)
    record("A20 sandbox key identifiable in usage", ok,
           f"http={st} usage_rows={len(rows)}")


def a21_one_usage_row_per_call(fx: Fx) -> None:
    marker = "apitmsearch0001"
    api(fx.fns, None, "POST", "/search", body={"query": "blue cotton kurta"},
        headers={"Authorization": f"Bearer {fx.key_a_live}",
                 "X-Request-Id": marker})
    rows = rest_ok(fx.base, fx.svc, "GET",
                   f"/rest/v1/usage_events?request_id=eq.{marker}&select=id,status_code")
    marker2 = "apitm401marker0001"
    api(fx.fns, None, "POST", "/search", body={"query": "x"},
        headers={"X-Request-Id": marker2})          # 401 -> no tenant -> no row
    rows2 = rest_ok(fx.base, fx.svc, "GET",
                    f"/rest/v1/usage_events?request_id=eq.{marker2}&select=id")
    ok = (len(rows) == 1 and rows[0].get("status_code") == 200 and len(rows2) == 0)
    record("A21 exactly one usage row/call; 401 excluded", ok,
           f"authed_rows={len(rows)} status={rows and rows[0].get('status_code')} "
           f"401_rows={len(rows2)}")


def a22_size_limits(fx: Fx) -> None:
    hdr = {"Authorization": f"Bearer {fx.key_a_live}"}
    problems = []
    st, p, _, _ = api(fx.fns, None, "POST", "/search",
                      body={"query": "q" * 301}, headers=hdr)
    if not (st == 400 and err_code(p) == "invalid_request"):
        problems.append(f"query301={st}")
    st, p, _, _ = api(fx.fns, None, "POST", "/combos",
                      body={"occasion": "office", "style_notes": "n" * 301},
                      headers=hdr)
    if not (st == 400 and err_code(p) == "invalid_request"):
        problems.append(f"style_notes301={st}")
    st, p, _, _ = api(fx.fns, None, "POST", "/combos",
                      body={"occasion": "office", "n_combos": 0}, headers=hdr)
    if not (st == 400 and err_code(p) == "invalid_request"):
        problems.append(f"n_combos0={st}")
    st, p, _, _ = api(fx.fns, None, "POST", "/combos",
                      body={"occasion": "office", "n_combos": 6}, headers=hdr)
    if not (st == 400 and err_code(p) == "invalid_request"):
        problems.append(f"n_combos6={st}")
    st, p, _, _ = api(fx.fns, None, "POST", "/search",
                      body={"query": "x", "colors": ["c"] * 11}, headers=hdr)
    if not (st == 400 and err_code(p) == "invalid_request"):
        problems.append(f"colors11={st}")
    oversize = json.dumps({"query": "x", "pad": "y" * 40000}).encode()
    st, p, _, _ = j(fx.fns, None, "POST", "/search", raw=oversize,
                    headers={"Authorization": f"Bearer {fx.key_a_live}"})
    if not (st == 400 and err_code(p) == "invalid_request"):
        problems.append(f"body40k={st} code={err_code(p)}")
    record("A22 size/length limits (400 invalid_request)", not problems,
           "; ".join(problems) if problems else "301-char fields, n_combos bounds, 11 colors, 40KB body all rejected")


def a23_response_hygiene(fx: Fx) -> None:
    problems = []
    _, _, raw_ok, _ = api(fx.fns, None, "POST", "/search",
                          body={"query": "blue cotton kurta"},
                          headers={"Authorization": f"Bearer {fx.key_a_live}"})
    for needle in ("sk_live", "sk_test", "tenant_id", "key_id", "sha256",
                   "service_role", "supabase.co"):
        if needle in raw_ok:
            problems.append(f"search leaked '{needle}'")
    _, p_combos, raw_combos, _ = api(
        fx.fns, None, "POST", "/combos",
        body={"occasion": "wedding", "n_combos": 1},
        headers={"Authorization": f"Bearer {fx.key_a_live}"})
    if isinstance(p_combos, dict):
        if set(p_combos.get("meta", {}).keys()) != {"model", "engine", "latency_ms"}:
            problems.append("combos meta keys")
        if set(p_combos.keys()) != {"request_id", "status", "occasion", "combos", "meta"}:
            problems.append(f"combos top keys={sorted(p_combos.keys())}")
    for needle in ("sk_live", "tenant_id", "key_id"):
        if needle in raw_combos:
            problems.append(f"combos leaked '{needle}'")
    _, p_422, raw_422, _ = api(fx.fns, None, "POST", "/combos",
                               body={"occasion": "nope"},
                               headers={"Authorization": f"Bearer {fx.key_a_live}"})
    if isinstance(p_422, dict) and set(p_422.keys()) != {"error"}:
        problems.append("422 envelope has extra top keys")
    if isinstance(p_422, dict) and set(p_422.get("error", {}).keys()) != {
            "code", "message", "request_id"}:
        problems.append("422 error object keys")
    record("A23 no internal fields / stable envelope", not problems,
           "; ".join(problems) if problems else "clean keys + envelope on 200/422")


def a24_schema_audit_green(fx: Fx) -> None:
    status, rows, text, _ = rpc(fx.base, fx.svc, "schema_audit", {})
    problems = []
    if status != 200 or not isinstance(rows, list):
        problems.append(f"http={status} {text[:120]}")
    else:
        offenders = [r for r in rows if r.get("offenders")]
        if offenders:
            problems.append(f"{len(offenders)} offending object(s): " +
                            ", ".join(r["obj_name"] for r in offenders[:5]))
        names = {r["obj_name"] for r in rows}
        if not any(n.startswith("catalog_facets(") for n in names):
            problems.append("catalog_facets missing from audit")
        if not any(n.startswith("product_by_external_id(") for n in names):
            problems.append("product_by_external_id missing from audit")
    record("A24 schema_audit green incl. new objects", not problems,
           "; ".join(problems) if problems else
           f"{len(rows) if isinstance(rows, list) else 0} objects, 0 offenders")


def a25_facets_isolation(fx: Fx) -> None:
    fa = rpc(fx.base, fx.svc, "catalog_facets", {"p_tenant_id": fx.tid_a})[1]
    fb = rpc(fx.base, fx.svc, "catalog_facets", {"p_tenant_id": fx.tid_b})[1]
    problems = []
    cats_a = {c for r in (fa or []) for c in (r.get("categories") or [])}
    cats_b = {c for r in (fb or []) for c in (r.get("categories") or [])}
    if not {"kurta", "shirt"} <= cats_a:
        problems.append(f"A cats={sorted(cats_a)}")
    if "bcanary_cat" not in cats_b:
        problems.append(f"B cats={sorted(cats_b)}")
    if "bcanary_cat" in cats_a:
        problems.append("B category leaked into A facets")
    if cats_a & cats_b:
        problems.append(f"shared categories {cats_a & cats_b}")
    if len(fa or []) != 11:
        problems.append(f"A rows={len(fa or [])} (want all 11 sections)")
    record("A25 catalog_facets tenant isolation", not problems,
           "; ".join(problems) if problems else
           f"A={sorted(cats_a)} B={sorted(cats_b)}")


def a26_anchor(fx: Fx) -> None:
    stub_config(STUB_LLM_PORT, {"mode": "valid", "combos": LLM_OK_COMBOS})
    status, parsed, _, _ = api(
        fx.fns, None, "POST", "/combos",
        body={"occasion": "office", "n_combos": 2, "base_external_id": "sku-a-kurta"},
        headers={"Authorization": f"Bearer {fx.key_a_live}"})
    problems = []
    if status != 200:
        problems.append(f"http={status}")
    else:
        for c in parsed.get("combos", []):
            tops = [i for i in c["items"] if i["section"] == "top"]
            if len(tops) != 1 or tops[0]["product"]["external_id"] != "sku-a-kurta":
                problems.append(f"{c['id']} top != anchor")
            elif tops[0]["similarity"] is not None:
                problems.append(f"{c['id']} anchor similarity not null")
    record("A26 base_external_id anchors its section", not problems,
           "; ".join(problems) if problems else "anchor in both combos, similarity null")


# ------------------------------------------------------------------ main
def main() -> int:
    load_dotenv_if_present()
    stub_procs: list[subprocess.Popen] = []
    harness_proc: subprocess.Popen | None = None
    fx = Fx()
    try:
        base, svc, fns = require_config()
        check_target_allowed(base)
    except Refused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 2
    fx.base, fx.svc, fx.fns = base, svc, fns

    if not os.environ.get("PILOT_FUNCTIONS_URL"):  # default = local harness
        try:
            harness_proc = ensure_harness(base, svc)
        except Refused as exc:
            print(f"REFUSED: {exc}", file=sys.stderr)
            return 2  # ensure_harness kills its own child before raising

    def stop_resources() -> None:
        """Kill spawned stubs + harness (and close the harness log).
        Idempotent — called on the early REFUSED exits below AND from main()'s
        finally, so no spawn path can leak a listener (found 2026-10-24:
        a REFUSED between harness spawn and the fixtures try/finally left
        both running)."""
        for p in stub_procs:
            try:
                kill_proc_tree(p)
            except Exception:
                pass
        if harness_proc is not None:
            try:
                kill_proc_tree(harness_proc)
            except Exception:
                pass
            fh = getattr(harness_proc, "_log_fh", None)
            if fh:
                try:
                    fh.close()
                except Exception:
                    pass

    try:
        stub_procs = ensure_stubs()
    except Refused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        stop_resources()
        return 2

    # Functions must already be served; give one clear diagnostic.
    try:
        st, _, _, _ = api(fns, None, "GET", "/health")
    except TestError as exc:
        print(f"REFUSED: {exc}\nRun: supabase functions serve --env-file "
              "supabase/functions/.env --no-verify-jwt\n(or check "
              f"{HARNESS_LOG} if this run should use the local harness)",
              file=sys.stderr)
        stop_resources()
        return 2
    if st == 404:
        print("REFUSED: functions not served (404). Run supabase functions serve.",
              file=sys.stderr)
        stop_resources()
        return 2

    print(f"target: {base}   functions: {fns}", flush=True)

    try:
        # ---- fixtures ------------------------------------------------------
        drop_leftover_tenants(base, svc)
        fx.tid_a = rpc_ok_tenant(base, svc, "test_api_a", {
            "currency": "INR", "min_similarity": 0.25, "default_limit": 10,
            "rate_limit_per_min": 60,
            "combos": {"office": ["top", "bottom", "accessory"],
                       "wedding": ["saree", "blouse", "jewellery"]},
        })
        fx.tid_b = rpc_ok_tenant(base, svc, "test_api_b", {
            "min_similarity": 0.25, "rate_limit_per_min": 60,
            "combos": {"casual": ["top", "footwear"]},
        })

        insert_product(base, svc, fx.tid_a, "sku-a-kurta",
                       "CANARY-A blue cotton kurta", "top", "blue cotton kurta",
                       category="kurta", colors=["blue"], price=999.0)
        insert_product(base, svc, fx.tid_a, "sku-a-shirt",
                       "CANARY-A blue linen office shirt", "top", "blue linen office shirt",
                       category="shirt", colors=["blue", "white"], price=1499.0)
        insert_product(base, svc, fx.tid_a, "sku-a-saree",
                       "CANARY-A silk wedding saree", "saree", "silk wedding saree",
                       category="saree", colors=["red"], price=8999.0)
        # Tenant B: IDENTICAL vectors to A's kurta/saree + its own category.
        insert_product(base, svc, fx.tid_b, "sku-b-kurta",
                       "CANARY-B blue cotton kurta", "top", "blue cotton kurta",
                       category="bcanary_cat", colors=["blue"], price=999.0)
        insert_product(base, svc, fx.tid_b, "sku-b-saree",
                       "CANARY-B silk wedding saree", "saree", "silk wedding saree",
                       category="bcanary_cat", colors=["red"], price=8999.0)

        fx.key_a_live, fx.kid_a_live = make_key(base, svc, fx.tid_a, "sk_live_", "a-live")
        fx.key_a_sandbox, fx.kid_a_sandbox = make_key(base, svc, fx.tid_a, "sk_test_", "a-sandbox")
        fx.key_a_revoked, fx.kid_a_revoked = make_key(base, svc, fx.tid_a, "sk_live_", "a-revoked",
                                                      revoked=True)
        fx.key_b_main, _ = make_key(base, svc, fx.tid_b, "sk_live_", "b-main")
        fx.key_b_r1, _ = make_key(base, svc, fx.tid_b, "sk_live_", "b-rate1")
        fx.key_b_r2, _ = make_key(base, svc, fx.tid_b, "sk_live_", "b-rate2")

        with open(KEY_FILE, "w", encoding="utf-8") as fh:
            fh.write("# LOCAL TEST KEYS - gitignored. Regenerate with "
                     "tools/issue_key.py; never share. Plaintext only here.\n")
            fh.write(json.dumps({
                "test_api_a_live": fx.key_a_live,
                "test_api_a_sandbox": fx.key_a_sandbox,
                "test_api_b_main": fx.key_b_main,
            }, indent=2) + "\n")

        print("fixtures ready (2 tenants, 5 products, 6 keys)\n", flush=True)

        for name, fn in [
            ("A01", lambda: a01_health(fx)),
            ("A02", lambda: a02_missing_auth(fx)),
            ("A03", lambda: a03_wrong_prefix(fx)),
            ("A04", lambda: a04_unknown_key(fx)),
            ("A05", lambda: a05_revoked_key(fx)),
            ("A06", lambda: a06_suspended_tenant(fx)),
            ("A07", lambda: a07_search_ok(fx)),
            ("A08", lambda: a08_no_match(fx)),
            ("A09", lambda: a09_t15_forged_tenant(fx)),
            ("A10", lambda: a10_model_mismatch(fx)),
            ("A11", lambda: a11_encoder_down(fx)),
            ("A12", lambda: a12_unsupported_occasion(fx)),
            ("A13", lambda: a13_occasions_per_tenant(fx)),
            ("A14", lambda: a14_combos_llm_partial(fx)),
            ("A15", lambda: a15_llm_fallback(fx)),
            ("A16", lambda: a16_llm_retry_success(fx)),
            ("A17", lambda: a17_encoder_slow(fx)),
            ("A18", lambda: a18_rate_limit_per_key(fx)),
            ("A19", lambda: a19_cors_allowlist(fx)),
            ("A20", lambda: a20_sandbox_usage(fx)),
            ("A21", lambda: a21_one_usage_row_per_call(fx)),
            ("A22", lambda: a22_size_limits(fx)),
            ("A23", lambda: a23_response_hygiene(fx)),
            ("A24", lambda: a24_schema_audit_green(fx)),
            ("A25", lambda: a25_facets_isolation(fx)),
            ("A26", lambda: a26_anchor(fx)),
        ]:
            try:
                fn()
            except Exception as exc:  # noqa: BLE001 - one crash must not kill the run
                record(name, False, f"exception: {type(exc).__name__}: {exc}")
    finally:
        # ---- teardown: restore stub config, drop OUR tenants, keys file ----
        try:
            stub_config(STUB_ENCODER_PORT,
                        {"model": "fashion-clip", "fail_status": 0, "delay_s": 0})
            stub_config(STUB_LLM_PORT, {"mode": "valid"})
        except Exception:
            pass
        try:
            drop_leftover_tenants(base, svc)
        except Exception:
            pass
        if os.path.isfile(KEY_FILE):
            try:
                os.remove(KEY_FILE)
            except OSError:
                pass
        stop_resources()

    print("\n" + "-" * 78)
    print(f"{'TEST':<6} {'RESULT':<7} DETAIL")
    print("-" * 78)
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    for name, ok, detail in RESULTS:
        print(f"{name:<6} {'PASS' if ok else 'FAIL':<7} {detail}")
    print("-" * 78)
    failed = len(RESULTS) - passed
    if failed:
        print(f"RESULT: FAIL — {failed} of {len(RESULTS)} test(s) failed")
        return 1
    print(f"RESULT: PASS — all {len(RESULTS)} tests passed")
    return 0


def rpc_ok_tenant(base: str, svc: str, slug: str, settings: dict) -> str:
    status, parsed, text, _ = rpc(base, svc, "create_tenant", {
        "p_slug": slug, "p_name": f"API test tenant {slug}",
        "p_embedding_model": CANONICAL_MODEL, "p_embedding_dim": DIM,
        "p_settings": settings,
    })
    if status != 200 or not isinstance(parsed, str):
        raise TestError(f"create_tenant({slug}) -> {status}: {text[:200]}")
    return parsed


if __name__ == "__main__":
    sys.exit(main())
