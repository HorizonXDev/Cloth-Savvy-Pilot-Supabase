#!/usr/bin/env python3
"""Cleanup for the Cloth Savvy Pilot test suite.

Removes ONLY tenants whose slug starts with "test_" (the prefix the test
suite always uses), and the local plaintext test-key file. It suspends each
test tenant first (drop_tenant requires a suspended tenant + exact confirm
slug), then drops it through the same RPC the tests use.

Never touches any other tenant. Never prints key material.

Same safety rules as isolation_tests.py: reads PILOT_SUPABASE_URL,
PILOT_SUPABASE_SERVICE_KEY, PILOT_SUPABASE_ANON_KEY from the environment or
a .env (beside this script or in the project root) and refuses to run if any
is missing; the URL must be localhost unless PILOT_ALLOW_REMOTE=1 together
with PILOT_PROJECT_REF appearing in the URL.

Exit codes: 0 = clean, 1 = something failed to clean up, 2 = refused to run.
"""

from __future__ import annotations

import json
import os
import sys
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

TIMEOUT_S = 60
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
KEY_FILE = os.path.join(SCRIPT_DIR, ".test_keys")
TEST_PREFIX = "test_"


class Refused(RuntimeError):
    pass


def load_dotenv_if_present() -> None:
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
            pass


def require_config() -> tuple[str, str]:
    missing = [k for k in ("PILOT_SUPABASE_URL", "PILOT_SUPABASE_SERVICE_KEY")
               if not os.environ.get(k)]
    if missing:
        raise Refused(
            "refusing to run: missing environment variable(s): "
            + ", ".join(missing)
            + "  (copy .env.example to .env and fill it in, or export them)"
        )
    base = os.environ["PILOT_SUPABASE_URL"].rstrip("/")
    parsed = urlparse.urlparse(base)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise Refused(f"refusing to run: PILOT_SUPABASE_URL is not a URL: {base!r}")
    return base, os.environ["PILOT_SUPABASE_SERVICE_KEY"]


def check_target_allowed(base: str) -> None:
    host = (urlparse.urlparse(base).hostname or "").lower()
    if host in ("127.0.0.1", "localhost", "::1"):
        return
    if os.environ.get("PILOT_ALLOW_REMOTE") != "1":
        raise Refused(
            f"refusing to run: target host {host!r} is not localhost. "
            "Set PILOT_ALLOW_REMOTE=1 (and PILOT_PROJECT_REF) for a hosted project."
        )
    ref = (os.environ.get("PILOT_PROJECT_REF") or "").strip()
    if not ref or ref not in base:
        raise Refused(
            "refusing to run: PILOT_ALLOW_REMOTE=1 requires PILOT_PROJECT_REF "
            "to be set and to appear in PILOT_SUPABASE_URL"
        )


def http_json(base: str, key: str, method: str, path: str, body=None):
    url = base + path
    data = None
    hdrs = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urlrequest.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urlrequest.urlopen(req, timeout=TIMEOUT_S) as resp:
            text = resp.read().decode("utf-8", "replace")
            status = resp.status
    except urlerror.HTTPError as exc:
        status = exc.code
        text = exc.read().decode("utf-8", "replace")
    except urlerror.URLError as exc:
        raise RuntimeError(f"network failure for {method} {path}: {exc.reason}")
    try:
        return status, json.loads(text) if text else None, text
    except json.JSONDecodeError:
        return status, None, text


def err_excerpt(text: str, n: int = 160) -> str:
    try:
        obj = json.loads(text)
        msg = obj.get("message") or obj.get("hint") or text
    except json.JSONDecodeError:
        msg = text
    return " ".join(str(msg).split())[:n]


def main() -> int:
    load_dotenv_if_present()
    try:
        base, svc = require_config()
        check_target_allowed(base)
    except Refused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 2

    # List all tenants, then filter client-side on the test_ prefix (avoids
    # LIKE-encoding traps and is exact).
    status, parsed, text = http_json(base, svc, "GET", "/rest/v1/tenants?select=id,slug")
    if status != 200:
        print(f"FAILED: GET /rest/v1/tenants -> {status}: {err_excerpt(text)}",
              file=sys.stderr)
        return 1
    targets = [r for r in (parsed or []) if str(r.get("slug", "")).startswith(TEST_PREFIX)]

    if not targets:
        print("nothing to clean: no test_ tenants found")
    else:
        print(f"found {len(targets)} test_ tenant(s): "
              + ", ".join(sorted(r["slug"] for r in targets)))

    failures = 0
    for t in sorted(targets, key=lambda r: r["slug"]):
        tid, slug = t["id"], t["slug"]
        # drop_tenant requires status='suspended'
        status, _p, text = http_json(
            base, svc, "PATCH", f"/rest/v1/tenants?id=eq.{tid}",
            body={"status": "suspended"})
        if status >= 300:
            print(f"  FAIL {slug}: cannot suspend ({status}) {err_excerpt(text)}")
            failures += 1
            continue
        status, _p, text = http_json(
            base, svc, "POST", "/rest/v1/rpc/drop_tenant",
            body={"p_tenant_id": tid, "p_confirm_slug": slug})
        if status >= 300:
            print(f"  FAIL {slug}: drop_tenant -> {status} {err_excerpt(text)}")
            failures += 1
            continue
        # verify it is gone
        status, rows, text = http_json(
            base, svc, "GET", f"/rest/v1/tenants?id=eq.{tid}&select=id")
        if status == 200 and rows:
            print(f"  FAIL {slug}: still present after drop_tenant")
            failures += 1
            continue
        print(f"  dropped {slug}")

    # Leftover test product/event rows would mean an orphaned partition.
    status, rows, text = http_json(
        base, svc, "GET", "/rest/v1/products?select=id,tenant_id&limit=1000")
    if status == 200 and rows:
        left = len(rows)
        print(f"  note: {left} product row(s) still in products "
              "(belongs to non-test tenants, or an orphan — check tenants list)")
    elif status != 200:
        print(f"  WARN: cannot verify products rows: {status} {err_excerpt(text)}")

    # Remove the local plaintext test-key file (never print its contents).
    if os.path.isfile(KEY_FILE):
        try:
            os.remove(KEY_FILE)
            print(f"  removed {os.path.relpath(KEY_FILE, os.path.dirname(SCRIPT_DIR))} "
                  "(local test-key file)")
        except OSError as exc:
            print(f"  WARN: could not remove key file: {exc}")
            failures += 1

    if failures:
        print(f"RESULT: FAIL ({failures} problem(s))")
        return 1
    print("RESULT: clean — only test_ tenants and the local key file removed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
