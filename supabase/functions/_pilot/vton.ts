// _pilot/vton.ts — client for the FASHN VTON gateway on Modal
// (Cloth-Savvy-Pilot/pilot-vton-server — the B2B volume, separate from the
// consumer app's fashn-vton-service so GPU billing never mixes).
//
// Contract of pilot-vton-server's gateway (adapted from the proven
// Cloth-Savvy-VTON-server/app.py, extended with base64 fields so the `look`
// op can hand over a mannequin rendered in-memory — no storage bucket needed):
//
//   POST {VTON_URL}
//   Authorization: Bearer {VTON_BEARER_TOKEN}
//   X-Tenant-Id: <uuid>            (server-side cost attribution log only)
//   {person_image_url | person_image_base64,
//    garment_image_url | garment_image_base64,
//    category?: tops|bottoms|one-pieces (default tops),
//    num_timesteps?: 1..100 (default 30)}
//   → 200 image/png bytes | 400/401/500 JSON {detail}
//
// Timing reality (measured on the consumer server): a COLD L4 container pays
// the model load (weights baked in, ~10–30 s restore from snapshot or
// ~40–110 s full load) PLUS inference (20 timesteps ≈ 8–25 s) — and Modal's
// scheduler may queue for L4 capacity first. BUT this client runs inside a
// Supabase Edge Function, which the platform KILLS at 150 s wall-clock on the
// Free plan (400 s on paid). VTON_TIMEOUT_MS below is therefore set just under
// that limit so a slow GPU surfaces as our own clean 502 + Retry-After instead
// of the platform's opaque `546 WORKER_RESOURCE_LIMIT` (hit live 2026-10-29).
// Callers of THIS api should use ~140 s client timeouts. The bearer
// check happens on the cheap CPU gateway first, so a bad token never boots
// a GPU (that server's whole design).
//
// Failure policy: upstream problems surface as upstream_image (502) with only
// the HTTP status — upstream bodies go to server logs, never to callers
// (errors.ts stability contract).

import { PilotError } from "./errors.ts";
import { logWarn } from "./logger.ts";
import { bytesToBase64 } from "./klein.ts";
import type { PilotEnv } from "./types.ts";

/** Gateway budget — deliberately under Supabase's 150 s Free-plan wall clock
 * so OUR error envelope wins the race against the platform kill (see header). */
export const VTON_TIMEOUT_MS = 135_000;
export const VTON_CATEGORIES = ["tops", "bottoms", "one-pieces"] as const;
export type VtonCategory = (typeof VTON_CATEGORIES)[number];

export interface TryOnRequest {
  person_image_url?: string;
  person_image_base64?: string;
  garment_image_url?: string;
  garment_image_base64?: string;
  category: VtonCategory;
  num_timesteps: number;
  tenantId?: string; // rides the X-Tenant-Id header for Modal-side cost logs
}

export interface TryOnResult {
  base64: string; // raw base64 of the rendered PNG
  mime: "image/png";
  provider: "modal-fashn";
}

function fail(message: string): PilotError {
  return new PilotError("upstream_image", message, { "Retry-After": "30" });
}

function baseUrl(env: PilotEnv): string {
  if (!env.VTON_URL) throw fail("vton engine is not configured (VTON_URL missing)");
  if (!env.VTON_BEARER_TOKEN) throw fail("vton engine is not configured (VTON_BEARER_TOKEN missing)");
  return env.VTON_URL.replace(/\/+$/, "");
}

/** Run the FASHN pipeline on Modal. Returns raw PNG base64. */
export async function tryOn(
  env: PilotEnv,
  req: TryOnRequest,
  timeoutMs = VTON_TIMEOUT_MS,
): Promise<TryOnResult> {
  const url = baseUrl(env);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.VTON_BEARER_TOKEN}`,
        ...(req.tenantId ? { "X-Tenant-Id": req.tenantId } : {}),
      },
      body: JSON.stringify({
        ...(req.person_image_url ? { person_image_url: req.person_image_url } : {}),
        ...(req.person_image_base64 ? { person_image_base64: req.person_image_base64 } : {}),
        ...(req.garment_image_url ? { garment_image_url: req.garment_image_url } : {}),
        ...(req.garment_image_base64 ? { garment_image_base64: req.garment_image_base64 } : {}),
        category: req.category,
        num_timesteps: req.num_timesteps,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    logWarn("vton: gateway unreachable", {
      reason: timedOut ? "timeout" : (err instanceof Error ? err.name : "unknown"),
      url,
    });
    throw fail(
      timedOut
        ? `vton engine did not answer within ${Math.round(timeoutMs / 1000)} s (L4 capacity + cold start + inference)`
        : "vton engine is unreachable",
    );
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    logWarn("vton: gateway rejected request", {
      status: String(resp.status),
      body: body.slice(0, 500),
    });
    if (resp.status === 401) throw fail("vton engine refused the deployment token (HTTP 401)");
    if (resp.status === 400) throw fail("vton engine rejected the images (HTTP 400)");
    throw fail(`vton engine failed (HTTP ${resp.status})`);
  }

  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.byteLength === 0) throw fail("vton engine returned an empty image");
  const base64 = bytesToBase64(bytes);
  return { base64, mime: "image/png", provider: "modal-fashn" };
}
