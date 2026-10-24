#!/usr/bin/env python3
"""Stub LLM (OpenAI/Groq-compatible) — LOCAL TESTS ONLY. Never deploy this.

Implements POST /openai/v1/chat/completions (the path the function calls when
PILOT_LLM_BASE_URL points here) and answers with whatever combo payload the
test configured. Standard library only.

PRODUCTION SAFETY (hard rule 3):
  * Lives under tests/, never bundled with any deployed function.
  * Binds 127.0.0.1 only.
  * The function-side switch PILOT_LLM_BASE_URL is ENFORCED to loopback
    hosts in _pilot/llm.ts — even a mistakenly-set production secret with
    that name cannot point Groq traffic anywhere but localhost (where the
    real Groq API obviously is not), so it is inert in production.

Modes (POST /__stub/config {"mode": ..., "combos": {...}}):
  valid                 -> returns the configured JSON payload
  invalid_json_once     -> FIRST call returns garbage, later calls valid
                           (proves the function's one retry works)
  invalid_json_always   -> always garbage (proves fallback to recipe engine)
  http_500              -> HTTP 500 every call
  slow                  -> sleeps `delay_s` before answering
GET /__stub/stats returns call counters (retry assertions).
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_LOCK = threading.Lock()
_CFG = {"mode": "valid", "combos": {"combos": []}, "delay_s": 0.0, "mode_calls": 0}
_STATS = {"llm_calls": 0, "invalid_served": 0, "errors": 0}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        # Timestamped request/parse log (stdout): shows EXACTLY what arrived,
        # including parse-level errors that never reach do_POST.
        print(f"[stub_llm] {self.address_string()} "
              f"{fmt % args} t={time.strftime('%H:%M:%S')}", flush=True)

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict | None:
        try:
            raw = getattr(self, "_body", None)
            if raw is None:  # not pre-drained (e.g. GET) — read now
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
            parsed = json.loads(raw.decode("utf-8"))
            return parsed if isinstance(parsed, dict) else None
        except Exception:
            return None

    def do_GET(self) -> None:
        if self.path == "/__stub/stats":
            with _LOCK:
                self._send(200, dict(_STATS))
        else:
            self._send(404, {"error": {"detail": "not found"}})

    def do_POST(self) -> None:
        # ALWAYS drain the request body first — even for branches that never
        # use it (401/500/config). Otherwise the unread bytes stay in the
        # keep-alive socket and the NEXT request on that connection parses
        # as '{...body...}POST /path' → 400 for the client's retry. (Seen in
        # production? No: real upstreams always read their bodies. This is a
        # test-double plumbing fix.)
        length = int(self.headers.get("Content-Length") or 0)
        self._body = self.rfile.read(length) if length else b""

        if self.path == "/__stub/config":
            payload = self._read_json()
            if payload is None:
                self._send(400, {"error": {"detail": "body must be an object"}})
                return
            with _LOCK:
                if "mode" in payload:
                    _CFG["mode"] = str(payload["mode"])
                    _CFG["mode_calls"] = 0  # fresh per-mode counter so
                    # invalid_json_once means "once per configured window"
                if "combos" in payload:
                    _CFG["combos"] = payload["combos"]
                if "delay_s" in payload:
                    _CFG["delay_s"] = float(payload["delay_s"])
            self._send(200, {"ok": True})
            return

        if self.path in ("/openai/v1/chat/completions", "/v1/chat/completions"):
            with _LOCK:
                _STATS["llm_calls"] += 1
                _CFG["mode_calls"] += 1
                call_no = _CFG["mode_calls"]  # per-mode window counter
                mode = _CFG["mode"]
                combos = _CFG["combos"]
                delay = _CFG["delay_s"]
                total = _STATS["llm_calls"]
            # Arrival log: ground truth for retry/reachability diagnosis.
            print(f"[stub_llm] ARRIVAL #{total} path={self.path} "
                  f"mode={mode} mode_call={call_no} "
                  f"t={time.strftime('%H:%M:%S')}", flush=True)

            if delay > 0:
                time.sleep(delay)

            if mode == "http_500":
                with _LOCK:
                    _STATS["errors"] += 1
                self._send(500, {"error": {"message": "injected failure"}})
                return

            if mode == "slow":
                time.sleep(delay or 30.0)

            if mode == "invalid_json_always" or (
                mode == "invalid_json_once" and call_no == 1
            ):
                with _LOCK:
                    _STATS["invalid_served"] += 1
                content = "sure, here you go: {not valid json"
            else:
                content = json.dumps(combos)

            self._send(200, {
                "id": f"stub-{call_no}",
                "object": "chat.completion",
                "model": "stub-model",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            })
            return

        print(f"[stub_llm] UNKNOWN POST path={self.path} "
              f"t={time.strftime('%H:%M:%S')}", flush=True)
        self._send(404, {"error": {"detail": "not found"}})


def main() -> int:
    parser = argparse.ArgumentParser(description="stub LLM (local tests only)")
    parser.add_argument("--port", type=int, default=8842)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"[stub_llm] listening on http://127.0.0.1:{args.port} (loopback only)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
