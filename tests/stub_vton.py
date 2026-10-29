"""Stub for the B2B image-generation engines (tests/stub_vton.py).

Serves THREE provider contracts on one loopback port (default 8843), so
api_tests.py can prove the whole functions/vton plumbing offline:

  POST /klein/cloudflare   Cloudflare klein-4b response shape
                           {"success": true, "result": {"image": <base64 PNG>}}
                           (validates the multipart arrived: prompt +
                           input_image_0 present, else a CF-shaped error)
  POST /klein/fal          fal.ai response shape
                           {"images": [{"url": "http://<host>/fal/image.png"}]}
                           (requires any "Key …" Authorization, like fal)
  GET  /fal/image.png      the 1x1 PNG that URL points at (std-lib only)
  POST /vton               pilot-vton-server gateway shape: raw image/png
                           bytes — requires Authorization: Bearer
                           <VTON_BEARER_TOKEN> (401 otherwise), so the test
                           proves the function forwards the deployment token
  GET  /__stub/stats       per-path hit counts (same contract as stub_llm)

Spawned automatically by tests/api_tests.py (ensure_stubs). Every answer is
canned: this stub proves plumbing, never image quality.

Run by hand:  python tests/stub_vton.py --port 8843
"""
from __future__ import annotations

import argparse
import base64
import json
import struct
import sys
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VTON_TOKEN = "local-stub-vton-token"  # local-only, shared with functions/.env

STATS: dict[str, int] = {}


def tiny_png() -> bytes:
    """A valid 1x1 red RGBA PNG, built with std-lib only (no Pillow here)."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
    idat = chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00\xff"))  # filter + red px
    return (b"\x89PNG\r\n\x1a\n" + ihdr + idat + chunk(b"IEND", b""))


PNG_BYTES = tiny_png()
PNG_B64 = base64.b64encode(PNG_BYTES).decode("ascii")


class Handler(BaseHTTPRequestHandler):
    server_version = "stub_vton/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep stdout readable
        print(f"[stub_vton] {self.address_string()} {fmt % args}", flush=True)

    # -------------------------------------------------------------- helpers
    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"),
                   "application/json")

    def _count(self) -> None:
        STATS[self.path] = STATS.get(self.path, 0) + 1

    # ----------------------------------------------------------------- GET
    def do_GET(self):  # noqa: N802 - http.server naming
        self._count()
        if self.path == "/__stub/stats":
            self._json(200, {"hits": STATS})
        elif self.path == "/fal/image.png":
            self._send(200, PNG_BYTES, "image/png")
        else:
            self._json(404, {"error": f"no stub route {self.path}"})

    # --------------------------------------------------------------- POST
    def do_POST(self):  # noqa: N802
        self._count()
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""

        if self.path == "/klein/cloudflare":
            # Cloudflare gets multipart; assert the two fields our client
            # promises are there (cheap byte check — no multipart parser in
            # py3.14 std-lib after cgi was removed).
            if b"prompt" not in body or b"input_image_0" not in body:
                self._json(400, {"success": False,
                                 "errors": [{"message": "missing prompt/input_image"}]})
                return
            self._json(200, {"success": True, "result": {"image": PNG_B64}})

        elif self.path == "/klein/fal":
            auth = self.headers.get("Authorization", "")
            if not auth.startswith("Key "):
                self._json(401, {"detail": "missing fal key"})
                return
            host = self.headers.get("Host", "127.0.0.1:8843")
            self._json(200, {"images": [{"url": f"http://{host}/fal/image.png"}]})

        elif self.path == "/vton":
            expected = f"Bearer {VTON_TOKEN}"
            if self.headers.get("Authorization", "") != expected:
                self._json(401, {"detail": "Unauthorized: missing or invalid bearer token"})
                return
            # The gateway contract: URLs and/or base64 in, PNG bytes out.
            try:
                payload = json.loads(body or b"{}")
            except json.JSONDecodeError:
                self._json(400, {"detail": "invalid JSON"})
                return
            has_person = bool(payload.get("person_image_url") or payload.get("person_image_base64"))
            has_garment = bool(payload.get("garment_image_url") or payload.get("garment_image_base64"))
            if not (has_person and has_garment):
                self._json(400, {"detail": "Missing person/garment image"})
                return
            if payload.get("category") not in ("tops", "bottoms", "one-pieces"):
                self._json(400, {"detail": "bad category"})
                return
            self._send(200, PNG_BYTES, "image/png")

        elif self.path == "/__stub/config":
            self._json(200, {"ok": True})  # same contract as stub_llm

        else:
            self._json(404, {"error": f"no stub route {self.path}"})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8843)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[stub_vton] listening on http://127.0.0.1:{args.port} (loopback only)",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
