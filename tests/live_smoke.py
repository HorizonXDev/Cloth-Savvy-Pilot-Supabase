#!/usr/bin/env python3
"""live_smoke.py — tiny end-to-end smoke test against a RUNNING pilot API.

This is the script YOU run (the agent never does) after `supabase functions
deploy` + `supabase secrets set`, or against your local stack. It exercises
exactly four calls and prints what a human needs to see:

    1. GET  /v1/health      -> dependency status (database, encoder)
    2. GET  /v1/occasions   -> how many combo recipes the tenant has
    3. POST /v1/search      -> one search: status + result count
    4. POST /v1/combos      -> one combo build: status, counts,
                               latency breakdown, missing_sections

Environment (all required except where noted):

    PILOT_LIVE_FUNCTIONS_URL   e.g. https://<ref>.supabase.co/functions/v1
                               (locally: http://127.0.0.1:54421/functions/v1)
    PILOT_LIVE_API_KEY         an sk_live_... or sk_test_... key (issue it
                               with tools/issue_key.py — never hardcode it)
    PILOT_LIVE_ORIGIN          optional, default http://localhost:3000.
                               Sent as the Origin header on every request so
                               you also verify the CORS allowlist.
    PILOT_LIVE_QUERY           optional search text (default: a simple kurta)
    PILOT_LIVE_OCCASION        optional occasion name; defaults to the first
                               occasion the tenant's recipes define

Standard library only. Prints a PASS/FAIL line per step and exits 1 if any
step fails. NEVER prints the key value.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

TIMEOUT_S = 90  # combos may call a real LLM; give it room


class SmokeError(RuntimeError):
    pass


def env(name: str, required: bool = True) -> str | None:
    val = os.environ.get(name, "").strip()
    if required and not val:
        print(f"FAIL  environment variable {name} is not set")
        sys.exit(2)
    return val or None


def call(method: str, url: str, key: str | None, origin: str | None,
         body: dict | None = None) -> tuple[int, dict | list | None, dict]:
    """One HTTP request. Returns (status, parsed_json_or_None, headers)."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    if origin:
        req.add_header("Origin", origin)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            status, raw, hdrs = resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        status, raw, hdrs = e.code, e.read(), dict(e.headers)
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    parsed: dict | list | None = None
    try:
        parsed = json.loads(raw.decode() or "null")
    except Exception:
        parsed = None
    hdrs = dict(hdrs)
    hdrs["_elapsed_ms"] = elapsed_ms
    return status, parsed, hdrs


def err_detail(body: dict | list | None) -> str:
    """The API's error envelope ({error:{code,message,request_id}}) as one line,
    so a FAIL shows WHY instead of only the status (added 2026-10-26: the 503
    on combos gave no clue until the body was readable)."""
    if not isinstance(body, dict):
        return ""
    err = body.get("error")
    if not isinstance(err, dict):
        return ""
    msg = f"  error={err.get('code')}: {err.get('message')}"
    if err.get("request_id"):
        msg += f" (request_id={err['request_id']})"
    return msg


def show(step: str, status: int, ok: bool, detail: str, hdrs: dict) -> bool:
    flag = "PASS" if ok else "FAIL"
    rid = ""
    if isinstance(hdrs, dict):
        rid = hdrs.get("X-Request-Id") or hdrs.get("x-request-id") or ""
    print(f"{flag}  {step:<28} http={status} {hdrs.get('_elapsed_ms', '?')}ms"
          + (f" req={rid[:8]}" if rid else "")
          + (f"  {detail}" if detail else ""))
    return ok


def main() -> int:
    base = env("PILOT_LIVE_FUNCTIONS_URL").rstrip("/")
    key = env("PILOT_LIVE_API_KEY")
    origin = os.environ.get("PILOT_LIVE_ORIGIN", "http://localhost:3000")
    query = os.environ.get(
        "PILOT_LIVE_QUERY", "a simple cotton kurta for daily wear")
    all_ok = True

    print(f"target : {base}")
    print(f"origin : {origin}   (key: {key[:8]}...{key[-4:]}, value hidden)")
    print("-" * 72)

    # 1. health (no auth by design)
    status, body, hdrs = call("GET", f"{base}/health", None, origin)
    deps = (body or {}).get("dependencies", {}) if isinstance(body, dict) else {}
    dep_txt = ", ".join(
        f"{k}={v.get('status')}" for k, v in deps.items()
        if isinstance(v, dict)) or "?"
    all_ok &= show("health", status, status == 200 and
                   isinstance(body, dict) and body.get("status") in
                   ("ok", "degraded"), f"status={body.get('status') if isinstance(body, dict) else '?'} [{dep_txt}]", hdrs)

    # 2. occasions
    status, body, hdrs = call("GET", f"{base}/occasions", key, origin)
    occs = body.get("occasions", []) if isinstance(body, dict) else []
    all_ok &= show("occasions", status, status == 200 and len(occs) > 0,
                   f"count={len(occs)}", hdrs)

    # 3. one search
    status, body, hdrs = call("POST", f"{base}/search", key, origin,
                              {"query": query, "limit": 5})
    items = body.get("items", []) if isinstance(body, dict) else []
    no_match = body.get("no_match") if isinstance(body, dict) else None
    all_ok &= show("search", status, status == 200,
                   f"items={len(items)} no_match={no_match}", hdrs)
    if status == 200 and items:
        top = items[0]
        print(f"      top: {top.get('product', {}).get('title')!r} "
              f"sim={top.get('similarity')}")    # 4. one combos build
    # GET /v1/occasions answers with OBJECTS ({occasion, sections:[...]}) —
    # send only the name: POST /v1/combos validates `occasion` as a string
    # and returns 400 for an object (caught 2026-10-26 on the hosted gate).
    first = occs[0] if occs else None
    occasion = os.environ.get("PILOT_LIVE_OCCASION") or (
        first.get("occasion") if isinstance(first, dict) else first
    )
    if occasion is None:
        print("FAIL  no occasion available (occasions step failed?)")
        return 1
    status, body, hdrs = call("POST", f"{base}/combos", key, origin,
                              {"occasion": occasion, "n_combos": 2})
    combos = body.get("combos", []) if isinstance(body, dict) else []
    meta = body.get("meta", {}) if isinstance(body, dict) else {}
    lat = meta.get("latency_ms", {}) if isinstance(meta, dict) else {}
    ok = status == 200 and body.get("status") in ("ok", "partial", "no_match")
    detail = (f"occasion={occasion!r} status={body.get('status') if isinstance(body, dict) else '?'} "
              f"combos={len(combos)} engine={meta.get('engine')}")
    detail += err_detail(body)
    all_ok &= show("combos", status, ok, detail, hdrs)

    if combos:
        print(f"      latency_ms: llm={lat.get('llm')} embed={lat.get('embed')} "
              f"search={lat.get('search')} total={lat.get('total')}")
        for c in combos:
            miss = c.get("missing_sections", [])
            print(f"      combo {c.get('id')}: {c.get('title')!r} "
                  f"items={len(c.get('items', []))} missing={miss}")
    server_timing = hdrs.get("Server-Timing") or hdrs.get("server-timing")
    if server_timing:
        print(f"      Server-Timing: {server_timing}")

    print("-" * 72)
    print(f"RESULT: {'PASS' if all_ok else 'FAIL'}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
