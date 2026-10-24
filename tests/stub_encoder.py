#!/usr/bin/env python3
"""Stub FashionCLIP encoder — LOCAL TESTS ONLY. Never deploy this.

Mimics the real Modal encoder's contract (Cloth-Savvy-CLIP-server):
    GET  /health        -> {"model","revision","ready",...}   (no auth)
    POST /embed_texts   -> {"model","revision","dim":512,
                            "embeddings":[[...512 floats...]],"server_ms"}
    Bearer auth required when STUB_ENCODER_TOKEN is set (mirrors the real
    service failing closed on a missing/bad token -> 401).

Deterministic embeddings: embed_text() is a pure function of the text, so
tests import it directly to seed products with EXACTLY the vector a query
will embed to (exact-match similarity = 1.0). Unrelated texts land near 0
cosine similarity (hash-derived unit vector), which drives the honest
no_match tests.

Fault injection for tests (via POST /__stub/config):
    {"model": "wrong-model"}     -> model-string mismatch -> API 503
    {"fail_status": 500}         -> every embed call fails -> API 503 after retry
    {"delay_s": 12}              -> slow (timeout path)
    {"revision": "..."}          -> override reported revision
GET /__stub/stats returns call counters (used to assert ONE retry happened).

PRODUCTION SAFETY (hard rule 3): this server binds 127.0.0.1 only, lives
under tests/, and is never bundled with any deployed function. The functions
have no "stub mode" switch at all — they simply call whatever ENCODER_URL
points at; the owner sets ENCODER_URL to the real Modal URL in production
secrets, where no such loopback service exists.

Standard library only. Run: python tests/stub_encoder.py --port 8841
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "fashion-clip"
REVISION = "7e3ba62ce16b379a1ab479346b66f192e76f51b7"
DIM = 512
MAX_TEXTS = 8
MAX_CHARS = 300

_LOCK = threading.Lock()
_CFG = {"model": MODEL, "revision": REVISION, "delay_s": 0.0, "fail_status": 0}
_STATS = {"embed_requests": 0, "embed_attempts": 0, "health_requests": 0, "config_sets": 0}


def embed_text(text: str, dim: int = DIM) -> list[float]:
    """Deterministic L2-normalised vector for `text`. Same input -> same
    output on every run and machine (sha256 counter mode -> floats)."""
    values: list[float] = []
    counter = 0
    while len(values) < dim:
        block = hashlib.sha256(f"{text}\x00{counter}".encode("utf-8")).digest()
        for i in range(0, len(block), 2):
            if len(values) >= dim:
                break
            n = int.from_bytes(block[i : i + 2], "big")
            values.append(n / 65535.0 * 2.0 - 1.0)
        counter += 1
    norm = math.sqrt(sum(v * v for v in values)) or 1.0
    return [v / norm for v in values]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        # Timestamped request/parse log (stdout): shows EXACTLY what arrived,
        # including parse-level errors that never reach do_POST.
        print(f"[stub_encoder] {self.address_string()} "
              f"{fmt % args} t={time.strftime('%H:%M:%S')}", flush=True)

    # ------------------------------------------------------------------ utils
    def _send(self, status: int, payload: dict | list | None) -> None:
        body = json.dumps(payload).encode("utf-8") if payload is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
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

    # ------------------------------------------------------------------ GET
    def do_GET(self) -> None:
        if self.path == "/health":
            with _LOCK:
                _STATS["health_requests"] += 1
                cfg = dict(_CFG)
            self._send(200, {
                "model": cfg["model"], "revision": cfg["revision"],
                "ready": True, "stub": True,
            })
        elif self.path == "/__stub/stats":
            with _LOCK:
                self._send(200, dict(_STATS))
        else:
            self._send(404, {"detail": "not found"})

    # ------------------------------------------------------------------ POST
    def do_POST(self) -> None:
        # ALWAYS drain the request body first — even for branches that never
        # use it (401/500/config). Otherwise the unread bytes stay in the
        # keep-alive socket and the NEXT request on that connection parses
        # as '{...body...}POST /path' → 400 for the client's retry. (Real
        # upstreams always read their bodies; this is a test-double fix.)
        length = int(self.headers.get("Content-Length") or 0)
        self._body = self.rfile.read(length) if length else b""

        if self.path == "/__stub/config":
            payload = self._read_json()
            if payload is None:
                self._send(400, {"detail": "body must be a JSON object"})
                return
            with _LOCK:
                for key in ("model", "revision"):
                    if key in payload:
                        _CFG[key] = str(payload[key])
                if "delay_s" in payload:
                    _CFG["delay_s"] = float(payload["delay_s"])
                if "fail_status" in payload:
                    _CFG["fail_status"] = int(payload["fail_status"])
                _STATS["config_sets"] += 1
            self._send(200, {"ok": True})
            return

        if self.path == "/embed_texts":
            with _LOCK:
                _STATS["embed_requests"] += 1
                _STATS["embed_attempts"] += 1
                n = _STATS["embed_attempts"]
                cfg = dict(_CFG)
            print(f"[stub_encoder] ARRIVAL #{n} t={time.strftime('%H:%M:%S')} "
                  f"fail={cfg['fail_status']} delay={cfg['delay_s']}", flush=True)

            token = os.environ.get("STUB_ENCODER_TOKEN")
            if token:
                got = (self.headers.get("Authorization") or "")
                if got != f"Bearer {token}":
                    self._send(401, {"detail": "missing or bad bearer token"})
                    return

            if cfg["delay_s"] > 0:
                time.sleep(cfg["delay_s"])

            if cfg["fail_status"]:
                self._send(int(cfg["fail_status"]), {"detail": "injected failure"})
                return

            payload = self._read_json()
            if payload is None or "texts" not in payload:
                self._send(400, {"detail": "missing 'texts'"})
                return
            texts = payload.get("texts")
            if not isinstance(texts, list) or not (1 <= len(texts) <= MAX_TEXTS):
                self._send(400, {"detail": f"'texts' must have 1..{MAX_TEXTS} items"})
                return
            bad = [t for t in texts if not isinstance(t, str) or not (1 <= len(t) <= MAX_CHARS)]
            if bad:
                self._send(400, {"detail": f"each text must be 1..{MAX_CHARS} chars"})
                return

            t0 = time.perf_counter()
            embeddings = [embed_text(t) for t in texts]
            server_ms = (time.perf_counter() - t0) * 1000.0
            self._send(200, {
                "model": cfg["model"], "revision": cfg["revision"], "dim": DIM,
                "embeddings": embeddings, "server_ms": round(server_ms, 3),
            })
            return

        print(f"[stub_encoder] UNKNOWN POST path={self.path} "
              f"t={time.strftime('%H:%M:%S')}", flush=True)
        self._send(404, {"detail": "not found"})


def main() -> int:
    parser = argparse.ArgumentParser(description="stub encoder (local tests only)")
    parser.add_argument("--port", type=int, default=8841)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"[stub_encoder] listening on http://127.0.0.1:{args.port} (loopback only)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
