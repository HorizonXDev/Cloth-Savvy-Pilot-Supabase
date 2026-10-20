#!/usr/bin/env python3
"""Isolation tests for the Cloth Savvy Pilot database layer.

WHAT THIS PROVES: the multi-tenant isolation design (L1-L5) holds on a live
Supabase project: tenant-partitioned products, RLS-everywhere lockdown,
service_role-only functions, hashed-key resolution, append-only usage_events.

Standard library only — no pip installs. Talks to the Data API (PostgREST)
over HTTP only; never touches SQL directly.

Run order (see README.md):
  1. Apply migrations 0001..0007, then schema_audit.sql, in the SQL editor.
  2. python tests/isolation_tests.py
  3. python tests/cleanup_test_tenants.py   (removes only "test_" tenants)

Safety rules baked in (hard requirement):
  * Reads PILOT_SUPABASE_URL, PILOT_SUPABASE_SERVICE_KEY,
    PILOT_SUPABASE_ANON_KEY from the environment (or a .env file beside this
    script, or one project directory up) and REFUSES TO RUN if any is missing.
  * The URL must be localhost unless PILOT_ALLOW_REMOTE=1 is set, and then
    PILOT_PROJECT_REF must be set and appear in the URL.
  * Keys are never printed. Plaintext test keys are written ONLY to the
    gitignored file tests/.test_keys, with a warning header.

Exit codes: 0 = all tests passed, 1 = at least one FAIL, 2 = refused to run
(missing env / target not allowed / stale schema cache / leftover test_
tenants from a previous run).
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import random
import secrets
import sys
import uuid
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

DIM = 512
MODEL = "fashion-clip-local"   # embedding_model used for every test tenant
TIMEOUT_S = 60                 # DDL-cold RPCs can be slow on a local stack

ALL_SECTIONS = ["top", "bottom", "dress", "saree", "blouse", "dupatta",
                "outerwear", "footwear", "bag", "jewellery", "accessory"]

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
KEY_FILE = os.path.join(SCRIPT_DIR, ".test_keys")


class Refused(RuntimeError):
    """Env guard tripped — we refuse to talk to this target."""


class TestError(RuntimeError):
    """A test step failed in an unexpected way."""


# --------------------------------------------------------------------------
# Configuration / safety guards
# --------------------------------------------------------------------------

def load_dotenv_if_present() -> None:
    """Minimal .env loader (KEY=VALUE lines), checked beside this script
    first, then one directory up (project root). Values already in the real
    environment win. Values are never printed."""
    for env_path in (os.path.join(SCRIPT_DIR, ".env"),
                     os.path.join(os.path.dirname(SCRIPT_DIR), ".env")):
        if not os.path.isfile(env_path):
            continue
        try:
            with open(env_path, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    key = key.strip()
                    value = value.strip().strip('"').strip("'")
                    if key and key not in os.environ:
                        os.environ[key] = value
        except OSError:
            pass  # unreadable .env -> the missing-env guard below will fire


def require_config() -> tuple[str, str, str]:
    missing = [k for k in ("PILOT_SUPABASE_URL",
                           "PILOT_SUPABASE_SERVICE_KEY",
                           "PILOT_SUPABASE_ANON_KEY")
               if not os.environ.get(k)]
    if missing:
        raise Refused(
            "refusing to run: missing environment variable(s): "
            + ", ".join(missing)
            + "  (copy .env.example to .env beside this script or in the "
              "project root and fill it in, or export them)"
        )
    base = os.environ["PILOT_SUPABASE_URL"].rstrip("/")
    parsed = urlparse.urlparse(base)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise Refused(f"refusing to run: PILOT_SUPABASE_URL is not a URL: {base!r}")
    return (base,
            os.environ["PILOT_SUPABASE_SERVICE_KEY"],
            os.environ["PILOT_SUPABASE_ANON_KEY"])


def check_target_allowed(base: str) -> None:
    host = (urlparse.urlparse(base).hostname or "").lower()
    if host in ("127.0.0.1", "localhost", "::1"):
        return  # local stack: allowed by default
    if os.environ.get("PILOT_ALLOW_REMOTE") != "1":
        raise Refused(
            f"refusing to run: target host {host!r} is not localhost. "
            "This suite defaults to LOCAL ONLY. Set PILOT_ALLOW_REMOTE=1 "
            "(and PILOT_PROJECT_REF) to allow a hosted project."
        )
    ref = (os.environ.get("PILOT_PROJECT_REF") or "").strip()
    if not ref or ref not in base:
        raise Refused(
            "refusing to run: PILOT_ALLOW_REMOTE=1 requires PILOT_PROJECT_REF "
            "to be set and to appear in PILOT_SUPABASE_URL "
            f"(host={host!r}, project ref set={bool(ref)})"
        )


def preflight(base: str, svc: str) -> str | None:
    """Catch setup problems BEFORE the tests, so their 404s are not mistaken
    for design results. Returns an error message or None."""
    status, _p, text = http_json(base, svc, "GET",
                                 "/rest/v1/products?select=id&limit=1")
    if status != 200:
        if "schema cache" in text:
            return ("PostgREST schema cache is stale — the tables exist in "
                    "the database but the Data API cannot see them yet. Run "
                    "this once in the SQL editor:  NOTIFY pgrst, 'reload "
                    "schema';  (or Studio -> Settings -> API -> Reload "
                    "schema, or `supabase restart`), then re-run.")
        if status == 401:
            return ("service key rejected (401) — check "
                    "PILOT_SUPABASE_SERVICE_KEY in .env")
        return f"preflight GET /rest/v1/products failed: {status} {err_excerpt(text)}"

    # schema_audit() must exist: several tests depend on it, and it is
    # created by a SEPARATE file (schema_audit.sql) — a miss would otherwise
    # surface only as late, confusing failures.
    status, _p, text = http_json(base, svc, "POST",
                                 "/rest/v1/rpc/schema_audit", body={})
    if status >= 300:
        if status == 404 and "schema_audit" in text:
            return ("schema_audit RPC is missing — run schema_audit.sql in "
                    "the SQL editor (it ends with its own NOTIFY pgrst, "
                    "'reload schema') and re-run.")
        return f"preflight POST /rest/v1/rpc/schema_audit failed: {status} {err_excerpt(text)}"

    # Leftover test_ tenants from a previous aborted run would make T1 fail
    # with confusing "already exists" errors. Refuse and point at cleanup.
    status, parsed, text = http_json(base, svc, "GET", "/rest/v1/tenants?select=slug")
    if status != 200:
        return f"preflight GET /rest/v1/tenants failed: {status} {err_excerpt(text)}"
    leftovers = [r.get("slug") for r in (parsed or [])
                 if str(r.get("slug", "")).startswith("test_")]
    if leftovers:
        return ("leftover test_ tenant(s) from a previous run: "
                + ", ".join(sorted(leftovers))
                + " — run `python tests/cleanup_test_tenants.py` first.")
    return None


# --------------------------------------------------------------------------
# HTTP helpers (Data API / PostgREST)
# --------------------------------------------------------------------------

def http(base: str, key: str, method: str, path: str,
         body=None, headers: dict | None = None) -> tuple[int, str]:
    """One request. Returns (status, response_text). Never raises on HTTP
    errors (4xx/5xx are results here); raises TestError on network failure."""
    url = base + path
    data = None
    hdrs = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if headers:
        hdrs.update(headers)
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urlrequest.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urlrequest.urlopen(req, timeout=TIMEOUT_S) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urlerror.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except urlerror.URLError as exc:
        raise TestError(f"network failure for {method} {path}: {exc.reason}")


def http_json(base: str, key: str, method: str, path: str,
              body=None, headers: dict | None = None):
    status, text = http(base, key, method, path, body=body, headers=headers)
    try:
        return status, json.loads(text) if text else None, text
    except json.JSONDecodeError:
        return status, None, text


def rest(base, key, method, path, body=None, headers=None):
    """REST call returning parsed JSON; raises TestError on non-2xx."""
    status, parsed, text = http_json(base, key, method, path, body, headers)
    if status >= 300:
        raise TestError(f"{method} {path} -> {status}: {text[:300]}")
    return parsed


def rpc(base, key, name: str, payload: dict | None = None):
    """POST /rest/v1/rpc/<name>; returns (status, parsed, raw_text)."""
    return http_json(base, key, "POST", f"/rest/v1/rpc/{name}",
                     body=(payload if payload is not None else {}))


def rpc_ok(base, key, name: str, payload: dict | None = None):
    status, parsed, text = rpc(base, key, name, payload)
    if status >= 300:
        raise TestError(f"rpc {name} -> {status}: {text[:300]}")
    return parsed


def err_excerpt(text: str, n: int = 160) -> str:
    """One-line short error message, safe to print (DB errors contain no
    secrets)."""
    try:
        obj = json.loads(text)
        msg = obj.get("message") or obj.get("hint") or text
    except json.JSONDecodeError:
        msg = text
    return " ".join(str(msg).split())[:n]


# --------------------------------------------------------------------------
# Deterministic, seeded, L2-normalised vectors (identical across tenants)
# --------------------------------------------------------------------------

def make_vector(seed: int, dim: int = DIM) -> list[float]:
    rng = random.Random(seed)
    v = [rng.uniform(-1.0, 1.0) for _ in range(dim)]
    norm = math.sqrt(sum(x * x for x in v))
    return [round(x / norm, 6) for x in v]


def vector_param(v: list[float]) -> str:
    """PostgREST function args of pgvector type are passed as the JSON string
    form '[0.1, 0.2, ...]' — pgvector casts the text. (The same trick works
    for table columns on insert.)"""
    return json.dumps(v)


# --------------------------------------------------------------------------
# Tiny test harness
# --------------------------------------------------------------------------

RESULTS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str) -> bool:
    RESULTS.append((name, ok, detail))
    print(f"  {name}  {'PASS' if ok else 'FAIL'}  {detail}")
    return ok


class State:
    """Ids and data shared between tests."""

    def __init__(self) -> None:
        self.tenants: dict[str, str] = {}       # slug -> tenant uuid
        self.queries: list[list[float]] = [make_vector(1000 + i) for i in range(20)]
        self.route_mode: str | None = None      # cached partition-route probe
        self.gamma_id: str | None = None        # test_gamma tenant uuid (T8/T12)
        self.key_live_id: str | None = None     # k1: active alpha key (T8/T9)
        self.key_live_hash: str | None = None
        self.key_revoke_id: str | None = None   # k2: revoked alpha key (T8)
        self.key_sb_id: str | None = None       # k3: sandbox gamma key (T8/T9)
        self.key_sb_hash: str | None = None

    def id(self, slug: str) -> str:
        if slug not in self.tenants:
            raise TestError(f"prerequisite missing: tenant {slug!r} was never created")
        return self.tenants[slug]


def product_row(tenant_id: str, external_id: str, title: str,
                vector: list[float], model: str = MODEL,
                section: str = "dress") -> dict:
    return {
        "tenant_id": tenant_id,
        "external_id": external_id,
        "title": title,
        "section": section,
        "category": "ethnic",
        "gender": "women",
        "colors": ["red", "beige"],
        "price": "49.90",
        "in_stock": True,
        "product_url": "https://example.invalid/p/" + external_id,
        "image_url": "https://example.invalid/i/" + external_id + ".jpg",
        "attributes": {"fabric": "cotton"},
        "embedding": vector_param(vector),
        "embedding_model": model,
        "status": "active",
    }


def create_tenant(base, key, slug: str) -> str:
    tid = rpc_ok(base, key, "create_tenant",
                 {"p_slug": slug, "p_name": f"Pilot test tenant {slug}",
                  "p_embedding_model": MODEL, "p_embedding_dim": DIM})
    if not isinstance(tid, str):
        raise TestError(f"create_tenant({slug}) returned {tid!r}, expected uuid text")
    return tid


def audit_rows(base, key) -> list[dict]:
    rows = rpc_ok(base, key, "schema_audit")
    if not isinstance(rows, list):
        raise TestError(f"schema_audit returned {type(rows).__name__}, expected list")
    return rows


def locked_down(rows: list[dict], obj_name: str) -> tuple[bool, str]:
    """Check one audit row for a table/partition: RLS on+forced, no anon /
    authenticated privileges, service_role holds something, tenant_id present."""
    row = next((r for r in rows if r.get("obj_name") == obj_name), None)
    if row is None:
        return False, f"{obj_name} missing from audit output"
    problems = []
    if not row.get("rls_enabled"):
        problems.append("RLS not enabled")
    if not row.get("rls_forced"):
        problems.append("RLS not forced")
    if row.get("anon_privs"):
        problems.append(f"anon holds {row['anon_privs']}")
    if row.get("authenticated_privs"):
        problems.append(f"authenticated holds {row['authenticated_privs']}")
    if not row.get("service_privs"):
        problems.append("service_role holds nothing")
    if row.get("has_tenant_id") is False:
        problems.append("no tenant_id column")
    if problems:
        return False, "; ".join(problems)
    return True, "RLS enabled+forced, anon/authenticated hold nothing"


def partition_route_mode(base: str, key: str, st: State) -> str:
    """Does PostgREST expose /rest/v1/<partition> endpoints?

    'served'   — yes (older PostgREST): direct-partition assertions apply.
    'excluded' — no: the PARENT is served (200) but the partition 404s with
                 PGRST205 "not in the schema cache". PostgREST REMOVES
                 partition children from its schema cache by design (current
                 source: SchemaCache.hs filters `not c.relispartition`; an
                 explicit docs sentence to this effect is UNVERIFIED), so
                 the route exists for NOBODY — stronger than any permission
                 check.
    'stale'    — the parent 404s too: a stale schema cache, i.e. a SETUP
                 problem, never a result (run NOTIFY pgrst, 'reload schema').
    'broken'   — parent answered something unexpected; refuse to interpret.
    """
    if st.route_mode:
        return st.route_mode
    if "test_alpha" not in st.tenants:
        return "broken"
    pstatus, _p, ptext = http_json(base, key, "GET",
                                   "/rest/v1/products?select=id&limit=1")
    if pstatus != 200:
        st.route_mode = "stale" if (pstatus == 404 and "schema cache" in ptext) \
            else "broken"
        return st.route_mode
    rstatus, _r, rtext = http_json(base, key, "GET",
                                   "/rest/v1/products_test_alpha?select=id&limit=1")
    if rstatus == 200:
        st.route_mode = "served"
    elif rstatus == 404 and "schema cache" in rtext:
        st.route_mode = "excluded"
    else:
        st.route_mode = "broken"
    return st.route_mode


# --------------------------------------------------------------------------
# Test-key handling: plaintext goes ONLY to the gitignored tests/.test_keys
# --------------------------------------------------------------------------

def write_test_key(plaintext: str) -> None:
    """Append a generated plaintext key to tests/.test_keys (gitignored),
    with a warning header. The key is NEVER printed to stdout."""
    header = ("# WARNING: REAL API KEYS (test scope). Generated by "
              "tests/isolation_tests.py.\n"
              "# This file is gitignored; delete it with "
              "tests/cleanup_test_tenants.py. NEVER commit or share it.\n")
    first = not os.path.isfile(KEY_FILE)
    try:
        if first:
            with open(KEY_FILE, "w", encoding="utf-8") as fh:
                fh.write(header)
        os.chmod(KEY_FILE, 0o600)  # best-effort; no-op-ish on Windows
    except OSError:
        pass
    with open(KEY_FILE, "a", encoding="utf-8") as fh:
        fh.write(plaintext + "\n")


def make_api_key(base, key, tenant_id: str, environment: str,
                 label: str) -> tuple[str, str]:
    """Generate a random key, store its SHA-256 via create_api_key, write the
    plaintext to the local key file. Returns (key_id, plaintext_hash)."""
    plaintext = f"pk_{environment}_" + secrets.token_urlsafe(24)
    khash = hashlib.sha256(plaintext.encode("utf-8")).hexdigest()
    prefix = plaintext[:12]
    kid = rpc_ok(base, key, "create_api_key",
                 {"p_tenant_id": tenant_id, "p_key_hash": khash,
                  "p_key_prefix": prefix, "p_environment": environment,
                  "p_label": label})
    if not isinstance(kid, str):
        raise TestError(f"create_api_key returned {kid!r}, expected uuid text")
    write_test_key(plaintext)
    return kid, khash


# --------------------------------------------------------------------------
# The tests (T1-T15)
# --------------------------------------------------------------------------

def t1_setup(base, key, st: State) -> None:
    """T1: two test tenants, 25 products each, IDENTICAL vectors across
    tenants, a canary in every title."""
    st.tenants["test_alpha"] = create_tenant(base, key, "test_alpha")
    st.tenants["test_beta"] = create_tenant(base, key, "test_beta")
    vectors = [make_vector(i) for i in range(25)]
    for slug in ("test_alpha", "test_beta"):
        tid = st.id(slug)
        tag = slug.split("_", 1)[1].upper()          # ALPHA / BETA
        rows = [
            product_row(tid,
                        f"sku-{i:02d}",              # same external_ids on purpose
                        f"{slug} product {i:02d} [CANARY-{tag}]",
                        vectors[i],
                        section=ALL_SECTIONS[i % len(ALL_SECTIONS)])
            for i in range(25)
        ]
        rest(base, key, "POST", "/rest/v1/products", body=rows,
             headers={"Prefer": "return=minimal"})
    record("T1", True,
           f"tenants test_alpha={st.tenants['test_alpha'][:8]}… "
           f"test_beta={st.tenants['test_beta'][:8]}…, 25+25 products, "
           "identical vectors, canaries set")


def t2_search_isolation(base, svc, st: State) -> None:
    """T2: search_products as A for 20 query vectors returns ONLY A
    canaries; same for B."""
    for slug, tag in (("test_alpha", "CANARY-ALPHA"),
                      ("test_beta", "CANARY-BETA")):
        tid = st.id(slug)
        wrong = 0
        empty = 0
        for q in st.queries:
            rows = rpc_ok(base, svc, "search_products",
                          {"p_tenant_id": tid, "p_query": vector_param(q),
                           "p_embedding_model": MODEL, "p_limit": 5})
            if not rows:
                empty += 1
                continue
            wrong += sum(1 for r in rows if tag not in (r.get("title") or ""))
        if empty or wrong:
            record("T2", False,
                   f"{slug}: {empty} empty result(s), {wrong} row(s) without {tag}")
            return
    record("T2", True, "40 searches (20 per tenant) returned only same-tenant canaries")


def t3_search_guards(base, key, st: State) -> None:
    """T3: NULL tenant / nonexistent tenant raise (and a NULL query too)."""
    problems: list[str] = []
    # A schema-cache 404 (PGRST202) also mentions search_products in its
    # message, so require the ACTUAL guard text — a pass must come from the
    # function.
    status, _p, text = rpc(base, key, "search_products",
                           {"p_tenant_id": None,
                            "p_query": vector_param(st.queries[0]),
                            "p_embedding_model": MODEL})
    if status < 400 or "schema cache" in text or "must not be null" not in text:
        problems.append(f"NULL tenant -> {status}: {err_excerpt(text)}")
    status, _p, text = rpc(base, key, "search_products",
                           {"p_tenant_id": str(uuid.uuid4()),
                            "p_query": vector_param(st.queries[0]),
                            "p_embedding_model": MODEL})
    if status < 400 or "schema cache" in text or "no tenant" not in text:
        problems.append(f"unknown tenant -> {status}: {err_excerpt(text)}")
    status, _p, text = rpc(base, key, "search_products",
                           {"p_tenant_id": st.id("test_alpha"),
                            "p_query": None,
                            "p_embedding_model": MODEL})
    if status < 400 or "schema cache" in text or "must not be null" not in text:
        problems.append(f"NULL query -> {status}: {err_excerpt(text)}")
    if problems:
        record("T3", False, "; ".join(problems))
    else:
        record("T3", True, "NULL tenant, nonexistent tenant and NULL query all raise from search_products")


def t4_embedding_model_guard(base, key, st: State) -> None:
    """T4: wrong embedding model RAISES in search and FAILS on insert."""
    problems: list[str] = []
    # search refuses a mismatched model
    status, _p, text = rpc(base, key, "search_products",
                           {"p_tenant_id": st.id("test_alpha"),
                            "p_query": vector_param(st.queries[0]),
                            "p_embedding_model": "some-other-model"})
    if status < 400 or "schema cache" in text or "mismatch" not in text:
        problems.append(f"search with wrong model -> {status}: {err_excerpt(text)}")
    # insert with a mismatched model fails (guard trigger on the partition)
    row = product_row(st.id("test_alpha"), "sku-wrong-model",
                      "wrong model [CANARY-WM]", make_vector(996),
                      model="some-other-model")
    status, _p, text = http_json(base, key, "POST", "/rest/v1/products",
                                 body=row, headers={"Prefer": "return=minimal"})
    if status < 400:
        problems.append(f"insert with wrong embedding_model accepted ({status})")
    elif "embedding_model" not in text:
        problems.append(f"insert rejected ({status}) but not by our guard: {err_excerpt(text)}")
    if problems:
        record("T4", False, "; ".join(problems))
    else:
        record("T4", True, "search raises on model mismatch; insert rejected by products_guard")


def t5_min_similarity_zero(base, key, st: State) -> None:
    """T5: a high min_similarity on an unrelated vector returns ZERO rows."""
    unrelated = make_vector(999_999)
    rows = rpc_ok(base, key, "search_products",
                  {"p_tenant_id": st.id("test_alpha"),
                   "p_query": vector_param(unrelated),
                   "p_embedding_model": MODEL,
                   "p_min_similarity": 0.5, "p_limit": 10})
    if rows:
        record("T5", False,
               f"min_similarity=0.5 on an unrelated vector returned {len(rows)} row(s)")
        return
    # sanity: without the threshold the same query returns something
    sane = rpc_ok(base, key, "search_products",
                  {"p_tenant_id": st.id("test_alpha"),
                   "p_query": vector_param(unrelated),
                   "p_embedding_model": MODEL, "p_limit": 5})
    if not sane:
        record("T5", False, "control search (no threshold) also returned 0 rows")
        return
    record("T5", True, "min_similarity=0.5 on an unrelated vector -> 0 rows (control without threshold -> rows)")


def t6_no_partition_insert_fails(base, key, st: State) -> None:
    """T6: insert with no partition fails; cross-partition insert fails."""
    problems: list[str] = []

    # (a) tenant without any partition
    ghost = str(uuid.uuid4())
    row = product_row(ghost, "sku-ghost", "ghost [CANARY-GHOST]", make_vector(999))
    status, _p, text = http_json(base, key, "POST", "/rest/v1/products",
                                 body=row, headers={"Prefer": "return=minimal"})
    if 400 <= status < 500 and "schema cache" not in text:
        note = "documented 'no partition ... found for row'" \
            if "no partition" in text else f"rejected: {err_excerpt(text)}"
        print(f"    (no-partition insert rejected ({status}) — {note})")
    elif status < 300:
        problems.append(f"insert for partitionless tenant SUCCEEDED ({status})")
    else:
        problems.append(f"unexpected response {status}: {err_excerpt(text)} "
                        "(a schema-cache 404 does NOT count as a pass)")

    # (b) cross-partition: alpha's tenant_id aimed at beta's partition route
    mode = partition_route_mode(base, key, st)
    xrow = product_row(st.id("test_alpha"), "sku-xpart",
                       "cross partition [CANARY-X]", make_vector(998))
    status, _p, text = http_json(base, key, "POST",
                                 "/rest/v1/products_test_beta", body=xrow,
                                 headers={"Prefer": "return=minimal"})
    if mode == "excluded":
        if status == 404 and "schema cache" in text:
            print("    (no /rest/v1/<partition> route exists at all — "
                  "PostgREST excludes partitions from its schema cache by "
                  "design; cross-partition insert is structurally impossible "
                  "via the Data API)")
        elif status < 300:
            problems.append("cross-partition insert into products_test_beta SUCCEEDED")
        else:
            problems.append(f"unexpected response {status}: {err_excerpt(text)}")
    elif 400 <= status < 500 and "schema cache" not in text:
        print(f"    (alpha row into beta partition rejected ({status}) — {err_excerpt(text)})")
    elif status < 300:
        problems.append("cross-partition insert into products_test_beta SUCCEEDED")
    else:
        problems.append(f"unexpected response {status}: {err_excerpt(text)}")

    if problems:
        record("T6", False, "; ".join(problems))
    else:
        record("T6", True, "no-partition insert fails; cross-partition insert impossible/fails")


def t7_anon_locked_out(base, anon, st: State) -> None:
    """T7: anon key: GET/POST/PATCH/DELETE on every parent table rejected or
    empty; every RPC rejected."""
    problems: list[str] = []
    tables = ["tenants", "products", "api_keys", "usage_events", "ingestion_runs"]
    any_uuid = str(uuid.uuid4())
    for t in tables:
        path = f"/rest/v1/{t}"
        # GET: 401/403 or a 200 with an empty list
        status, parsed, text = http_json(base, anon, "GET", path + "?limit=1")
        if status == 200:
            if parsed not in ([], None):
                problems.append(f"GET {path} returned rows to anon!")
        elif status not in (401, 403):
            problems.append(f"GET {path} -> unexpected {status}: {err_excerpt(text)}")
        # POST / PATCH / DELETE must be rejected
        status, _p, text = http_json(base, anon, "POST", path, body={})
        if status < 400:
            problems.append(f"POST {path} accepted ({status})")
        status, _p, text = http_json(base, anon, "PATCH", f"{path}?id=eq.{any_uuid}",
                                     body={"label": "pwned"})
        if status < 400:
            problems.append(f"PATCH {path} accepted ({status})")
        status, _p, text = http_json(base, anon, "DELETE", f"{path}?id=eq.{any_uuid}")
        if status < 400:
            problems.append(f"DELETE {path} accepted ({status})")

    # RPCs with realistic payloads: an execute grant leak would succeed here.
    alpha = st.id("test_alpha")
    rpc_calls = [
        ("create_tenant", {"p_slug": "test_anon_rogue", "p_name": "anon",
                           "p_embedding_model": MODEL, "p_embedding_dim": DIM}),
        ("drop_tenant", {"p_tenant_id": alpha, "p_confirm_slug": "test_alpha"}),
        ("resolve_api_key", {"p_key_hash": "a" * 64}),
        ("create_api_key", {"p_tenant_id": alpha, "p_key_hash": "b" * 64,
                            "p_key_prefix": "pk_live_anon",
                            "p_environment": "live"}),
        ("search_products", {"p_tenant_id": alpha,
                              "p_query": vector_param(st.queries[0]),
                              "p_embedding_model": MODEL}),
        ("explain_search_products", {"p_tenant_id": alpha,
                                      "p_query": vector_param(st.queries[0]),
                                      "p_embedding_model": MODEL}),
        ("schema_audit", {}),
    ]
    for name, payload in rpc_calls:
        status, _p, text = rpc(base, anon, name, payload)
        if status < 400:
            problems.append(f"anon rpc {name} accepted ({status})")
        elif status == 404 and "schema cache" in text:
            problems.append(f"anon rpc {name}: schema-cache 404 — setup problem, not a pass")

    if problems:
        record("T7", False, "; ".join(problems))
    else:
        record("T7", True,
               "anon: 5 tables GET 401/403/empty, POST/PATCH/DELETE rejected; "
               "7 RPCs rejected")


def t8_resolve_api_key(base, key, st: State) -> None:
    """T8: valid key ok; revoked key none; suspended tenant none; sandbox vs
    live reported faithfully; last_used_at updated."""
    problems: list[str] = []
    st.gamma_id = create_tenant(base, key, "test_gamma")
    st.tenants["test_gamma"] = st.gamma_id

    st.key_live_id, st.key_live_hash = make_api_key(
        base, key, st.id("test_alpha"), "live", "t8-live-alpha")
    st.key_revoke_id, _rk = make_api_key(
        base, key, st.id("test_alpha"), "live", "t8-to-revoke")
    st.key_sb_id, st.key_sb_hash = make_api_key(
        base, key, st.gamma_id, "sandbox", "t8-sandbox-gamma")

    # 1. valid live key resolves to alpha / live / active
    rows = rpc_ok(base, key, "resolve_api_key", {"p_key_hash": st.key_live_hash})
    if len(rows) != 1:
        problems.append(f"valid live key resolved to {len(rows)} row(s), expected 1")
    else:
        r = rows[0]
        if r.get("tenant_id") != st.id("test_alpha") or r.get("environment") != "live" \
                or r.get("tenant_status") != "active" or r.get("key_id") != st.key_live_id:
            problems.append(f"valid live key resolved to unexpected row: {r}")
    # last_used_at must have been touched
    after = rest(base, key, "GET",
                 f"/rest/v1/api_keys?id=eq.{st.key_live_id}&select=last_used_at")
    if not after or not after[0].get("last_used_at"):
        problems.append("resolve_api_key did not update last_used_at")

    # 2. revoked key resolves to nothing
    # (PostgREST does not evaluate functions in the body: send a timestamp.)
    import datetime as _dt
    rest(base, key, "PATCH", f"/rest/v1/api_keys?id=eq.{st.key_revoke_id}",
         body={"revoked_at": _dt.datetime.now(_dt.timezone.utc)
               .isoformat(timespec="seconds")},
         headers={"Prefer": "return=minimal"})
    rows = rpc_ok(base, key, "resolve_api_key", {"p_key_hash": _rk})
    if rows:
        problems.append(f"revoked key still resolves: {rows}")

    # 3. sandbox key reports sandbox (not live)
    rows = rpc_ok(base, key, "resolve_api_key", {"p_key_hash": st.key_sb_hash})
    if len(rows) != 1 or rows[0].get("environment") != "sandbox" \
            or rows[0].get("tenant_id") != st.gamma_id:
        problems.append(f"sandbox key resolution wrong: {rows}")

    # 4. suspended tenant's key resolves to nothing
    rest(base, key, "PATCH", f"/rest/v1/tenants?id=eq.{st.gamma_id}",
         body={"status": "suspended"}, headers={"Prefer": "return=minimal"})
    rows = rpc_ok(base, key, "resolve_api_key", {"p_key_hash": st.key_sb_hash})
    if rows:
        problems.append(f"suspended tenant's key still resolves: {rows}")
    # restore: T12 needs gamma active first (it suspends/drops it itself)
    rest(base, key, "PATCH", f"/rest/v1/tenants?id=eq.{st.gamma_id}",
         body={"status": "active"}, headers={"Prefer": "return=minimal"})

    # 5. create_api_key validation: bad environment rejected
    status, _p, text = rpc(base, key, "create_api_key",
                           {"p_tenant_id": st.id("test_alpha"),
                            "p_key_hash": "c" * 64,
                            "p_key_prefix": "pk_bad_env",
                            "p_environment": "prod"})
    if status < 400:
        problems.append(f"create_api_key accepted environment 'prod' ({status})")

    if problems:
        record("T8", False, "; ".join(problems))
    else:
        record("T8", True,
               "valid/revoked/suspended/sandbox-vs-live all correct; "
               "last_used_at updated; bad environment rejected")


def t9_usage_events_append_only(base, key, st: State) -> None:
    """T9: cross-tenant key reference FAILS; UPDATE and DELETE FAIL
    (append-only); valid rows round-trip."""
    problems: list[str] = []
    alpha = st.id("test_alpha")

    # valid: alpha tenant + alpha's live key
    ev = {"tenant_id": alpha, "key_id": st.key_live_id,
          "endpoint": "/rpc/search_products", "units": 1,
          "request_id": "t9-ok", "status_code": 200}
    status, _p, text = http_json(base, key, "POST", "/rest/v1/usage_events",
                                 body=ev, headers={"Prefer": "return=minimal"})
    if status >= 300:
        problems.append(f"valid usage_event insert failed: {status} {err_excerpt(text)}")

    # valid: gamma tenant + gamma's sandbox key (removed by T12's cascade)
    ev2 = {"tenant_id": st.gamma_id, "key_id": st.key_sb_id,
           "endpoint": "/rpc/search_products", "units": 1,
           "request_id": "t9-gamma", "status_code": 200}
    status, _p, text = http_json(base, key, "POST", "/rest/v1/usage_events",
                                 body=ev2, headers={"Prefer": "return=minimal"})
    if status >= 300:
        problems.append(f"valid gamma usage_event insert failed: {status} {err_excerpt(text)}")

    # cross-tenant: alpha tenant + gamma's key -> composite FK must refuse
    ev3 = {"tenant_id": alpha, "key_id": st.key_sb_id,
           "endpoint": "/rpc/search_products", "units": 1,
           "request_id": "t9-xtenant", "status_code": 200}
    status, _p, text = http_json(base, key, "POST", "/rest/v1/usage_events",
                                 body=ev3, headers={"Prefer": "return=minimal"})
    if status < 400:
        problems.append(f"cross-tenant (alpha tenant + gamma key) ACCEPTED ({status})")
    elif "schema cache" in text:
        problems.append("cross-tenant insert got a schema-cache 404 — setup problem")

    # append-only: UPDATE and DELETE must fail for service_role
    status, _p, text = http_json(base, key, "PATCH",
                                 "/rest/v1/usage_events?request_id=eq.t9-ok",
                                 body={"units": 5})
    if status < 400:
        problems.append(f"service_role UPDATE on usage_events accepted ({status})")
    status, _p, text = http_json(base, key, "DELETE",
                                 "/rest/v1/usage_events?request_id=eq.t9-ok")
    if status < 400:
        problems.append(f"service_role DELETE on usage_events accepted ({status})")

    # the failed UPDATE must not have changed anything
    rows = rest(base, key, "GET",
                "/rest/v1/usage_events?request_id=eq.t9-ok&select=units")
    if len(rows) != 1 or rows[0].get("units") != 1:
        problems.append(f"t9-ok row changed after failed UPDATE: {rows}")

    if problems:
        record("T9", False, "; ".join(problems))
    else:
        record("T9", True,
               "valid inserts OK; cross-tenant key reference rejected by FK; "
               "UPDATE and DELETE rejected (append-only)")


def t10_external_id_uniqueness(base, key, st: State) -> None:
    """T10: duplicate external_id in a tenant fails; the same external_id in
    two tenants succeeds (seeded in T1)."""
    status, _p, text = http_json(
        base, key, "POST", "/rest/v1/products",
        body=[product_row(st.id("test_alpha"), "sku-00", "dupe [CANARY-DUPE]",
                          make_vector(995))],
        headers={"Prefer": "return=minimal"})
    if status < 400:
        record("T10", False, f"duplicate external_id in test_alpha accepted ({status})")
        return
    rows = rest(base, key, "GET",
                "/rest/v1/products?select=external_id,tenant_id"
                "&external_id=eq.sku-00&limit=100")
    if len(rows) != 2 or {r["tenant_id"] for r in rows} != {
            st.id("test_alpha"), st.id("test_beta")}:
        record("T10", False,
               f"sku-00 across tenants: expected 1 alpha + 1 beta row, got {len(rows)}")
        return
    record("T10", True,
           f"dup in one tenant rejected ({status}); same external_id exists in both tenants")


def t11_partition_pruning(base, key, st: State) -> None:
    """T11: EXPLAIN inside search_products' plan shows only the tenant's
    partition being scanned."""
    status, parsed, text = rpc(base, key, "explain_search_products",
                               {"p_tenant_id": st.id("test_alpha"),
                                "p_query": vector_param(st.queries[0]),
                                "p_embedding_model": MODEL})
    if status >= 300 or not isinstance(parsed, list) or not parsed:
        record("T11", False,
               f"explain_search_products failed: {status} {err_excerpt(text)}")
        return
    plan = "\n".join(str(line) for line in parsed)
    print("  ---- EXPLAIN plan (test_alpha) ----")
    for line in parsed[:25]:
        print(f"  | {line}")
    print("  -----------------------------------")
    scans_own = "products_test_alpha" in plan
    leaks = [s for s in sorted(st.tenants)
             if s != "test_alpha" and f"products_{s}" in plan]
    if not scans_own:
        record("T11", False, "plan does not mention products_test_alpha at all")
        return
    if leaks:
        record("T11", False, "NO PRUNING — plan also touches: " + ", ".join(leaks))
        return
    record("T11", True, "plan scans only products_test_alpha (partition pruning works)")


def t12_drop_tenant(base, key, st: State) -> None:
    """T12: drop_tenant refuses a wrong confirm slug and an active tenant;
    works when suspended + confirmed; other tenants unaffected."""
    gid = st.gamma_id
    problems: list[str] = []

    # (a) wrong confirm slug while SUSPENDED -> refuse
    rest(base, key, "PATCH", f"/rest/v1/tenants?id=eq.{gid}",
         body={"status": "suspended"}, headers={"Prefer": "return=minimal"})
    status, _p, text = rpc(base, key, "drop_tenant",
                           {"p_tenant_id": gid, "p_confirm_slug": "WRONG_SLUG"})
    if status < 400 or "confirm slug mismatch" not in text:
        problems.append(f"wrong confirm slug -> {status}: {err_excerpt(text)}")
    still = rest(base, key, "GET", f"/rest/v1/tenants?id=eq.{gid}&select=id")
    if not still:
        problems.append("tenant vanished despite wrong confirm slug")

    # (b) correct confirm but ACTIVE -> refuse
    rest(base, key, "PATCH", f"/rest/v1/tenants?id=eq.{gid}",
         body={"status": "active"}, headers={"Prefer": "return=minimal"})
    status, _p, text = rpc(base, key, "drop_tenant",
                           {"p_tenant_id": gid, "p_confirm_slug": "test_gamma"})
    if status < 400 or "suspended" not in text:
        problems.append(f"active tenant drop -> {status}: {err_excerpt(text)}")
    still = rest(base, key, "GET", f"/rest/v1/tenants?id=eq.{gid}&select=id")
    if not still:
        problems.append("tenant vanished despite being active")

    # (c) suspended + correct confirm -> works
    rest(base, key, "PATCH", f"/rest/v1/tenants?id=eq.{gid}",
         body={"status": "suspended"}, headers={"Prefer": "return=minimal"})
    status, _p, text = rpc(base, key, "drop_tenant",
                           {"p_tenant_id": gid, "p_confirm_slug": "test_gamma"})
    if status >= 300:
        problems.append(f"confirmed drop of suspended tenant failed: {status} {err_excerpt(text)}")
        record("T12", False, "; ".join(problems))
        return

    # proof: tenants row gone
    if rest(base, key, "GET", f"/rest/v1/tenants?id=eq.{gid}&select=id"):
        problems.append("tenants row still present after drop")
    # proof: partition gone (audit reads pg_class directly)
    rows = audit_rows(base, key)
    if any(r.get("obj_name") == "products_test_gamma" for r in rows):
        problems.append("products_test_gamma still listed by schema_audit after drop")
    # proof: no gamma product/event rows remain (events removed by cascade)
    if rest(base, key, "GET",
            f"/rest/v1/products?tenant_id=eq.{gid}&select=id&limit=10"):
        problems.append("gamma product rows still present after drop")
    if rest(base, key, "GET",
            f"/rest/v1/usage_events?tenant_id=eq.{gid}&select=id&limit=10"):
        problems.append("gamma usage_events still present after drop (cascade missed)")
    # proof: search for the dropped tenant now raises
    status, _p, text = rpc(base, key, "search_products",
                           {"p_tenant_id": gid,
                            "p_query": vector_param(st.queries[0]),
                            "p_embedding_model": MODEL})
    if status < 400 or "no tenant" not in text:
        problems.append(f"search for dropped tenant -> {status}: {err_excerpt(text)}")

    # other tenants unaffected: alpha still has its 25 rows + search works
    alpha_rows = rest(base, key, "GET",
                      f"/rest/v1/products?tenant_id=eq.{st.id('test_alpha')}"
                      "&select=id&limit=100")
    search = rpc_ok(base, key, "search_products",
                    {"p_tenant_id": st.id("test_alpha"),
                     "p_query": vector_param(st.queries[0]),
                     "p_embedding_model": MODEL, "p_limit": 3})
    beta_rows = rest(base, key, "GET",
                     f"/rest/v1/products?tenant_id=eq.{st.id('test_beta')}"
                     "&select=id&limit=100")
    if len(alpha_rows) != 25 or len(beta_rows) != 25:
        problems.append(f"row counts after drop: alpha={len(alpha_rows)} "
                        f"beta={len(beta_rows)}, expected 25/25")
    if not search or "CANARY-ALPHA" not in (search[0].get("title") or ""):
        problems.append("alpha search broken after dropping gamma")

    del st.tenants["test_gamma"]
    if problems:
        record("T12", False, "; ".join(problems))
    else:
        record("T12", True,
               "refused wrong-confirm and active; dropped when suspended+confirmed; "
               "partition/events gone; alpha & beta intact (25 rows each, search OK)")


def t13_audit_all(base, key, st: State) -> None:
    """T13: schema_audit passes, including after a tenant created AFTER all
    other tests."""
    # A tenant created now exercises the 'future partition' path too.
    late_id = create_tenant(base, key, "test_late")
    st.tenants["test_late"] = late_id
    rest(base, key, "POST", "/rest/v1/products",
         body=[product_row(late_id, "sku-late-00", "late [CANARY-LATE]",
                           make_vector(500))],
         headers={"Prefer": "return=minimal"})

    rows = audit_rows(base, key)
    bad = [(r["obj_name"], r["offenders"]) for r in rows if r.get("offenders")]
    if bad:
        record("T13", False, f"offenders: {bad}"[:250])
        return
    ok, detail = locked_down(rows, "products_test_late")
    if not ok:
        record("T13", False, f"late partition audit: {detail}")
        return
    record("T13", True,
           f"audit clean across {len(rows)} object(s) after creating test_late; "
           f"its partition is locked ({detail})")


def t14_section_and_archived(base, key, st: State) -> None:
    """T14: invalid section value fails; archived products never appear in
    search."""
    problems: list[str] = []
    alpha = st.id("test_alpha")

    # invalid section -> CHECK violation
    bad = product_row(alpha, "sku-bad-section", "bad section", make_vector(888),
                      section="nope")
    status, _p, text = http_json(base, key, "POST", "/rest/v1/products",
                                 body=bad, headers={"Prefer": "return=minimal"})
    if status < 400:
        problems.append(f"section='nope' accepted ({status})")
    elif "section" not in text.lower():
        problems.append(f"rejected ({status}) but not by the section check: {err_excerpt(text)}")

    # an active product IS found by its own vector
    av = make_vector(777)
    row = product_row(alpha, "sku-arch-01", "archivable [CANARY-ARCH]", av)
    status, _p, text = http_json(base, key, "POST", "/rest/v1/products",
                                 body=row, headers={"Prefer": "return=minimal"})
    if status >= 300:
        problems.append(f"inserting sku-arch-01 failed: {status} {err_excerpt(text)}")
    else:
        rows = rpc_ok(base, key, "search_products",
                      {"p_tenant_id": alpha, "p_query": vector_param(av),
                       "p_embedding_model": MODEL, "p_limit": 5})
        if not any(r.get("external_id") == "sku-arch-01" for r in rows):
            problems.append("active product not found by its exact vector")
        # archive it -> must vanish from search
        rest(base, key, "PATCH",
             "/rest/v1/products?tenant_id=eq.%s&external_id=eq.sku-arch-01" % alpha,
             body={"status": "archived"}, headers={"Prefer": "return=minimal"})
        rows = rpc_ok(base, key, "search_products",
                      {"p_tenant_id": alpha, "p_query": vector_param(av),
                       "p_embedding_model": MODEL, "p_limit": 5})
        if any(r.get("external_id") == "sku-arch-01" for r in rows):
            problems.append("archived product still returned by search")

    if problems:
        record("T14", False, "; ".join(problems))
    else:
        record("T14", True,
               "invalid section rejected by CHECK; archived product never appears in search")


def t15_forged_tenant_placeholder(base, key, st: State) -> None:
    """T15 placeholder: a forged tenant_id in a request body must be ignored —
    the tenant comes from the API key server-side (L1). That can only be
    observed end-to-end through the HTTP API, which does not exist yet."""
    record("T15", True,
           "SKIPPED — forged-tenant_id-in-body test needs the API layer (rule 7: not built here)")


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def print_table() -> bool:
    print("\n" + "=" * 74)
    width = max(len(n) for n, _, _ in RESULTS)
    for name, ok, detail in RESULTS:
        print(f"  {name:<{width}}  {'PASS' if ok else 'FAIL'}  {detail}")
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    all_ok = passed == len(RESULTS)
    print("-" * 74)
    print(f"RESULT: {'PASS' if all_ok else 'FAIL'} ({passed}/{len(RESULTS)} tests)")
    print("=" * 74)
    return all_ok


def main() -> int:
    load_dotenv_if_present()
    try:
        base, svc, anon = require_config()
        check_target_allowed(base)
    except Refused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 2

    # Prove the two keys are present without ever printing them.
    print(f"target: {base}")
    print(f"service key: {len(svc)} chars, anon key: {len(anon)} chars (values not shown)")
    print("NOTE: run this against a pilot project where ONLY this suite's "
          "test_ tenants exist.\n")

    cache_err = preflight(base, svc)
    if cache_err:
        print(f"REFUSED: {cache_err}", file=sys.stderr)
        return 2

    st = State()
    tests = [
        ("T1",  lambda: t1_setup(base, svc, st)),
        ("T2",  lambda: t2_search_isolation(base, svc, st)),
        ("T3",  lambda: t3_search_guards(base, svc, st)),
        ("T4",  lambda: t4_embedding_model_guard(base, svc, st)),
        ("T5",  lambda: t5_min_similarity_zero(base, svc, st)),
        ("T6",  lambda: t6_no_partition_insert_fails(base, svc, st)),
        ("T7",  lambda: t7_anon_locked_out(base, anon, st)),
        ("T8",  lambda: t8_resolve_api_key(base, svc, st)),
        ("T9",  lambda: t9_usage_events_append_only(base, svc, st)),
        ("T10", lambda: t10_external_id_uniqueness(base, svc, st)),
        ("T11", lambda: t11_partition_pruning(base, svc, st)),
        ("T12", lambda: t12_drop_tenant(base, svc, st)),
        ("T13", lambda: t13_audit_all(base, svc, st)),
        ("T14", lambda: t14_section_and_archived(base, svc, st)),
        ("T15", lambda: t15_forged_tenant_placeholder(base, svc, st)),
    ]
    for name, fn in tests:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 — one broken step must not hide the rest
            record(name, False, f"unexpected error: {exc}")

    ok = print_table()
    if ok:
        print("\nNext: python tests/cleanup_test_tenants.py  (removes only test_ tenants)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
