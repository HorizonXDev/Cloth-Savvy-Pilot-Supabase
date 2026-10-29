// _pilot/klein.ts — FLUX.2 [klein] 4B: render a tenant's combo garments onto
// a person ("combo to person" — the mannequin step of the B2B try-on chain).
//
// Provider order, copied from the consumer app's proven mannequin chain
// (Cloth-Savvy-Edge-Functions/generate-apparel-combo/index.ts):
//   1. Cloudflare Workers AI  POST /client/v4/accounts/<id>/ai/run/
//      @cf/black-forest-labs/flux-2-klein-4b   (multipart: prompt, width,
//      height, input_image_<i> as image BYTES fetched here, so CDN download
//      time lands on the edge clock, not inside the provider call)
//   2. fal.ai  POST https://fal.run/fal-ai/flux-2/klein/4b
//      {prompt, image_urls, image_size:"square_hd"} → images[0].url downloaded
//      — used when Cloudflare is unconfigured, hits its daily free allocation
//      (error 4006 / "daily free allocation"), or fails for any other reason.
//   Both configured → Cloudflare first (consumer behaviour). Only one
//   configured → that one. Neither → upstream_image 502 with a clear message.
//
// Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, FAL_KEY
// LOCAL TESTS ONLY: KLEIN_CLOUDFLARE_URL / KLEIN_FAL_URL replace the two
// endpoint URLs — but ONLY for loopback hosts (same guard as
// PILOT_LLM_BASE_URL: a non-loopback override is refused, so a set secret can
// never redirect production traffic to an attacker's server).
//
// Input-image contract: klein-4b's image inputs are expected at ≤512 px
// (documented in the consumer's fetchAndResizeForKlein). Deno ships no image
// library, so — exactly like the consumer — the tenant's image_url bytes are
// passed through as-is. Callers own serving images klein can accept.
//
// Response format: both providers hand back base64 or a URL to bytes; we
// return RAW base64 plus a sniffed mime (PNG vs JPEG magic), because neither
// provider documents its encoder and a wrong data-URI mime breaks <img>.

import { PilotError } from "./errors.ts";
import { logWarn } from "./logger.ts";
import type { PilotEnv } from "./types.ts";

export const KLEIN_FETCH_TIMEOUT_MS = 15_000; // per garment-image download
export const KLEIN_CF_TIMEOUT_MS = 60_000; // cloudflare generation
export const KLEIN_FAL_TIMEOUT_MS = 90_000; // fal generation + image download
export const KLEIN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const KLEIN_MAX_ITEMS = 4;

export interface RenderItem {
  image_url: string;
  description?: string;
  section?: string;
}

export interface RenderRequest {
  items: RenderItem[];
  gender: string;
  age: number;
  style_notes?: string;
}

export interface RenderResult {
  base64: string; // raw base64, NO data: prefix
  mime: "image/png" | "image/jpeg";
  provider: "cloudflare" | "fal";
}

function fail(message: string, extra?: Record<string, string>): PilotError {
  return new PilotError("upstream_image", message, {
    "Retry-After": "10",
    ...extra,
  });
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

/** Test-only URL override with the loopback guard; undefined → real provider. */
function overrideOr(env: PilotEnv, key: "KLEIN_CLOUDFLARE_URL" | "KLEIN_FAL_URL", real: string): string {
  const raw = env[key];
  if (!raw) return real;
  if (!isLoopbackUrl(raw)) {
    throw new PilotError("internal", `${key} must be a loopback URL`);
  }
  return raw.replace(/\/+$/, "");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000; // String.fromCharCode spread limit
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Sniff PNG/JPEG from base64-encoded bytes — neither provider documents
 * which encoder it uses, and the data URI must declare the right mime. */
export function sniffMime(base64: string): "image/png" | "image/jpeg" {
  if (base64.startsWith("iVBORw0KGgo")) return "image/png"; // \x89PNG
  if (base64.startsWith("/9j/")) return "image/jpeg"; // \xFF\xD8\xFF
  return "image/png"; // unknown → PNG (both browsers and callers sniff anyway)
}

// ---------------------------------------------------------------- prompt

// Section → the garment role phrasing in the prompt. Fallback wording is
// construction-agnostic (borrowed from the consumer's describeSlot): when a
// description is missing we tell the model to match the reference image's own
// silhouette instead of guessing a garment type.
const SECTION_ROLE: Record<string, string> = {
  top: "top",
  bottom: "bottom",
  dress: "one-piece garment",
  outerwear: "outer layer",
  saree: "saree",
  blouse: "blouse",
  dupatta: "dupatta",
  footwear: "footwear",
  bag: "bag",
  jewellery: "jewellery",
  accessory: "accessory",
};

function describeItem(item: RenderItem): string {
  const description = item.description?.trim();
  if (description) return description;
  const role = item.section ? (SECTION_ROLE[item.section] ?? item.section) : "garment";
  return (
    `the ${role} shown in this reference image — match its exact silhouette, ` +
    `sleeve length, and hem length as shown, rather than assuming a particular ` +
    `garment type`
  );
}

export function buildRenderPrompt(req: RenderRequest): string {
  const parts = req.items.map((item, i) => `image ${i} is ${describeItem(item)}.`);
  const list = req.items
    .map((item) =>
      item.description?.trim() ||
      (item.section ? `the ${SECTION_ROLE[item.section] ?? item.section}` : "the garment"))
    .join(", ");
  return (
    `${parts.join(" ")} ` +
    `Generate a full-body photo of a ${req.age}-year-old ${req.gender} standing in a ` +
    `neutral front-facing pose, wearing the ${list} together, layered correctly — ` +
    `each garment's silhouette, sleeve length, and hem length must match its own ` +
    `reference image exactly (do not default to a closed jacket, baggy trousers, or ` +
    `any other assumed shape). ` +
    (req.style_notes ? `${req.style_notes} ` : "") +
    `Studio lighting, plain neutral gray background, photorealistic, accurate fabric ` +
    `texture and color matching the reference images. Exactly one person. ` +
    `No text, no watermarks.`
  );
}

// ---------------------------------------------------------------- providers

async function fetchImageBytes(url: string): Promise<Uint8Array> {
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(KLEIN_FETCH_TIMEOUT_MS) });
  } catch {
    throw fail(`could not download garment image (timeout after ${KLEIN_FETCH_TIMEOUT_MS} ms)`);
  }
  if (!resp.ok) throw fail(`garment image returned HTTP ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.byteLength > KLEIN_MAX_IMAGE_BYTES) {
    throw fail(`garment image exceeds ${KLEIN_MAX_IMAGE_BYTES} bytes`);
  }
  if (bytes.byteLength === 0) throw fail("garment image is empty");
  return bytes;
}

/** Cloudflare-specific failure marker: its daily free allocation. */
class CloudflareQuotaError extends Error {}

async function renderViaCloudflare(
  env: PilotEnv,
  prompt: string,
  items: RenderItem[],
): Promise<string> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const base = overrideOr(
    env,
    "KLEIN_CLOUDFLARE_URL",
    accountId && apiToken
      ? `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
        `/ai/run/@cf/black-forest-labs/flux-2-klein-4b`
      : "",
  );
  if (!base) throw fail("cloudflare is not configured (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN missing)");

  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", "1024");
  form.append("height", "1024");
  for (let i = 0; i < items.length; i++) {
    const bytes = await fetchImageBytes(items[i].image_url);
    form.append("input_image_" + i, new Blob([bytes], { type: "image/jpeg" }), `item_${i}.jpg`);
  }

  let resp: Response;
  try {
    resp = await fetch(base, {
      method: "POST",
      headers: env.KLEIN_CLOUDFLARE_URL
        ? {} // local stub needs no auth
        : { Authorization: `Bearer ${apiToken!.trim()}` },
      body: form,
      signal: AbortSignal.timeout(KLEIN_CF_TIMEOUT_MS),
    });
  } catch {
    throw fail("cloudflare did not answer in time");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const quota = text.includes("4006") || text.includes("daily free allocation");
    if (quota) throw new CloudflareQuotaError("cloudflare daily free allocation exhausted");
    logWarn("klein: cloudflare failed", { status: String(resp.status), body: text.slice(0, 500) });
    throw fail(`cloudflare rejected the request (HTTP ${resp.status})`);
  }
  const json = (await resp.json().catch(() => null)) as
    | { success?: boolean; result?: { image?: string } }
    | null;
  if (!json?.success || !json.result?.image) {
    throw fail("cloudflare did not return an image");
  }
  return json.result.image;
}

async function renderViaFal(env: PilotEnv, prompt: string, items: RenderItem[]): Promise<string> {
  if (!env.FAL_KEY) throw fail("fal.ai is not configured (FAL_KEY missing)");
  const base = overrideOr(env, "KLEIN_FAL_URL", "https://fal.run/fal-ai/flux-2/klein/4b");

  let resp: Response;
  try {
    resp = await fetch(base, {
      method: "POST",
      headers: {
        Authorization: `Key ${env.FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        image_urls: items.map((i) => i.image_url),
        image_size: "square_hd",
      }),
      signal: AbortSignal.timeout(KLEIN_FAL_TIMEOUT_MS),
    });
  } catch {
    throw fail("fal.ai did not answer in time");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logWarn("klein: fal failed", { status: String(resp.status), body: text.slice(0, 500) });
    throw fail(`fal.ai rejected the request (HTTP ${resp.status})`);
  }
  const json = (await resp.json().catch(() => null)) as
    | { images?: Array<{ url?: string }> }
    | null;
  const imageUrl = json?.images?.[0]?.url;
  if (!imageUrl) throw fail("fal.ai did not return an image URL");

  // fal returns a URL, not base64 — download it (loopback guard applies to
  // test overrides only; real fal CDN URLs are fetched as-is).
  const bytes = await fetchImageBytes(imageUrl);
  return bytesToBase64(bytes);
}

// ---------------------------------------------------------------- top level

/** Render the combo onto a person. Cloudflare first, fal fallback — the same
 * order the consumer app runs in production. */
export async function renderCombo(
  env: PilotEnv,
  req: RenderRequest,
): Promise<RenderResult> {
  if (req.items.length < 1 || req.items.length > KLEIN_MAX_ITEMS) {
    throw new PilotError("invalid_request", `items must have 1..${KLEIN_MAX_ITEMS} entries`);
  }
  const prompt = buildRenderPrompt(req);
  const cfConfigured = !!(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) ||
    !!env.KLEIN_CLOUDFLARE_URL;
  const falConfigured = !!env.FAL_KEY || !!env.KLEIN_FAL_URL;

  if (!cfConfigured && !falConfigured) {
    throw fail("image generation is not configured (set CLOUDFLARE_API_TOKEN and/or FAL_KEY)");
  }

  if (cfConfigured) {
    try {
      const base64 = await renderViaCloudflare(env, prompt, req.items);
      return { base64, mime: sniffMime(base64), provider: "cloudflare" };
    } catch (err) {
      if (err instanceof CloudflareQuotaError) {
        logWarn("klein: cloudflare quota exhausted — trying fal.ai", {});
      } else if (err instanceof PilotError) {
        logWarn("klein: cloudflare failed — trying fal.ai", { message: err.message });
      } else {
        throw err; // programming error — do not mask it as a provider failure
      }
      if (!falConfigured) {
        throw fail("cloudflare image generation failed and fal.ai is not configured");
      }
    }
  }

  const base64 = await renderViaFal(env, prompt, req.items);
  return { base64, mime: sniffMime(base64), provider: "fal" };
}
