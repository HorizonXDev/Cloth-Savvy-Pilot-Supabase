#!/usr/bin/env python3
"""Spike tests for the Cloth Savvy Pilot partitioned `products` design.

WHAT THIS PROVES (or disproves): a `products` table PARTITIONED BY LIST
(tenant_id) with one physical partition per brand keeps tenant isolation
while remaining queryable through spike_search().

This is a THROWAWAY spike against an EMPTY, ideally LOCAL Supabase project.
It talks to the Data API (PostgREST) over HTTP only. Standard library only —
no pip installs (requests is not installed on the machine this was written
on, and urllib is enough).

Run order (see README.md):
  1. Apply spike_01_setup.sql in the SQL editor.
  2. python spike_tests.py          <- pauses at S7 for spike_02_add_column.sql
  3. Apply spike_99_cleanup.sql when done.

Safety rules baked in (hard requirement):
  * Reads SPIKE_SUPABASE_URL, SPIKE_SUPABASE_SERVICE_KEY,
    SPIKE_SUPABASE_ANON_KEY from the environment (or a .env file beside this
    script) and REFUSES TO RUN if any is missing.
  * The URL must be a localhost address unless SPIKE_ALLOW_REMOTE=1 is set,
    and then SPIKE_PROJECT_REF must be set too and appear in the URL.
  * Keys are never printed, not even partially.

Exit codes: 0 = all tests passed, 1 = at least one FAIL, 2 = refused to run
(missing env / target not allowed / PostgREST schema cache stale).
"""

from __future__ import annotations

import json
import math
import os
import random
import sys
import time
import uuid
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

DIM = 512
MODEL = "fashion-clip-local"   # embedding_model used for every tenant here
TIMEOUT_S = 60                 # DDL-cold RPCs can be slow on a local stack


class Refused(RuntimeError):
    """Env guard tripped — we refuse to talk to this target."""


class TestError(RuntimeError):
    """A test step failed in an unexpected way."""


# --------------------------------------------------------------------------
# Configuration / safety guards
# --------------------------------------------------------------------------

def load_dotenv_if_present() -> None:
    """Minimal .env loader (KEY=VALUE lines). Values already in the real
    environment win. Values are never printed."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.isfile(env_path):
        return
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
    missing = [k for k in ("SPIKE_SUPABASE_URL",
                           "SPIKE_SUPABASE_SERVICE_KEY",
                           "SPIKE_SUPABASE_ANON_KEY")
               if not os.environ.get(k)]
    if missing:
        raise Refused(
            "refusing to run: missing environment variable(s): "
            + ", ".join(missing)
            + "  (copy .env.example to .env and fill it in, or export them)"
        )
    base = os.environ["SPIKE_SUPABASE_URL"].rstrip("/")
    parsed = urlparse.urlparse(base)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise Refused(f"refusing to run: SPIKE_SUPABASE_URL is not a URL: {base!r}")
    return (base,
            os.environ["SPIKE_SUPABASE_SERVICE_KEY"],
            os.environ["SPIKE_SUPABASE_ANON_KEY"])


def preflight(base: str, svc: str) -> str | None:
    """Catch a stale PostgREST schema cache BEFORE the tests, so its 404s
    are not mistaken for design results. Returns an error message or None."""
    status, _p, text = http_json(base, svc, "GET",
                                 "/rest/v1/spike_products?select=id&limit=1")
    if status == 200:
        # Parent is served. spike_audit() must also exist: S8/S14/S15 depend on
        # it, and it is created by a SEPARATE file (spike_audit.sql) — a miss
        # would otherwise surface only as late, confusing failures.
        status, _p, text = http_json(base, svc, "POST",
                                     "/rest/v1/rpc/spike_audit", body={})
        if status < 300:
            return None
        if status == 404 and "spike_audit" in text:
            return (
                "spike_audit RPC is missing — run spike_audit.sql in the SQL "
                "editor (it now ends with its own NOTIFY pgrst, 'reload schema') "
                "and re-run."
            )
        return f"preflight POST /rest/v1/rpc/spike_audit failed: {status} {err_excerpt(text)}"
    if "schema cache" in text:
        return (
            "PostgREST schema cache is stale — the spike objects exist in the "
            "database but the Data API cannot see them yet. Run this once in the "
            "SQL editor:   NOTIFY pgrst, 'reload schema';   (or Studio -> Settings "
            "-> API -> Reload schema, or `supabase restart`), then re-run."
        )
    if status == 401:
        return "service key rejected (401) — check SPIKE_SUPABASE_SERVICE_KEY in .env"
    return f"preflight GET /rest/v1/spike_products failed: {status} {err_excerpt(text)}"


def check_target_allowed(base: str) -> None:
    host = (urlparse.urlparse(base).hostname or "").lower()
    if host in ("127.0.0.1", "localhost", "::1"):
        return  # local stack: allowed by default
    if os.environ.get("SPIKE_ALLOW_REMOTE") != "1":
        raise Refused(
            f"refusing to run: target host {host!r} is not localhost. "
            "This spike defaults to LOCAL ONLY. Set SPIKE_ALLOW_REMOTE=1 "
            "(and SPIKE_PROJECT_REF) to allow a remote project."
        )
    ref = (os.environ.get("SPIKE_PROJECT_REF") or "").strip()
    if not ref or ref not in base:
        raise Refused(
            "refusing to run: SPIKE_ALLOW_REMOTE=1 requires SPIKE_PROJECT_REF "
            "to be set and to appear in SPIKE_SUPABASE_URL "
            f"(host={host!r}, project ref set={bool(ref)})"
        )


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

    def id(self, slug: str) -> str:
        if slug not in self.tenants:
            raise TestError(f"prerequisite missing: tenant {slug!r} was never created")
        return self.tenants[slug]


def product_row(tenant_id: str, external_id: str, title: str,
                vector: list[float], model: str = MODEL) -> dict:
    return {
        "tenant_id": tenant_id,
        "external_id": external_id,
        "title": title,
        "section": "women",
        "colors": ["red", "beige"],
        "price": "49.90",
        "in_stock": True,
        "attributes": {"fabric": "cotton"},
        "embedding": vector_param(vector),
        "embedding_model": model,
        "status": "active",
    }


def create_tenant(base, key, slug: str) -> str:
    tid = rpc_ok(base, key, "spike_create_tenant",
                 {"p_slug": slug, "p_model": MODEL, "p_dim": DIM})
    if not isinstance(tid, str):
        raise TestError(f"spike_create_tenant({slug}) returned {tid!r}, expected uuid text")
    return tid


def audit_rows(base, key) -> list[dict]:
    rows = rpc_ok(base, key, "spike_audit")
    if not isinstance(rows, list):
        raise TestError(f"spike_audit returned {type(rows).__name__}, expected list")
    return rows


def locked_down(rows: list[dict], obj_name: str) -> tuple[bool, str]:
    """Check one audit row for a table/partition: RLS on+forced, no anon /
    authenticated privileges, service_role holds something."""
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
    if problems:
        return False, "; ".join(problems)
    return True, "RLS enabled+forced, anon/authenticated hold nothing"


def partition_route_mode(base: str, key: str, st: State) -> str:
    """Does PostgREST expose /rest/v1/<partition> endpoints?

    'served'   — yes (older PostgREST): direct-partition assertions apply.
    'excluded' — no: the PARENT is served (200) but the partition 404s with
                 PGRST205 "not in the schema cache". PostgREST REMOVES
                 partition children from its schema cache by design
                 (postgrest PR #2022 "Remove partitions from the schema
                 cache"; 9.0 changelog: "Partitions (created using PARTITION
                 OF) are no longer included in the schema cache"), so the
                 route exists for NOBODY — stronger than any permission
                 check. Verified live 2026-10-20: parent 200, all partitions
                 404, OpenAPI lists no partition, cache says "2 Relations"
                 after successful reloads.
    'stale'    — the parent 404s too: a stale schema cache, i.e. a SETUP
                 problem, never a result (run NOTIFY pgrst, 'reload schema').
    'broken'   — parent answered something unexpected; refuse to interpret.

    Cached on st after the first probe (alpha exists from S1 on).
    """
    if st.route_mode:
        return st.route_mode
    if "alpha" not in st.tenants:
        return "broken"
    pstatus, _p, ptext = http_json(base, key, "GET",
                                   "/rest/v1/spike_products?select=id&limit=1")
    if pstatus != 200:
        st.route_mode = "stale" if (pstatus == 404 and "schema cache" in ptext) \
            else "broken"
        return st.route_mode
    rstatus, _r, rtext = http_json(base, key, "GET",
                                   "/rest/v1/spike_products_alpha?select=id&limit=1")
    if rstatus == 200:
        st.route_mode = "served"
    elif rstatus == 404 and "schema cache" in rtext:
        st.route_mode = "excluded"
    else:
        st.route_mode = "broken"
    return st.route_mode


# --------------------------------------------------------------------------
# The tests
# --------------------------------------------------------------------------

def s1_setup(base, key, st: State) -> None:
    """S1: two tenants, 20 products each, IDENTICAL vectors across tenants,
    canary in every title."""
    st.tenants["alpha"] = create_tenant(base, key, "alpha")
    st.tenants["beta"] = create_tenant(base, key, "beta")
    vectors = [make_vector(i) for i in range(20)]
    for slug in ("alpha", "beta"):
        tid = st.id(slug)
        rows = [
            product_row(tid,
                        f"sku-{i:02d}",                     # same external_ids on purpose
                        f"{slug} product {i:02d} [CANARY-{slug.upper()}]",
                        vectors[i])
            for i in range(20)
        ]
        rest(base, key, "POST", "/rest/v1/spike_products", body=rows,
             headers={"Prefer": "return=minimal"})
    record("S1", True,
           f"tenants alpha={st.tenants['alpha'][:8]}… beta={st.tenants['beta'][:8]}…, "
           "20+20 products, identical vectors, canaries set")


def s2_search_isolation(base, svc, anon, st: State) -> None:
    """S2: spike_search as alpha returns ONLY alpha canaries (20 queries),
    same for beta."""
    for slug, tag in (("alpha", "CANARY-ALPHA"), ("beta", "CANARY-BETA")):
        tid = st.id(slug)
        wrong = 0
        empty = 0
        for q in st.queries:
            rows = rpc_ok(base, svc, "spike_search",
                          {"p_tenant_id": tid, "p_query": vector_param(q), "p_limit": 5})
            if not rows:
                empty += 1
                continue
            wrong += sum(1 for r in rows if tag not in (r.get("title") or ""))
        if empty or wrong:
            record("S2", False,
                   f"{slug}: {empty} empty result(s), {wrong} row(s) without {tag}")
            return
    record("S2", True, "40 searches (20 per tenant) returned only same-tenant canaries")


def s3_unknown_tenant_insert_fails(base, key, st: State) -> None:
    """S3: inserting a product for a tenant with NO partition fails."""
    ghost = str(uuid.uuid4())
    row = product_row(ghost, "sku-ghost", "ghost [CANARY-GHOST]", make_vector(999))
    status, _parsed, text = http_json(base, key, "POST", "/rest/v1/spike_products",
                                      body=row, headers={"Prefer": "return=minimal"})
    if 400 <= status < 500 and "schema cache" not in text:
        note = "documented 'no partition ... found for row'" \
            if "no partition" in text else f"rejected: {err_excerpt(text)}"
        record("S3", True, f"insert without partition rejected ({status}) — {note}")
    elif status < 300:
        record("S3", False, f"insert for partitionless tenant {ghost} SUCCEEDED (status {status})")
    else:
        record("S3", False,
               f"unexpected response {status}: {err_excerpt(text)} "
               "(a schema-cache 404 does NOT count as a pass)")


def s4_cross_partition_insert_fails(base, key, st: State) -> None:
    """S4: a row with tenant_id=alpha written into beta's partition directly
    fails (partition constraint) — or, when PostgREST does not expose
    partitions, the direct route simply does not exist for anyone."""
    mode = partition_route_mode(base, key, st)
    row = product_row(st.id("alpha"), "sku-xpart", "cross partition [CANARY-X]",
                      make_vector(998))
    status, _parsed, text = http_json(base, key, "POST",
                                      "/rest/v1/spike_products_beta", body=row,
                                      headers={"Prefer": "return=minimal"})
    if mode == "excluded":
        if status == 404 and "schema cache" in text:
            record("S4", True,
                   "no /rest/v1/<partition> route exists at all (PostgREST "
                   "excludes partitions from its schema cache by design, PR "
                   "#2022) — cross-partition insert is structurally impossible "
                   "via the Data API")
        elif status < 300:
            record("S4", False, "cross-partition insert into spike_products_beta SUCCEEDED")
        else:
            record("S4", False, f"unexpected response {status}: {err_excerpt(text)}")
        return
    # mode 'served' (older PostgREST exposes partitions): the original check.
    # 'stale'/'broken' fall through to the guard below and FAIL — correct.
    if 400 <= status < 500 and "schema cache" not in text:
        record("S4", True, f"alpha row into beta partition rejected ({status}) — {err_excerpt(text)}")
    elif status < 300:
        record("S4", False, "cross-partition insert into spike_products_beta SUCCEEDED")
    else:
        record("S4", False,
               f"unexpected response {status}: {err_excerpt(text)} "
               "(a schema-cache 404 does NOT count as a pass)")


def s5_anon_is_locked_out(base, anon, st: State) -> None:
    """S5: anon key: GET parent + partitions -> 401/403 or empty list;
    POST/PATCH/DELETE rejected; spike_search rejected."""
    problems: list[str] = []

    # GETs: parent + every existing partition
    targets = ["/rest/v1/spike_products"] + [
        f"/rest/v1/spike_products_{slug}" for slug in sorted(st.tenants)
    ]
    for path in targets:
        status, parsed, text = http_json(base, anon, "GET", path + "?limit=1")
        if status == 200:
            if parsed not in ([], None):
                problems.append(f"GET {path} returned rows to anon!")
        elif status in (401, 403):
            pass
        elif (path != "/rest/v1/spike_products" and status == 404
              and "schema cache" in text):
            # Partition route: PostgREST excludes partitions from its cache by
            # design (PR #2022) — the endpoint exists for NOBODY, anon
            # included. The parent's check in this same loop proves the cache
            # is fresh (a stale cache would 404 the parent too, and that still
            # lands in the else-branch below as a failure).
            pass
        else:
            problems.append(f"GET {path} -> unexpected {status}: {err_excerpt(text)}")

    # POST parent
    row = product_row(st.id("alpha"), "sku-anon", "anon [CANARY-ANON]", make_vector(997))
    status, _p, text = http_json(base, anon, "POST", "/rest/v1/spike_products", body=row)
    if status < 400:
        problems.append(f"anon POST accepted ({status})")

    # PATCH with a filter
    status, _p, text = http_json(base, anon, "PATCH",
                                 f"/rest/v1/spike_products?id=eq.{st.id('alpha')}",
                                 body={"title": "pwned"})
    if status < 400:
        problems.append(f"anon PATCH accepted ({status})")

    # DELETE with a filter
    status, _p, text = http_json(base, anon, "DELETE",
                                 f"/rest/v1/spike_products?id=eq.{st.id('alpha')}")
    if status < 400:
        problems.append(f"anon DELETE accepted ({status})")

    # RPC spike_search
    status, _p, text = rpc(base, anon, "spike_search",
                           {"p_tenant_id": st.id("alpha"),
                            "p_query": vector_param(st.queries[0])})
    if status < 400:
        problems.append(f"anon rpc spike_search accepted ({status})")

    if problems:
        record("S5", False, "; ".join(problems))
    else:
        record("S5", True,
               "anon: parent 401/403/empty; partitions 401/403/empty or no "
               "route at all (PostgREST excludes them by design); "
               "POST/PATCH/DELETE and spike_search rejected")


def s6_service_reads_partition_directly(base, key, st: State) -> None:
    """S6: reads scoped to one tenant return only that tenant's rows. With
    partition endpoints exposed (older PostgREST) that is checked by reading
    each physical partition directly; without them, by the parent endpoint
    filtered by tenant_id — physical separation itself is then confirmed by
    S12's pruned plan."""
    mode = partition_route_mode(base, key, st)
    for slug in ("alpha", "beta"):
        tag = f"CANARY-{slug.upper()}"
        other = f"CANARY-{'BETA' if slug == 'alpha' else 'ALPHA'}"
        if mode == "served":
            rows = rest(base, key, "GET",
                        f"/rest/v1/spike_products_{slug}?select=title&limit=100")
        else:
            rows = rest(base, key, "GET",
                        f"/rest/v1/spike_products?tenant_id=eq.{st.id(slug)}"
                        f"&select=title&limit=100")
        if len(rows) != 20:
            record("S6", False, f"{slug}: {len(rows)} rows returned, expected 20")
            return
        if any(tag not in r["title"] for r in rows) or any(other in r["title"] for r in rows):
            record("S6", False, f"{slug} rows contain rows of the other tenant")
            return
    if mode == "served":
        record("S6", True, "direct partition reads: 20 alpha rows / 20 beta rows, no crossover")
    else:
        record("S6", True,
              "partition routes do not exist (PostgREST excludes them by "
              "design); parent reads filtered by tenant_id: 20 alpha / 20 beta "
              "rows, no crossover (physical separation: S12 plan)")


def s7_add_column(base, key, st: State) -> None:
    """S7: schema change. Pauses so the human can run spike_02_add_column.sql
    in the SQL editor, then verifies the column on parent AND every existing
    partition, and that rows still work."""
    print("\n  >>> S7 needs a manual step: run spike_02_add_column.sql in the")
    print("  >>> Supabase SQL editor NOW, then come back here.")
    try:
        input("  >>> Press Enter when spike_02_add_column.sql has been applied... ")
    except EOFError:
        record("S7", False, "no stdin available to confirm the manual step — run interactively")
        return

    problems: list[str] = []
    mode = partition_route_mode(base, key, st)

    # Parent must serve the new column (ALTER applied + PostgREST notified).
    status, parsed, text = http_json(
        base, key, "GET",
        "/rest/v1/spike_products?select=spike_probe,title&limit=1",
        headers={"Accept-Profile": "public"})
    if status >= 300:
        problems.append(f"spike_products: {status} {err_excerpt(text)}")
    elif parsed and "spike_probe" not in parsed[0]:
        problems.append("spike_products: spike_probe missing from row")

    # Every existing partition: read it directly when PostgREST exposes
    # partitions; otherwise read that tenant's rows THROUGH the parent —
    # those rows physically live in the partition, so a column the ALTER
    # failed to propagate would break the query or come back NULL.
    for slug in sorted(st.tenants):
        if mode == "served":
            path = f"/rest/v1/spike_products_{slug}?select=spike_probe,title&limit=1"
        else:
            path = (f"/rest/v1/spike_products?tenant_id=eq.{st.id(slug)}"
                    f"&select=spike_probe,title&limit=1")
        status, parsed, text = http_json(
            base, key, "GET", path, headers={"Accept-Profile": "public"})
        if status >= 300:
            problems.append(f"{slug}: {status} {err_excerpt(text)}")
            continue
        if parsed and "spike_probe" not in parsed[0]:
            problems.append(f"{slug}: spike_probe missing from row")

    # rows keep working: a fresh search still returns canaries
    status, parsed, text = rpc(base, key, "spike_search",
                               {"p_tenant_id": st.id("alpha"), "p_query": vector_param(st.queries[0]), "p_limit": 3})
    if status >= 300 or not parsed:
        problems.append("spike_search broken after ALTER")

    if problems:
        record("S7", False, "; ".join(problems))
    else:
        where = "parent+partitions" if mode == "served" else \
            "parent (rows via each tenant's partition)"
        record("S7", True,
               f"spike_probe present on {where} — {len(st.tenants)} tenant(s), rows/search OK")


def s8_late_tenant_has_column_and_locks(base, key, st: State) -> None:
    """S8: a tenant created AFTER the column change gets the new column and
    its partition is locked down (audit)."""
    tid = create_tenant(base, key, "late")
    st.tenants["late"] = tid
    rest(base, key, "POST", "/rest/v1/spike_products",
         body=[product_row(tid, "sku-late-00", "late product [CANARY-LATE]",
                           make_vector(500))],
         headers={"Prefer": "return=minimal"})
    if partition_route_mode(base, key, st) == "served":
        row = rest(base, key, "GET",
                   "/rest/v1/spike_products_late?select=spike_probe,title")
    else:
        # Partition route does not exist (PostgREST excludes partitions):
        # read the late tenant's row through the parent — it physically
        # lives in spike_products_late, so the column got there or not.
        row = rest(base, key, "GET",
                   f"/rest/v1/spike_products?tenant_id=eq.{tid}"
                   "&select=spike_probe,title&limit=1")
    if not row or row[0].get("spike_probe") != "x":
        record("S8", False, f"late tenant row missing spike_probe='x': {row!r}"[:200])
        return
    ok, detail = locked_down(audit_rows(base, key), "spike_products_late")
    record("S8", ok, f"late partition has spike_probe='x'; {detail}" if ok
           else f"late partition audit: {detail}")


def s9_search_guards(base, key, st: State) -> None:
    """S9: spike_search raises on NULL tenant and on a nonexistent tenant."""
    problems: list[str] = []
    # A schema-cache 404 (PGRST202) also mentions spike_search in its message,
    # so require the ACTUAL guard text — a pass must come from the function.
    status, _p, text = rpc(base, key, "spike_search",
                           {"p_tenant_id": None, "p_query": vector_param(st.queries[0])})
    if status < 400 or "schema cache" in text or "must not be null" not in text:
        problems.append(f"NULL tenant -> {status}: {err_excerpt(text)}")
    status, _p, text = rpc(base, key, "spike_search",
                           {"p_tenant_id": str(uuid.uuid4()),
                            "p_query": vector_param(st.queries[0])})
    if status < 400 or "schema cache" in text or "no tenant" not in text:
        problems.append(f"unknown tenant -> {status}: {err_excerpt(text)}")
    if problems:
        record("S9", False, "; ".join(problems))
    else:
        record("S9", True, "NULL tenant and nonexistent tenant both raise from spike_search")


def s10_embedding_model_guard(base, key, st: State) -> None:
    """S10: inserting a product whose embedding_model differs from the
    tenant's model FAILS (guard trigger cloned onto the partition)."""
    row = product_row(st.id("alpha"), "sku-wrong-model", "wrong model [CANARY-WM]",
                      make_vector(996), model="some-other-model")
    status, _p, text = http_json(base, key, "POST", "/rest/v1/spike_products",
                                 body=row, headers={"Prefer": "return=minimal"})
    if status < 400:
        record("S10", False, f"wrong embedding_model accepted ({status})")
        return
    if "embedding_model" not in text:
        record("S10", False, f"rejected ({status}) but not by our guard: {err_excerpt(text)}")
        return
    record("S10", True, f"wrong embedding_model rejected by guard ({status}) — {err_excerpt(text)}")


def s11_external_id_uniqueness(base, key, st: State) -> None:
    """S11: duplicate external_id inside one tenant fails; the same
    external_id in two tenants is fine (already seeded in S1)."""
    status, _p, text = http_json(
        base, key, "POST", "/rest/v1/spike_products",
        body=[product_row(st.id("alpha"), "sku-00", "dupe [CANARY-DUPE]", make_vector(995))],
        headers={"Prefer": "return=minimal"})
    if status < 400:
        record("S11", False, f"duplicate external_id in alpha accepted ({status})")
        return
    rows = rest(base, key, "GET",
                "/rest/v1/spike_products?select=external_id,tenant_id"
                f"&external_id=eq.sku-00&limit=100")
    if len(rows) != 2 or {r["tenant_id"] for r in rows} != {st.id("alpha"), st.id("beta")}:
        record("S11", False,
               f"sku-00 across tenants: expected 1 alpha + 1 beta row, got {len(rows)}")
        return
    record("S11", True,
           f"dup in one tenant rejected ({status}); same external_id exists in both tenants")


def s12_partition_pruning(base, key, st: State) -> None:
    """S12: EXPLAIN the search for alpha: only alpha's partition is scanned.
    The plan is printed."""
    status, parsed, text = rpc(base, key, "spike_explain_search",
                               {"p_tenant_id": st.id("alpha"),
                                "p_query": vector_param(st.queries[0])})
    if status >= 300 or not isinstance(parsed, list) or not parsed:
        record("S12", False,
               "spike_explain_search failed (if EXPLAIN-in-plpgsql is unsupported, "
               f"use the manual query in README 'S12 fallback'): {status} {err_excerpt(text)}")
        return
    plan = "\n".join(str(line) for line in parsed)
    print("  ---- EXPLAIN plan (alpha) ----")
    for line in parsed[:25]:
        print(f"  | {line}")
    print("  -------------------------------")
    scans_alpha = "spike_products_alpha" in plan
    leaks = [s for s in sorted(st.tenants)
             if s != "alpha" and f"spike_products_{s}" in plan]
    if not scans_alpha:
        record("S12", False, "plan does not mention spike_products_alpha at all")
        return
    if leaks:
        record("S12", False,
               "NO PRUNING — plan also touches: " + ", ".join(leaks))
        return
    record("S12", True, "plan scans only spike_products_alpha (partition pruning works)")


def s13_drop_beta(base, key, st: State) -> None:
    """S13: spike_drop_tenant(beta): beta's partition is gone (catalog proof
    via spike_audit + zero rows via the parent); alpha's rows and search
    still work unchanged; searching for the dropped tenant now raises."""
    beta_id = st.id("beta")
    mode = partition_route_mode(base, key, st)
    rpc_ok(base, key, "spike_drop_tenant", {"p_tenant_id": beta_id})

    # Catalog proof: spike_audit reads pg_class directly — the relation
    # itself must be gone (works whether or not PostgREST exposes it).
    if any(r.get("obj_name") == "spike_products_beta" for r in audit_rows(base, key)):
        record("S13", False, "spike_products_beta still listed by spike_audit after drop")
        return

    # Data proof: the parent no longer returns any beta row.
    left = rest(base, key, "GET",
                f"/rest/v1/spike_products?tenant_id=eq.{beta_id}&select=id&limit=100")
    if left:
        record("S13", False, f"beta still has {len(left)} row(s) after drop")
        return

    # API proof — only meaningful when PostgREST exposes partition routes
    # at all; spike_drop_tenant NOTIFYs pgrst to reload, so retry briefly.
    last = "route never exposed (PostgREST excludes partitions by design)"
    if mode == "served":
        gone = False
        for _ in range(12):
            status, _p, text = http_json(base, key, "GET",
                                         "/rest/v1/spike_products_beta?limit=1")
            if status >= 400:
                gone = True
                last = f"route gone: {status} {err_excerpt(text)}"
                break
            time.sleep(1)
        if not gone:
            record("S13", False,
                   "spike_products_beta still served after drop (PostgREST schema cache "
                   "not refreshed?)")
            return

    if mode == "served":
        alpha_path = "/rest/v1/spike_products_alpha?select=id&limit=100"
    else:
        alpha_path = (f"/rest/v1/spike_products?tenant_id=eq.{st.id('alpha')}"
                      "&select=id&limit=100")
    alpha_rows = rest(base, key, "GET", alpha_path)
    search = rpc_ok(base, key, "spike_search",
                    {"p_tenant_id": st.id("alpha"),
                     "p_query": vector_param(st.queries[0]), "p_limit": 3})
    if len(alpha_rows) != 20:
        record("S13", False, f"alpha now has {len(alpha_rows)} rows, expected 20")
        return
    if not search or "CANARY-ALPHA" not in (search[0].get("title") or ""):
        record("S13", False, "alpha search broken after dropping beta")
        return

    # The dropped tenant must now be refused by spike_search (P0002 -> 404).
    status, _p, text = rpc(base, key, "spike_search",
                           {"p_tenant_id": beta_id,
                            "p_query": vector_param(st.queries[0])})
    if status < 400 or "no tenant" not in text:
        record("S13", False,
               f"spike_search(beta) after drop -> {status}: {err_excerpt(text)}")
        return

    del st.tenants["beta"]
    record("S13", True,
           f"beta gone ({last}); no beta rows remain; alpha: 20 rows + search "
           "intact; beta search raises")


def s14_audit_all(base, key, st: State) -> None:
    """S14: the audit reports no offenders for the parent and all remaining
    partitions/functions."""
    rows = audit_rows(base, key)
    bad = [(r["obj_name"], r["offenders"]) for r in rows
           if r.get("offenders")]
    if bad:
        record("S14", False, f"offenders: {bad}"[:250])
        return
    record("S14", True, f"audit clean across {len(rows)} object(s) (parent, partitions, functions)")


def s15_create_cost(base, key, st: State) -> None:
    """S15: create 3 more tenants in a loop, print per-create time, confirm
    each partition is locked down."""
    times: list[tuple[str, float]] = []
    for slug in ("gamma", "delta", "epsilon"):
        t0 = time.perf_counter()
        st.tenants[slug] = create_tenant(base, key, slug)
        dt = time.perf_counter() - t0
        times.append((slug, dt))
        print(f"  | create {slug:<8} {dt:7.2f} s")
    rows = audit_rows(base, key)
    problems = []
    for slug in ("gamma", "delta", "epsilon"):
        ok, detail = locked_down(rows, f"spike_products_{slug}")
        if not ok:
            problems.append(f"{slug}: {detail}")
    if problems:
        record("S15", False, "; ".join(problems))
    else:
        pretty = ", ".join(f"{s} {d:.2f}s" for s, d in times)
        record("S15", True, f"3 tenants created ({pretty}); all partitions locked")


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
    print("NOTE: run this against an EMPTY, ideally LOCAL spike project only.\n")

    cache_err = preflight(base, svc)
    if cache_err:
        print(f"REFUSED: {cache_err}", file=sys.stderr)
        return 2

    st = State()
    tests = [
        ("S1",  lambda: s1_setup(base, svc, st)),
        ("S2",  lambda: s2_search_isolation(base, svc, anon, st)),
        ("S3",  lambda: s3_unknown_tenant_insert_fails(base, svc, st)),
        ("S4",  lambda: s4_cross_partition_insert_fails(base, svc, st)),
        ("S5",  lambda: s5_anon_is_locked_out(base, anon, st)),
        ("S6",  lambda: s6_service_reads_partition_directly(base, svc, st)),
        ("S7",  lambda: s7_add_column(base, svc, st)),
        ("S8",  lambda: s8_late_tenant_has_column_and_locks(base, svc, st)),
        ("S9",  lambda: s9_search_guards(base, svc, st)),
        ("S10", lambda: s10_embedding_model_guard(base, svc, st)),
        ("S11", lambda: s11_external_id_uniqueness(base, svc, st)),
        ("S12", lambda: s12_partition_pruning(base, svc, st)),
        ("S13", lambda: s13_drop_beta(base, svc, st)),
        ("S14", lambda: s14_audit_all(base, svc, st)),
        ("S15", lambda: s15_create_cost(base, svc, st)),
    ]
    for name, fn in tests:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 — one broken step must not hide the rest
            record(name, False, f"unexpected error: {exc}")

    ok = print_table()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
