#!/usr/bin/env python3
"""HTTP tests for the tenant_* portal functions — LOCAL Docker stack ONLY.

Stdlib only. Reuses the api_tests.py harness conventions (spawns the
host-Deno harness + the two stubs itself, PASS/FAIL table, exit 0/1/2).

What this suite proves, end to end:
  * a portal login is provisioned by the admin (mode "password" shows a
    temporary password ONCE; mode "invite" is SMTP-dependent and accepted
    in either outcome),
  * a real password-grant session drives every tenant_* route,
  * CREDENTIAL SEPARATION (the two-dashboard requirement):
      - a portal session JWT is REJECTED by every admin_* route (401),
      - ADMIN_TOKEN is REJECTED by every tenant_* route (401),
      - an sk_ API key is REJECTED by tenant_* routes, and a portal
        session is REJECTED by the public API,
  * TENANT SCOPING: a forged tenant_id in query/body is IGNORED — the
    answer is always the session's own tenant; tenant B sees none of A's
    data,
  * revoke cuts access off (403) and reinstate restores it; delete
    removes the login entirely; an auth user with no membership row gets
    403; a suspended tenant's portal gets 403,
  * portal traffic is NEVER metered (usage_events untouched),
  * CORS: the portal allowlist (3001) and the admin allowlist (3000) are
    disjoint on their own routes.

Run order (README §11.11):
  supabase start            # + `supabase db reset` after new migrations
  python tests/tenant_portal_tests.py
  python tests/cleanup_test_tenants.py

Exit codes: 0 = all passed, 1 = at least one FAIL, 2 = refused to run.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error as urlerror
import urllib.request as urlrequest

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
    seed_products_via_job,
    require_config,
    stub_config,
)
import api_tests as _api_tests  # noqa: E402  (RESULTS table reuse)

RESULTS = _api_tests.RESULTS  # same global list -> same summary printer

PORTAL_ORIGIN = "http://localhost:3001"
ADMIN_ORIGIN = "http://localhost:3000"
EVIL_ORIGIN = "https://evil.example"

SLUG_A = "test_portal_a"
SLUG_B = "test_portal_b"
EMAIL_A = "test_portal_a@example.test"
EMAIL_B = "test_portal_b@example.test"
EMAIL_INVITE_PROBE = "test_portal_inviteprobe@example.test"
EMAIL_C = "test_portal_c@example.test"  # deleted-mid-test
EMAIL_D = "test_portal_d@example.test"  # created WITHOUT membership
PASSWORD_C = "c-password-12345"
PASSWORD_D = "d-password-12345"


# ------------------------------------------------------------------ GoTrue
def gt(base: str, key: str, method: str, path: str, body=None):
    """Raw call to a GoTrue endpoint under {base}/auth/v1 (apikey header)."""
    url = f"{base}/auth/v1/{path.lstrip('/')}"
    data = json.dumps(body).encode() if body is not None else None
    req = urlrequest.Request(url, data=data, method=method)
    req.add_header("apikey", key)
    # GoTrue admin routes require a valid Bearer token in addition to the
    # apikey header (verified locally: apikey-only -> 401 no_authorization).
    req.add_header("Authorization", f"Bearer {key}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urlrequest.urlopen(req, timeout=20) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urlerror.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return e.code, {"msg": raw[:200]}
    except Exception as exc:  # noqa: BLE001 - surfaced as a test failure
        return 0, {"msg": f"{type(exc).__name__}: {exc}"}


def sign_in(base: str, anon: str, email: str, password: str):
    """Password grant -> (status, access_token|None, message)."""
    status, parsed = gt(base, anon, "POST", "token?grant_type=password",
                        {"email": email, "password": password})
    if status == 200 and isinstance(parsed, dict) and parsed.get("access_token"):
        return 200, parsed["access_token"], "ok"
    msg = ""
    if isinstance(parsed, dict):
        msg = str(parsed.get("msg") or parsed.get("error_description")
                  or parsed.get("error") or "")
    return status, None, msg[:160]


def create_auth_user(base: str, svc: str, email: str, password: str):
    """Direct GoTrue admin create (used for the no-membership probe)."""
    return gt(base, svc, "POST", "admin/users",
              {"email": email, "password": password, "email_confirm": True})


def delete_auth_user(base: str, svc: str, user_id: str) -> None:
    gt(base, svc, "DELETE", f"admin/users/{user_id}")


def list_test_portal_users(base: str, svc: str):
    status, parsed = gt(base, svc, "GET", "admin/users?page=1&per_page=200")
    if status != 200 or not isinstance(parsed, dict):
        return []
    return [u for u in (parsed.get("users") or [])
            if str(u.get("email", "")).startswith("test_portal_")]


# ------------------------------------------------------------- test client
def portal(fns: str, token: str | None, method: str, path: str, body=None, headers=None):
    """Call a tenant_* endpoint with an optional session bearer."""
    hdrs = {}
    if token:
        hdrs["Authorization"] = f"Bearer {token}"
    if headers:
        hdrs.update(headers)
    return api(fns, None, method, path, body=body, headers=hdrs)


def admin(fns: str, token: str, method: str, path: str, body=None, headers=None):
    hdrs = {"Authorization": f"Bearer {token}"}
    if headers:
        hdrs.update(headers)
    return api(fns, None, method, path, body=body, headers=hdrs)


def drop_slug(base: str, svc: str, slug: str) -> None:
    status, rows, _, _ = j(base, svc, "GET", "/rest/v1/tenants?select=id,slug&limit=1000")
    if status != 200:
        return
    for t in rows or []:
        if t.get("slug") == slug:
            j(base, svc, "PATCH", f"/rest/v1/tenants?id=eq.{t['id']}", body={"status": "suspended"})
            j(base, svc, "POST", "/rest/v1/rpc/drop_tenant",
              body={"p_tenant_id": t["id"], "p_confirm_slug": slug})


def invite(fns: str, adm_token: str, tenant_id: str, email: str, mode: str):
    return admin(fns, adm_token, "POST", "/admin_tenant_users",
                 body={"tenant_id": tenant_id, "email": email, "mode": mode})


class Fx:
    fns = ""
    base = svc = anon = ""
    adm = ""
    tid_a = tid_b = ""
    tok_a = tok_b = ""
    pass_a = ""
    user_a = user_b = ""
    key = ""
    created_users: list[str] = []


fx = Fx()


# ------------------------------------------------------------------ tests
def p01_auth_gates():
    """No/garbage/admin-token/sk_ credentials are ALL rejected on tenant_*. """
    cases = {}
    st0, p0, _, _ = portal(fx.fns, None, "GET", "/tenant_account")
    cases["none"] = (st0, err_code(p0))
    st1, p1, _, _ = portal(fx.fns, "not-a-jwt", "GET", "/tenant_account")
    cases["garbage"] = (st1, err_code(p1))
    st2, p2, _, _ = portal(fx.fns, fx.adm, "GET", "/tenant_account")
    cases["admin-token"] = (st2, err_code(p2))  # ADMIN_TOKEN is not a JWT
    st3, p3, _, _ = portal(fx.fns, "sk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                           "GET", "/tenant_account")
    cases["sk-key"] = (st3, err_code(p3))
    ok = all(st == 401 and code == "unauthorized" for st, code in cases.values())
    record("P01 tenant routes reject non-session credentials", ok,
           " ".join(f"{k}={v[0]}" for k, v in cases.items()))


def p02_login_and_account():
    """Admin provisions a login (password mode) -> real sign-in -> whoami."""
    st, parsed, _, _ = admin(fx.fns, fx.adm, "POST", "/admin_tenants",
                             body={"slug": SLUG_A, "name": "Portal Test A"})
    if st != 201:
        record("P02 provision login, sign in, whoami", False, f"create A={st}")
        return
    fx.tid_a = parsed["tenant"]["id"]

    st, parsed, _, _ = admin(fx.fns, fx.adm, "POST", "/admin_tenants",
                             body={"slug": SLUG_B, "name": "Portal Test B"})
    if st != 201:
        record("P02 provision login, sign in, whoami", False, f"create B={st}")
        return
    fx.tid_b = parsed["tenant"]["id"]

    st, parsed, _, _ = invite(fx.fns, fx.adm, fx.tid_a, EMAIL_A, "password")
    if st != 201 or not parsed.get("temporary_password"):
        record("P02 provision login, sign in, whoami", False,
               f"invite={st} {str(parsed)[:140]}")
        return
    fx.pass_a = parsed["temporary_password"]
    fx.user_a = parsed["user_id"]
    fx.created_users.append(fx.user_a)

    st2, tok, msg = sign_in(fx.base, fx.anon, EMAIL_A, fx.pass_a)
    if not tok:
        record("P02 provision login, sign in, whoami", False, f"sign-in={st2} {msg}")
        return
    fx.tok_a = tok

    st3, acct, _, _ = portal(fx.fns, fx.tok_a, "GET", "/tenant_account")
    acct_ok = (st3 == 200 and acct.get("tenant", {}).get("slug") == SLUG_A
               and acct.get("user", {}).get("email") == EMAIL_A
               and isinstance(acct.get("settings"), dict)
               and "combos" in acct.get("settings", {}))

    # wrong password must fail
    st4, _, _ = sign_in(fx.base, fx.anon, EMAIL_A, "definitely-wrong")
    record("P02 provision login, sign in, whoami", acct_ok and st4 != 200,
           f"invite=201 sign-in={st2} account={st3} slug={acct.get('tenant', {}).get('slug') if st3 == 200 else '-'} wrongpw={st4}")


def p03_invite_mode_probe():
    """mode 'invite' works OR fails with the SMTP hint — both acceptable."""
    st, parsed, _, _ = invite(fx.fns, fx.adm, fx.tid_a, EMAIL_INVITE_PROBE, "invite")
    accepted = st == 201 or (st == 400 and "mode" in str(parsed))
    if st == 201 and isinstance(parsed, dict) and parsed.get("user_id"):
        # clean up the invited user (no password set — cannot sign in anyway)
        fx.created_users.append(parsed["user_id"])
    record("P03 invite mode (201, or honest SMTP hint)", accepted,
           f"http={st} {str(parsed)[:120]}")


def p04_keys_lifecycle():
    st, parsed, _, _ = portal(fx.fns, fx.tok_a, "POST", "/tenant_keys",
                              body={"environment": "sandbox", "label": "portal-test"})
    if st != 201:
        record("P04 portal keys: issue(show-once)/use/revoke", False, f"issue={st}")
        return
    plaintext = parsed["plaintext"]
    fx.key = plaintext
    listed_ok = False
    stl, parsedl, _, _ = portal(fx.fns, fx.tok_a, "GET", "/tenant_keys")
    if stl == 200:
        rows = parsedl["keys"]
        listed_ok = (len(rows) >= 1 and "key_hash" not in rows[0]
                     and rows[0]["key_prefix"] == plaintext[:12])
    st2, _, _, _ = api(fx.fns, plaintext, "GET", "/occasions")
    st3, parsed3, _, _ = portal(fx.fns, fx.tok_a, "PATCH", "/tenant_keys",
                                body={"key_id": parsed["key"]["id"]})
    revoked = st3 == 200 and parsed3["key"]["revoked_at"] is not None
    st4, _, _, _ = api(fx.fns, plaintext, "GET", "/occasions")
    # mint a fresh working key for later tests
    st5, parsed5, _, _ = portal(fx.fns, fx.tok_a, "POST", "/tenant_keys",
                                body={"environment": "sandbox", "label": "portal-work"})
    if st5 == 201:
        fx.key = parsed5["plaintext"]
    ok = (plaintext.startswith("sk_test_") and len(plaintext) == 51 and listed_ok
          and st2 == 200 and revoked and st4 == 401 and st5 == 201)
    record("P04 portal keys: issue(show-once)/use/revoke", ok,
           f"len={len(plaintext)} list={stl} use={st2} revoke={st3} after={st4} reissue={st5}")


def p05_usage_and_forged_tenant():
    for _ in range(3):
        api(fx.fns, fx.key, "GET", "/occasions")
    st, parsed, _, _ = portal(fx.fns, fx.tok_a, "GET", "/tenant_usage?days=7")
    if st != 200:
        record("P05 usage aggregates + forged tenant_id ignored", False, f"http={st}")
        return
    totals = parsed.get("totals", {})
    mtd = parsed.get("month_to_date", {})
    eps = {e["endpoint"]: e["calls"] for e in parsed.get("by_endpoint", [])}
    base_ok = (totals.get("calls", 0) >= 3 and eps.get("occasions", 0) >= 3
               and mtd.get("calls", 0) >= 3
               and parsed.get("tenant_id") == fx.tid_a)
    # forged tenant_id must be ignored — answer stays session-scoped
    stf, pf, _, _ = portal(fx.fns, fx.tok_a, "GET",
                           f"/tenant_usage?days=7&tenant_id={fx.tid_b}")
    forged_ok = stf == 200 and pf.get("tenant_id") == fx.tid_a
    record("P05 usage aggregates + forged tenant_id ignored",
           base_ok and forged_ok,
           f"calls={totals.get('calls')} mtd={mtd.get('calls')} "
           f"forged_tenant={'own' if forged_ok else 'LEAKED'}")


def p06_catalog_scoping():
    # seed 2 products for A through the OWNER pipeline: queue -> vectors -> merge
    rows = [
        {"external_id": "PRT-1", "title": "Indigo block print kurta", "section": "top",
         "category": "top", "colors": ["blue"], "price": 1299.0,
         "image_url": "https://cdn.invalid/prt1.jpg"},
        {"external_id": "PRT-2", "title": "Gold zari saree", "section": "saree",
         "category": "saree", "colors": ["gold"], "price": 8999.0,
         "image_url": "https://cdn.invalid/prt2.jpg"},
    ]
    try:
        seeded = seed_products_via_job(fx.base, fx.svc, fx.fns, fx.adm, fx.tid_a,
                                       rows, source="p06.csv")
    except TestError as e:
        record("P06 catalog scoped to session tenant (A sees, B doesn't)", False,
               f"seed failed: {e}")
        return
    st2 = 200 if (seeded or {}).get("counts", {}).get("merged") == 2 else -1

    # session A browse
    sta, pa, _, _ = portal(fx.fns, fx.tok_a, "GET", "/tenant_catalog?op=products")
    a_total = pa.get("total", -1) if sta == 200 else -1
    # forged tenant_id in the query must NOT switch the view (B has 0 products
    # and A has 2 — honoring the parameter would show 0)
    stf, pf, _, _ = portal(fx.fns, fx.tok_a, "GET",
                           f"/tenant_catalog?op=products&tenant_id={fx.tid_b}")
    forged_total = pf.get("total", -1) if stf == 200 else -1

    # session B must see nothing of A's
    stb, pb, _, _ = portal(fx.fns, fx.tok_b, "GET", "/tenant_catalog?op=products")
    b_total = pb.get("total", -1) if stb == 200 else -1

    ok = (st2 == 200 and sta == 200 and a_total == 2
          and forged_total == 2 and stb == 200 and b_total == 0)
    record("P06 catalog scoped to session tenant (A sees, B doesn't)", ok,
           f"seed={st2} A={a_total} forged={forged_total} B={b_total}")


def p07_session_b_gets_own_account():
    # P06 may have provisioned B on demand (fx.user_b set) — reuse it.
    if not fx.tok_b:
        st, parsed, _, _ = invite(fx.fns, fx.adm, fx.tid_b, EMAIL_B, "password")
        if st != 201 or not parsed.get("temporary_password"):
            record("P07 tenant B login isolated from A", False, f"invite={st}")
            return
        fx.user_b = parsed["user_id"]
        fx.created_users.append(fx.user_b)
        st2, tok, msg = sign_in(fx.base, fx.anon, EMAIL_B, parsed["temporary_password"])
        if not tok:
            record("P07 tenant B login isolated from A", False, f"sign-in={st2} {msg}")
            return
        fx.tok_b = tok
    st3, acct, _, _ = portal(fx.fns, fx.tok_b, "GET", "/tenant_account")
    st4, usage_b, _, _ = portal(fx.fns, fx.tok_b, "GET", "/tenant_usage?days=7")
    keys_st, keys_b, _, _ = portal(fx.fns, fx.tok_b, "GET", "/tenant_keys")
    ok = (st3 == 200 and acct["tenant"]["slug"] == SLUG_B
          and st4 == 200 and usage_b.get("tenant_id") == fx.tid_b
          and usage_b.get("totals", {}).get("calls", 0) == 0   # none of A's calls
          and keys_st == 200 and keys_b.get("keys") == [])      # none of A's keys
    record("P07 tenant B login isolated from A", ok,
           f"slug={acct.get('tenant', {}).get('slug') if st3 == 200 else st3} "
           f"B_calls={usage_b.get('totals', {}).get('calls') if st4 == 200 else st4} "
           f"B_keys={len(keys_b.get('keys', [])) if keys_st == 200 else keys_st}")


def p08_sudo_separation():
    """THE two-dashboard proof: credentials never cross the boundary."""
    fails = []

    # 1. portal session JWT -> every admin_* route must be 401
    for path in ("/admin_tenants", f"/admin_keys?tenant_id={fx.tid_a}",
                 f"/admin_usage?tenant_id={fx.tid_a}&days=7",
                 f"/admin_catalog?op=products&tenant_id={fx.tid_a}",
                 f"/admin_tenant_users?tenant_id={fx.tid_a}"):
        st, parsed, _, _ = portal(fx.fns, fx.tok_a, "GET", path)
        if st != 401:
            fails.append(f"session->admin {path}={st}")

    # 2. ADMIN_TOKEN -> every tenant_* route must be 401
    for path in ("/tenant_account", "/tenant_keys", "/tenant_usage?days=7",
                 "/tenant_catalog?op=products"):
        st, parsed, _, _ = portal(fx.fns, fx.adm, "GET", path)
        if st != 401:
            fails.append(f"admin-token->tenant {path}={st}")

    # 3. sk_ API key -> tenant_* must be 401
    st, _, _, _ = portal(fx.fns, fx.key, "GET", "/tenant_account")
    if st != 401:
        fails.append(f"sk->tenant={st}")

    # 4. portal session -> public API must be 401 (it is not an sk_ key)
    st, _, _, _ = api(fx.fns, fx.tok_a, "GET", "/occasions")
    if st != 401:
        fails.append(f"session->public_api={st}")

    record("P08 sudo separation (session->admin, admin->portal, keys->portal)",
           not fails, f"{11 - len(fails)}/11 rejected with 401" if not fails
           else "; ".join(fails))


def p09_revoke_reinstate():
    st, _, _, _ = admin(fx.fns, fx.adm, "PATCH", "/admin_tenant_users",
                        body={"tenant_id": fx.tid_b, "user_id": fx.user_b,
                              "action": "revoke"})
    st2, p2, _, _ = portal(fx.fns, fx.tok_b, "GET", "/tenant_account")
    st3, _, _, _ = admin(fx.fns, fx.adm, "PATCH", "/admin_tenant_users",
                         body={"tenant_id": fx.tid_b, "user_id": fx.user_b,
                               "action": "reinstate"})
    st4, _, _, _ = portal(fx.fns, fx.tok_b, "GET", "/tenant_account")
    # revoke must name the RIGHT tenant: A cannot revoke B's user
    st5, p5, _, _ = admin(fx.fns, fx.adm, "PATCH", "/admin_tenant_users",
                          body={"tenant_id": fx.tid_a, "user_id": fx.user_b,
                                "action": "revoke"})
    ok = (st == 200 and st2 == 403 and err_code(p2) == "forbidden"
          and st3 == 200 and st4 == 200 and st5 == 400)
    record("P09 revoke cuts access, reinstate restores, wrong-tenant 400", ok,
           f"revoke={st} blocked={st2} reinstate={st3} restored={st4} cross={st5}")


def p10_delete_login():
    st, parsed, _, _ = invite(fx.fns, fx.adm, fx.tid_b, EMAIL_C, "password")
    if st != 201 or not parsed.get("temporary_password"):
        record("P10 delete removes the login entirely", False, f"invite={st}")
        return
    uid = parsed["user_id"]
    st2, tok, _ = sign_in(fx.base, fx.anon, EMAIL_C, parsed["temporary_password"])
    if not tok:
        record("P10 delete removes the login entirely", False, f"sign-in={st2}")
        return
    st3, _, _, _ = portal(fx.fns, tok, "GET", "/tenant_account")
    st4, _, _, _ = admin(fx.fns, fx.adm, "PATCH", "/admin_tenant_users",
                         body={"tenant_id": fx.tid_b, "user_id": uid,
                               "action": "delete"})
    st5, p5, _, _ = portal(fx.fns, tok, "GET", "/tenant_account")
    ok = st3 == 200 and st4 == 200 and st5 in (401, 403)
    record("P10 delete removes the login entirely", ok,
           f"before={st3} delete={st4} after={st5} code={err_code(p5)}")


def p11_no_membership_is_403():
    st, parsed = create_auth_user(fx.base, fx.svc, EMAIL_D, PASSWORD_D)
    if st not in (200, 201):
        record("P11 auth user WITHOUT membership -> 403", False, f"create={st}")
        return
    uid = (parsed or {}).get("user", {}).get("id")
    if uid:
        fx.created_users.append(uid)
    st2, tok, msg = sign_in(fx.base, fx.anon, EMAIL_D, PASSWORD_D)
    if not tok:
        record("P11 auth user WITHOUT membership -> 403", False, f"sign-in={st2} {msg}")
        return
    st3, p3, _, _ = portal(fx.fns, tok, "GET", "/tenant_account")
    ok = st3 == 403 and err_code(p3) == "forbidden"
    record("P11 auth user WITHOUT membership -> 403", ok,
           f"http={st3} code={err_code(p3)}")


def p12_cors_disjoint():
    st, _, _, h1 = portal(fx.fns, fx.tok_a, "OPTIONS", "/tenant_account",
                          headers={"Origin": PORTAL_ORIGIN,
                                   "Access-Control-Request-Method": "GET"})
    portal_ok = h1.get("Access-Control-Allow-Origin") == PORTAL_ORIGIN
    st2, _, _, h2 = portal(fx.fns, fx.tok_a, "OPTIONS", "/tenant_account",
                           headers={"Origin": ADMIN_ORIGIN,
                                    "Access-Control-Request-Method": "GET"})
    admin_origin_off_portal = h2.get("Access-Control-Allow-Origin") is None
    st3, _, _, h3 = portal(fx.fns, fx.tok_a, "OPTIONS", "/tenant_account",
                           headers={"Origin": EVIL_ORIGIN,
                                    "Access-Control-Request-Method": "GET"})
    evil_off_portal = h3.get("Access-Control-Allow-Origin") is None
    st4, _, _, h4 = admin(fx.fns, fx.adm, "OPTIONS", "/admin_tenants",
                          headers={"Origin": ADMIN_ORIGIN,
                                   "Access-Control-Request-Method": "GET"})
    admin_ok = h4.get("Access-Control-Allow-Origin") == ADMIN_ORIGIN
    st5, _, _, h5 = admin(fx.fns, fx.adm, "OPTIONS", "/admin_tenants",
                          headers={"Origin": PORTAL_ORIGIN,
                                   "Access-Control-Request-Method": "GET"})
    portal_origin_off_admin = h5.get("Access-Control-Allow-Origin") is None
    ok = (st == 204 and portal_ok and st2 == 204 and admin_origin_off_portal
          and st3 == 204 and evil_off_portal and st4 == 204 and admin_ok
          and st5 == 204 and portal_origin_off_admin)
    record("P12 CORS allowlists disjoint (3001<->portal, 3000<->admin)", ok,
           f"portal->portal={h1.get('Access-Control-Allow-Origin')} "
           f"admin@portal={h2.get('Access-Control-Allow-Origin')} "
           f"admin->admin={h4.get('Access-Control-Allow-Origin')} "
           f"portal@admin={h5.get('Access-Control-Allow-Origin')}")


def p13_suspended_tenant_blocked():
    admin(fx.fns, fx.adm, "PATCH", "/admin_tenants",
          body={"id": fx.tid_a, "status": "suspended"})
    st, p, _, _ = portal(fx.fns, fx.tok_a, "GET", "/tenant_account")
    admin(fx.fns, fx.adm, "PATCH", "/admin_tenants",
          body={"id": fx.tid_a, "status": "active"})
    st2, _, _, _ = portal(fx.fns, fx.tok_a, "GET", "/tenant_account")
    ok = st == 403 and err_code(p) == "forbidden" and st2 == 200
    record("P13 suspended tenant blocked from portal (403)", ok,
           f"suspended={st} code={err_code(p)} restored={st2}")


def p14_portal_not_metered():
    before_st, before, _, _ = admin(fx.fns, fx.adm, "GET",
                                    f"/admin_usage?tenant_id={fx.tid_a}&days=7")
    if before_st != 200:
        record("P14 portal traffic never metered", False, f"usage before={before_st}")
        return
    for path in ("/tenant_account", "/tenant_keys", "/tenant_usage?days=7",
                 "/tenant_catalog?op=products", "/tenant_account"):
        portal(fx.fns, fx.tok_a, "GET", path)
    after_st, after, _, _ = admin(fx.fns, fx.adm, "GET",
                                  f"/admin_usage?tenant_id={fx.tid_a}&days=7")
    ok = (after_st == 200
          and after["totals"] == before["totals"]
          and after["totals"]["calls"] >= 3)  # the metered API calls still exist
    record("P14 portal traffic never metered", ok,
           f"before={before['totals']} after={after['totals']}")


def main() -> int:
    load_dotenv_if_present()
    fx.adm = os.environ.get("ADMIN_TOKEN") or ""
    if not fx.adm:
        env_path = os.path.join(PROJECT_DIR, "supabase", "functions", ".env")
        try:
            with open(env_path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line.startswith("ADMIN_TOKEN="):
                        fx.adm = line.split("=", 1)[1].strip().strip('"').strip("'")
        except OSError:
            pass
    if not fx.adm:
        print("REFUSED: ADMIN_TOKEN not found (env or supabase/functions/.env)",
              file=sys.stderr)
        return 2

    anon = os.environ.get("PILOT_SUPABASE_ANON_KEY")
    if not anon:
        print("REFUSED: PILOT_SUPABASE_ANON_KEY missing "
              "(copy .env.example to .env — the password grant needs the anon key)",
              file=sys.stderr)
        return 2

    stub_procs = []
    harness_proc = None
    try:
        base, svc, _fns_default = require_config()
        check_target_allowed(base)
    except Refused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 2
    fx.base, fx.svc, fx.anon = base, svc, anon
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
            print(f"REFUSED: functions not served (health {st})", file=sys.stderr)
            stop_resources()
            return 2

        print(f"target: {base}   functions: {fx.fns}", flush=True)

        # -- fixtures: clean leftovers from a crashed earlier run ----------
        drop_slug(base, svc, SLUG_A)
        drop_slug(base, svc, SLUG_B)
        for u in list_test_portal_users(base, svc):
            delete_auth_user(base, svc, u.get("id", ""))

        # -- sign B in early so P06 can assert B sees nothing ---------------
        try:
            for name, fn in [
                ("P01", p01_auth_gates),
                ("P02", p02_login_and_account),
                ("P03", p03_invite_mode_probe),
                ("P04", p04_keys_lifecycle),
                ("P05", p05_usage_and_forged_tenant),
                ("P06", p06_catalog_scoping),
                ("P07", p07_session_b_gets_own_account),
                ("P08", p08_sudo_separation),
                ("P09", p09_revoke_reinstate),
                ("P10", p10_delete_login),
                ("P11", p11_no_membership_is_403),
                ("P12", p12_cors_disjoint),
                ("P13", p13_suspended_tenant_blocked),
                ("P14", p14_portal_not_metered),
            ]:
                needs_a = fn not in (p01_auth_gates, p02_login_and_account)
                if needs_a and not fx.tid_a:
                    record(name, False, "skipped (no tenant A)")
                    continue
                if fn in (p06_catalog_scoping, p08_sudo_separation,
                          p09_revoke_reinstate, p10_delete_login) and not fx.tok_b:
                    # P06/P08/P09 need B's session: provision it on demand
                    if fx.tid_b and fx.user_b == "":
                        st_i, p_i, _, _ = invite(fx.fns, fx.adm, fx.tid_b, EMAIL_B, "password")
                        if st_i == 201 and p_i.get("temporary_password"):
                            fx.user_b = p_i["user_id"]
                            fx.created_users.append(fx.user_b)
                            st_s, tok_s, _ = sign_in(fx.base, fx.anon, EMAIL_B,
                                                     p_i["temporary_password"])
                            fx.tok_b = tok_s or ""
                if fn in (p06_catalog_scoping, p08_sudo_separation,
                          p09_revoke_reinstate, p10_delete_login) and not fx.tok_b:
                    record(name, False, "skipped (no session B)")
                    continue
                if fn is p09_revoke_reinstate and not fx.user_b:
                    record(name, False, "skipped (no user B)")
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
            # -- teardown: auth users first, then tenants ------------------
            for uid in fx.created_users:
                try:
                    delete_auth_user(base, svc, uid)
                except Exception:
                    pass
            for u in list_test_portal_users(base, svc):
                try:
                    delete_auth_user(base, svc, u.get("id", ""))
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
