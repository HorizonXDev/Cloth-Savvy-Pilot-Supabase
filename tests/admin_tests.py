#!/usr/bin/env python3
"""HTTP tests for the admin_* dashboard functions — LOCAL Docker stack ONLY.

Stdlib only. Mirrors tests/api_tests.py conventions: it spawns the host-Deno
harness (tests/serve_local.ts) and the two local stubs itself, runs the full
admin flow end to end, prints a PASS/FAIL table, and exits 0/1/2.

Run order (README §11.10):
  supabase start
  python tests/admin_tests.py
  python tests/cleanup_test_tenants.py

The admin token comes from ADMIN_TOKEN in supabase/functions/.env (the local
dev token — never a production secret) or from the environment.

Exit codes: 0 = all passed, 1 = at least one FAIL, 2 = refused to run.
"""

from __future__ import annotations

import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, SCRIPT_DIR)

from api_tests import (  # noqa: E402 - shared harness/stub helpers
    HARNESS_URL,
    Refused,
    STUB_ENCODER_PORT,
    TestError,
    api,
    check_target_allowed,
    ensure_harness,
    ensure_stubs,
    err_code,
    j,
    kill_proc_tree,
    load_dotenv_if_present,
    record,
    require_config,
    stub_config,
)
import api_tests as _api_tests  # noqa: E402  (RESULTS/RESULTS table reuse)

RESULTS = _api_tests.RESULTS  # same global list -> same summary printer
ALLOWED_ORIGIN = "http://localhost:3000"

SLUG_A = "test_admin_a"
SLUG_B = "test_admin_b"


def load_admin_token() -> str:
    tok = os.environ.get("ADMIN_TOKEN")
    if tok:
        return tok
    env_path = os.path.join(PROJECT_DIR, "supabase", "functions", ".env")
    try:
        with open(env_path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("ADMIN_TOKEN=") and "ADMIN_TOKEN=" in line:
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    raise Refused("ADMIN_TOKEN not found (export it or add it to "
                  "supabase/functions/.env — see README §11.10)")


def admin(fns: str, token: str, method: str, path: str, body=None, headers=None):
    hdrs = {"Authorization": f"Bearer {token}"}
    if headers:
        hdrs.update(headers)
    return api(fns, None, method, path, body=body, headers=hdrs)


def drop_slug(base: str, svc: str, slug: str) -> None:
    status, rows, text, _ = j(base, svc, "GET", "/rest/v1/tenants?select=id,slug&limit=1000")
    if status != 200:
        return
    for t in rows or []:
        if t.get("slug") == slug:
            j(base, svc, "PATCH", f"/rest/v1/tenants?id=eq.{t['id']}", body={"status": "suspended"})
            j(base, svc, "POST", "/rest/v1/rpc/drop_tenant",
              body={"p_tenant_id": t["id"], "p_confirm_slug": slug})


class Fx:
    fns = ""
    token = ""
    base = svc = ""
    tid_a = tid_b = ""
    key = ""
    run_id = ""
    adm1_id = ""


fx = Fx()


def a01_auth():
    st, parsed, _, _ = admin(fx.fns, "", "GET", "/admin_tenants")
    ok = st == 401 and err_code(parsed) == "unauthorized"
    st2, parsed2, _, _ = admin(fx.fns, "wrong-token-x", "GET", "/admin_tenants")
    ok = ok and st2 == 401
    st3, parsed3, _, hdrs = admin(fx.fns, fx.token, "GET", "/admin_tenants")
    ok = ok and st3 == 200 and isinstance(parsed3.get("tenants"), list)
    acao = hdrs.get("Access-Control-Allow-Origin")
    record("A01 admin auth (401s, then 200)", ok,
           f"no-token={st} wrong={st2} with-token={st3} acao={acao}")


def a02_create_tenant():
    st, parsed, _, _ = admin(fx.fns, fx.token, "POST", "/admin_tenants",
                             body={"slug": SLUG_A, "name": "Admin Test A",
                                   "website_url": "https://a.example"})
    if st != 201:
        record("A02 create tenant + duplicate refused", False, f"create={st} {str(parsed)[:160]}")
        return
    t = parsed["tenant"]
    fx.tid_a = t["id"]
    st2, parsed2, _, _ = admin(fx.fns, fx.token, "POST", "/admin_tenants",
                               body={"slug": SLUG_A, "name": "dup"})
    ok = (t["slug"] == SLUG_A and t["status"] == "active"
          and t["embedding_dim"] == 512
          and t["settings"].get("default_limit") == 10
          and st2 == 400)
    record("A02 create tenant + duplicate refused", ok,
           f"id={t['id'][:8]}… model={t['embedding_model']} dup={st2}")


def a03_settings():
    st, parsed, _, _ = admin(fx.fns, fx.token, "PATCH", "/admin_tenants",
                             body={"id": fx.tid_a, "settings": {"min_similarity": 0.4}})
    merged = parsed.get("tenant", {}).get("settings", {}) if st == 200 else {}
    ok = st == 200 and merged.get("min_similarity") == 0.4 and merged.get("default_limit") == 10 \
        and "combos" in merged  # merge keeps the rest
    st2, parsed2, _, _ = admin(fx.fns, fx.token, "PATCH", "/admin_tenants",
                               body={"id": fx.tid_a, "settings": {"min_similarity": 1.5}})
    ok = ok and st2 == 400 and "min_similarity" in str(parsed2)
    st3, parsed3, _, _ = admin(fx.fns, fx.token, "PATCH", "/admin_tenants",
                               body={"id": fx.tid_a, "settings": {"combos": {"office": ["hats"]}}})
    ok = ok and st3 == 400  # invalid section dropped -> strict reject
    record("A03 settings merge + strict reject", ok,
           f"patch={st} merged sim={merged.get('min_similarity')} bad={st2} badsection={st3}")


def a04_keys():
    st, parsed, _, _ = admin(fx.fns, fx.token, "POST", "/admin_keys",
                             body={"tenant_id": fx.tid_a, "environment": "sandbox", "label": "admin-test"})
    if st != 201:
        record("A04 issue/list/use/revoke keys", False, f"issue={st} {str(parsed)[:160]}")
        return
    plaintext = parsed["plaintext"]
    fx.key = plaintext
    listed_ok = False
    stl, parsedl, _, _ = admin(fx.fns, fx.token, "GET", f"/admin_keys?tenant_id={fx.tid_a}")
    if stl == 200:
        rows = parsedl["keys"]
        listed_ok = (len(rows) >= 1 and "key_hash" not in rows[0]
                     and rows[0]["key_prefix"] == plaintext[:12])
    st2, parsed2, _, _ = api(fx.fns, plaintext, "GET", "/occasions")
    st3, parsed3, _, _ = admin(fx.fns, fx.token, "PATCH", "/admin_keys",
                               body={"tenant_id": fx.tid_a, "key_id": parsed["key"]["id"]})
    revoked = st3 == 200 and parsed3["key"]["revoked_at"] is not None
    st4, parsed4, _, _ = api(fx.fns, plaintext, "GET", "/occasions")
    st5, parsed5, _, _ = admin(fx.fns, fx.token, "PATCH", "/admin_keys",
                               body={"tenant_id": fx.tid_a, "key_id": parsed["key"]["id"]})
    # a second key for the remaining tests (this one stays valid)
    st6, parsed6, _, _ = admin(fx.fns, fx.token, "POST", "/admin_keys",
                               body={"tenant_id": fx.tid_a, "environment": "sandbox", "label": "admin-work"})
    if st6 == 201:
        fx.key = parsed6["plaintext"]
    ok = (plaintext.startswith("sk_test_") and len(plaintext) == 51 and listed_ok
          and st2 == 200 and revoked and st4 == 401
          and parsed5.get("already_revoked") is True and st6 == 201)
    record("A04 issue/list/use/revoke keys", ok,
           f"issued len={len(plaintext)} use={st2} revoke={st3} after={st4} re-revoke={st5}")


def a05_suspend():
    st, _, _, _ = admin(fx.fns, fx.token, "PATCH", "/admin_tenants",
                        body={"id": fx.tid_a, "status": "suspended"})
    st2, parsed2, _, _ = api(fx.fns, fx.key, "GET", "/occasions")
    st3, _, _, _ = admin(fx.fns, fx.token, "PATCH", "/admin_tenants",
                         body={"id": fx.tid_a, "status": "active"})
    st4, _, _, _ = api(fx.fns, fx.key, "GET", "/occasions")
    ok = st == 200 and st2 == 403 and st3 == 200 and st4 == 200
    record("A05 suspend blocks API; reactivate restores", ok,
           f"suspend={st} blocked={st2} reactivate={st3} restored={st4}")


def a06_usage():
    for _ in range(3):
        api(fx.fns, fx.key, "GET", "/occasions")
    st, parsed, _, _ = admin(fx.fns, fx.token, "GET", f"/admin_usage?tenant_id={fx.tid_a}&days=7")
    if st != 200:
        record("A06 usage aggregates", False, f"http={st}")
        return
    totals = parsed["totals"]
    eps = {e["endpoint"]: e["calls"] for e in parsed["by_endpoint"]}
    keys = {k["prefix"]: k["calls"] for k in parsed["by_key"]}
    ok = totals["calls"] >= 4 and eps.get("occasions", 0) >= 3 and len(keys) >= 1 \
        and any(v["calls"] > 0 for v in [k for k in parsed["by_key"]])
    record("A06 usage aggregates", ok,
           f"calls={totals['calls']} endpoints={sorted(eps)} keys={len(parsed['by_key'])}")


def a07_import():
    st, parsed, _, _ = admin(fx.fns, fx.token, "POST", "/admin_catalog",
                             body={"op": "import_start", "tenant_id": fx.tid_a, "rows_total": 3})
    if st != 201:
        record("A07 import: batch, per-row failures, counters", False, f"start={st}")
        return
    fx.run_id = parsed["run"]["id"]
    rows = [
        {"external_id": "ADM-1", "title": "Blue cotton kurta", "section": "top",
         "category": "top", "colors": ["blue"], "price": 999.0},
        {"external_id": "ADM-2", "title": "Linen office shirt", "section": "top",
         "category": "shirt", "colors": ["blue", "white"], "price": 1499.0},
        {"external_id": "ADM-3", "title": "Bad hat", "section": "hats"},  # invalid section
    ]
    st2, parsed2, _, _ = admin(fx.fns, fx.token, "POST", "/admin_catalog",
                               body={"op": "import_batch", "tenant_id": fx.tid_a,
                                     "run_id": fx.run_id, "rows": rows})
    batch_ok = (st2 == 200 and parsed2["batch"]["ok"] == 2 and parsed2["batch"]["failed"] == 1
                and "section" in parsed2["failed"][0]["reason"])
    # duplicate re-import -> honest per-row failure, counters move
    st3, parsed3, _, _ = admin(fx.fns, fx.token, "POST", "/admin_catalog",
                               body={"op": "import_batch", "tenant_id": fx.tid_a,
                                     "run_id": fx.run_id, "rows": [rows[0]]})
    dup_ok = st3 == 200 and parsed3["batch"]["failed"] == 1 \
        and "duplicate" in parsed3["failed"][0]["reason"]
    st4, runs, _, _ = admin(fx.fns, fx.token, "GET", f"/admin_catalog?op=runs&tenant_id={fx.tid_a}")
    run = next((r for r in runs.get("runs", []) if r["id"] == fx.run_id), {})
    st5, parsed5, _, _ = admin(fx.fns, fx.token, "GET", f"/admin_catalog?op=products&tenant_id={fx.tid_a}")
    total = parsed5.get("total") if st5 == 200 else -1
    st6, _, _, _ = admin(fx.fns, fx.token, "POST", "/admin_catalog",
                         body={"op": "import_finish", "tenant_id": fx.tid_a,
                               "run_id": fx.run_id, "status": "done"})
    st7, parsed7, _, _ = admin(fx.fns, fx.token, "POST", "/admin_catalog",
                               body={"op": "import_batch", "tenant_id": fx.tid_a,
                                     "run_id": fx.run_id, "rows": [rows[1]]})
    ok = (batch_ok and dup_ok and st4 == 200
          and run.get("rows_ok") == 2 and run.get("rows_failed") == 2
          and total == 2 and st6 == 200 and st7 == 400)
    record("A07 import: batch, per-row failures, counters", ok,
           f"batch={parsed2['batch']} dup_failed={parsed3['batch']['failed']} "
           f"run_ok={run.get('rows_ok')} run_failed={run.get('rows_failed')} total={total} finished={st7}")


def a08_search_preview():
    st, parsed, _, _ = admin(fx.fns, fx.token, "POST", "/admin_catalog",
                             body={"op": "search", "tenant_id": fx.tid_a,
                                   "query": "Blue cotton kurta top blue"})
    top = (parsed.get("items") or [{}])[0]
    ok = st == 200 and top.get("product", {}).get("external_id") == "ADM-1" \
        and (top.get("similarity") or 0) >= 0.9
    st2, parsed2, _, _ = admin(fx.fns, fx.token, "POST", "/admin_catalog",
                               body={"op": "search", "tenant_id": fx.tid_a, "query": "zzz qqq xyzzy"})
    honest = st2 == 200 and parsed2.get("no_match") is True and parsed2.get("items") == []
    record("A08 search preview (ranked + honest no_match)", ok and honest,
           f"http={st} top={top.get('product', {}).get('external_id')} "
           f"sim={top.get('similarity')} no_match={parsed2.get('no_match') if st2 == 200 else st2}")


def a09_archive():
    st, parsed, _, _ = admin(fx.fns, fx.token, "GET",
                             f"/admin_catalog?op=products&tenant_id={fx.tid_a}&q=kurta")
    adm1 = next((p for p in parsed.get("products", []) if p["external_id"] == "ADM-1"), None)
    if not adm1:
        record("A08 archive hides product + from search", False, "ADM-1 not found")
        return
    st2, parsed2, _, _ = admin(fx.fns, fx.token, "POST", "/admin_catalog",
                               body={"op": "set_status", "tenant_id": fx.tid_a,
                                     "product_ids": [adm1["id"]], "status": "archived"})
    st3, parsed3, _, _ = admin(fx.fns, fx.token, "POST", "/admin_catalog",
                               body={"op": "search", "tenant_id": fx.tid_a,
                                     "query": "Blue cotton kurta top blue"})
    still_there = any(i["product"]["external_id"] == "ADM-1" for i in parsed3.get("items", []))
    record("A09 archive hides product + from search",
           st2 == 200 and parsed2["updated"] == 1 and not still_there,
           f"archived={parsed2.get('updated')} still_in_search={still_there}")


def a10_isolation():
    st, parsed, _, _ = admin(fx.fns, fx.token, "POST", "/admin_tenants",
                             body={"slug": SLUG_B, "name": "Admin Test B"})
    if st != 201:
        record("A10 tenant isolation (products/usage/keys)", False, f"create={st}")
        return
    fx.tid_b = parsed["tenant"]["id"]
    stp, parsedp, _, _ = admin(fx.fns, fx.token, "GET", f"/admin_catalog?op=products&tenant_id={fx.tid_b}")
    stu, parsedu, _, _ = admin(fx.fns, fx.token, "GET", f"/admin_usage?tenant_id={fx.tid_b}&days=7")
    stk, parsedk, _, _ = admin(fx.fns, fx.token, "GET", f"/admin_keys?tenant_id={fx.tid_b}")
    ok = (stp == 200 and parsedp["total"] == 0
          and stu == 200 and parsedu["totals"]["calls"] == 0
          and stk == 200 and parsedk["keys"] == [])
    record("A10 tenant isolation (products/usage/keys)", ok,
           f"B products={parsedp.get('total')} usage={parsedu['totals']['calls'] if stu == 200 else stu} "
           f"keys={len(parsedk.get('keys', [])) if stk == 200 else stk}")


def a11_cors():
    st, _, _, hdrs = admin(fx.fns, fx.token, "OPTIONS", "/admin_tenants",
                           headers={"Origin": ALLOWED_ORIGIN,
                                    "Access-Control-Request-Method": "GET"})
    acao_ok = hdrs.get("Access-Control-Allow-Origin") == ALLOWED_ORIGIN
    st2, _, _, hdrs2 = admin(fx.fns, fx.token, "OPTIONS", "/admin_tenants",
                             headers={"Origin": "https://evil.example",
                                      "Access-Control-Request-Method": "GET"})
    no_echo = hdrs2.get("Access-Control-Allow-Origin") is None
    record("A11 admin CORS allowlist (never *, no echo)", st == 204 and acao_ok and st2 == 204 and no_echo,
           f"allowed acao={hdrs.get('Access-Control-Allow-Origin')} "
           f"disallowed acao={hdrs2.get('Access-Control-Allow-Origin')}")


def a12_health():
    st, parsed, _, _ = admin(fx.fns, fx.token, "GET", "/admin_catalog?op=health")
    ok = st == 200 and parsed.get("status") == "ok" \
        and parsed.get("encoder", {}).get("status") == "ok"
    record("A12 admin health (db + encoder ok)", ok,
           f"http={st} status={parsed.get('status')} encoder={parsed.get('encoder', {}).get('status')}")


def a13_delete_tenant():
    """A13: DELETE /admin_tenants honours the drop_tenant contract:
    refused while ACTIVE, refused on a wrong confirm slug, deletes when
    suspended + slug matches, and the tenant is gone afterwards."""
    slug = "admin_test_drop"
    st, parsed, _, _ = admin(fx.fns, fx.token, "POST", "/admin_tenants",
                             body={"slug": slug, "name": "Delete Me"})
    if st != 201:
        record("A13 delete tenant (suspend-first + typed slug)", False, f"create={st}")
        return
    tid = parsed["tenant"]["id"]
    try:
        # (a) an ACTIVE tenant is never dropped, even with the right slug
        s1, p1, _, _ = admin(fx.fns, fx.token, "DELETE", "/admin_tenants",
                             body={"id": tid, "confirm_slug": slug})
        # (b) suspend, then a wrong slug must be refused by name
        admin(fx.fns, fx.token, "PATCH", "/admin_tenants",
              body={"id": tid, "status": "suspended"})
        s2, p2, _, _ = admin(fx.fns, fx.token, "DELETE", "/admin_tenants",
                             body={"id": tid, "confirm_slug": "WRONG_SLUG"})
        msg2 = ((p2 or {}).get("error") or {}).get("message", "")
        # (c) suspended + exact slug -> gone
        s3, p3, _, _ = admin(fx.fns, fx.token, "DELETE", "/admin_tenants",
                             body={"id": tid, "confirm_slug": slug})
        s4, p4, _, _ = admin(fx.fns, fx.token, "GET", "/admin_tenants")
        gone = s4 == 200 and all(t.get("id") != tid for t in (p4 or {}).get("tenants", []))
        active_msg = ((p1 or {}).get("error") or {}).get("message", "")
        ok = (s1 == 400 and "suspend" in active_msg
              and s2 == 400 and "mismatch" in msg2
              and s3 == 200 and (p3 or {}).get("deleted") is True
              and gone)
        record("A13 delete tenant (suspend-first + typed slug)", ok,
               f"active={s1}({active_msg[:40]}) wrong_slug={s2} "
               f"deleted={s3} gone={gone}")
    finally:
        drop_slug(fx.base, fx.svc, slug)  # harmless if already gone


def main() -> int:
    load_dotenv_if_present()
    fx.token = load_admin_token()
    stub_procs = []
    harness_proc = None
    try:
        base, svc, _fns_default = require_config()
        check_target_allowed(base)
    except Refused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 2
    fx.base, fx.svc = base, svc
    fx.fns = os.environ.get("PILOT_FUNCTIONS_URL") or HARNESS_URL

    try:
        if not os.environ.get("PILOT_FUNCTIONS_URL"):
            harness_proc = ensure_harness(base, svc)
    except Refused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 2

    def stop_resources():
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
        stub_config(STUB_ENCODER_PORT, {"model": "fashion-clip", "fail_status": 0, "delay_s": 0})

        try:
            st, _, _, _ = api(fx.fns, None, "GET", "/health")
        except TestError as exc:
            print(f"REFUSED: {exc}", file=sys.stderr)
            stop_resources()
            return 2
        if st != 200:
            print(f"REFUSED: admin functions not served (health {st})", file=sys.stderr)
            stop_resources()
            return 2

        print(f"target: {base}   admin functions: {fx.fns}", flush=True)
        drop_slug(base, svc, SLUG_A)
        drop_slug(base, svc, SLUG_B)

        try:
            for name, fn in [
                ("A01", a01_auth),
                ("A02", a02_create_tenant),
                ("A03", a03_settings),
                ("A04", a04_keys),
                ("A05", a05_suspend),
                ("A06", a06_usage),
                ("A07", a07_import),
                ("A08", a08_search_preview),
                ("A09", a09_archive),
                ("A10", a10_isolation),
                ("A11", a11_cors),
                ("A12", a12_health),
                ("A13", a13_delete_tenant),
            ]:
                if not fx.tid_a and fn not in (a01_auth, a02_create_tenant):
                    # fixture tenant missing -> every later test is noise
                    record(name, False, "skipped (no tenant A)")
                    continue
                try:
                    fn()
                except Exception as exc:  # noqa: BLE001 - one crash must not kill the run
                    record(name, False, f"exception: {type(exc).__name__}: {exc}")
        finally:
            try:
                stub_config(STUB_ENCODER_PORT,
                            {"model": "fashion-clip", "fail_status": 0, "delay_s": 0})
            except Exception:
                pass
            for slug in (SLUG_A, SLUG_B):
                try:
                    drop_slug(base, svc, slug)
                except Exception:
                    pass
            stop_resources()
    except Refused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        stop_resources()
        return 2

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


if __name__ == "__main__":
    sys.exit(main())
