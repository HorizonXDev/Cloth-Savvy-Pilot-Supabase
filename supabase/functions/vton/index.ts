// functions/vton — POST /v1/vton — B2B image generation, the two-step chain
// the owner described (2026-10-28):
//
//   op=render   combo garments → a person image wearing that combo  (klein 4B)
//   op=tryon    person photo + garment image → try-on render        (FASHN on Modal)
//   op=look     render THEN tryon in one call: combo + person photo → final image
//
// The `look` chain mirrors the consumer app's proven order — mannequin first
// (klein), then FASHN applies it to the person photo — EXCEPT the mannequin
// stays in-memory as base64 and rides to the gateway as
// `garment_image_base64` (pilot-vton-server accepts both forms), so this
// route needs no storage bucket at all.
//
// Response (owner decision: inline base64, no storage):
//   {request_id, op, image: "data:<mime>;base64,...",
//    meta:{provider?, model?, latency_ms:{...}}}
// The caller saves the image wherever they want.
//
// Auth: sk_ key — tenant from the key only (like every pilot route), and the
// call is metered by the pipeline's finally block (endpoint label "vton").
//
// IDEMPOTENCY: send an optional `Idempotency-Key` header (8..128 chars of
// A-Z a-z 0-9 . _ : -) to make retries safe. The first request reserves the
// key (0013), runs, and stores the response; a retry with the same key and
// body gets the stored image (header `Idempotency-Replayed: true`, meta
// `idempotent_replay`) instead of paying for a second GPU run. Same key with
// a different body is a 400; a concurrent duplicate is a 429 + Retry-After.
// Without the header nothing changes.
//
// TIMEOUTS: Supabase kills the worker at 150 s wall-clock on the Free plan
// (400 s on paid), so the WHOLE chain must answer inside that — the engine
// budget is VTON_TIMEOUT_MS (135 s) and op=look shrinks it by whatever the
// klein render already consumed. Callers should use ~140 s client timeouts.
// A slow L4 capacity wait therefore surfaces as a clean 502 + Retry-After
// instead of the platform's opaque `546 WORKER_RESOURCE_LIMIT` (observed
// live 2026-10-29 before this budget existed).
//
// Known business risk (owner's own B2B_DISCOVERY_REPORT): FASHN's
// human-parser weights are NVIDIA research/eval-only — fine to build and
// test, read report risk #1 before charging tenants for this route.

import { renderCombo, KLEIN_MAX_ITEMS, type RenderItem } from "../_pilot/klein.ts";
import { tryOn, VTON_CATEGORIES, VTON_TIMEOUT_MS, type VtonCategory } from "../_pilot/vton.ts";
import { PilotError } from "../_pilot/errors.ts";
import { handle } from "../_pilot/http.ts";
import {
  beginIdempotent,
  completeIdempotent,
  readIdempotencyKey,
  releaseIdempotent,
  requestHash,
} from "../_pilot/idempotency.ts";
import { readEnv } from "../_pilot/env.ts";
import { isSection } from "../_pilot/sections.ts";
import { optInt, optString, readJsonObject } from "../_pilot/validation.ts";
import type { HandlerResult, HandlerContext } from "../_pilot/types.ts";

const OPS = ["render", "tryon", "look"] as const;
type Op = (typeof OPS)[number];

interface LookBody {
  items: RenderItem[];
  person_image_url: string;
  gender: string;
  age: number;
  style_notes?: string;
  category: VtonCategory;
  num_timesteps: number;
}

function bad(field: string, why: string): PilotError {
  return new PilotError("invalid_request", `field '${field}' ${why}`);
}

/** items: 1..KLEIN_MAX_ITEMS of {image_url, description?, section?}. */
function parseItems(body: Record<string, unknown>): RenderItem[] {
  const raw = body.items;
  if (!Array.isArray(raw)) throw bad("items", "is required and must be an array");
  if (raw.length < 1 || raw.length > KLEIN_MAX_ITEMS) {
    throw bad(`items`, `must have 1..${KLEIN_MAX_ITEMS} entries`);
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw bad(`items[${i}]`, "must be an object");
    }
    const obj = entry as Record<string, unknown>;
    const url = optString(obj, "image_url", { required: true, max: 2048 });
    const description = optString(obj, "description", { max: 300 });
    const section = optString(obj, "section", { max: 40 });
    if (section && !isSection(section)) {
      throw bad(`items[${i}].section`, "is not a valid pilot section");
    }
    return { image_url: url!, description, section };
  });
}

function parseCommonRender(body: Record<string, unknown>): {
  gender: string;
  age: number;
  style_notes?: string;
} {
  const gender = optString(body, "gender", { max: 40 }) ?? "person";
  const age = optInt(body, "age", { min: 5, max: 100, default: 30 })!;
  const style_notes = optString(body, "style_notes", { max: 300 });
  return { gender, age, style_notes };
}

function parseTryOnShape(body: Record<string, unknown>): {
  category: VtonCategory;
  num_timesteps: number;
} {
  const category = (optString(body, "category", {
    values: VTON_CATEGORIES,
  }) ?? "tops") as VtonCategory;
  const num_timesteps = optInt(body, "num_timesteps", {
    min: 1,
    max: 100,
    default: 30,
  })!;
  return { category, num_timesteps };
}

function dataUri(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

/** Replay envelope: a fresh request id, and the original one kept in meta so
 * a caller can tell "cached" from "ran again" without guessing. */
function markedReplay(body: unknown, requestId: string): Record<string, unknown> {
  const original = typeof body === "object" && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const meta = typeof original.meta === "object" && original.meta !== null &&
      !Array.isArray(original.meta)
    ? original.meta as Record<string, unknown>
    : {};
  return {
    ...original,
    request_id: requestId,
    meta: {
      ...meta,
      idempotent_replay: true,
      original_request_id: typeof original.request_id === "string" ? original.request_id : null,
    },
  };
}

Deno.serve((req) =>
  handle(req, readEnv(), { endpoint: "vton", auth: true, methods: ["POST"] }, async (ctx) => {
    const auth = ctx.auth!;
    const body = await readJsonObject(ctx.req);
    const op = optString(body, "op", { required: true, values: OPS })! as Op;

    // Reserve BEFORE any provider call: a retry after a timeout must not pay
    // for a second render. Invalid field values still release the slot below.
    const slot = await beginIdempotent(
      ctx.db,
      auth.tenantId,
      "vton",
      readIdempotencyKey(ctx.req),
      await requestHash(body),
    );
    if (slot.kind === "replay") {
      return {
        body: markedReplay(slot.response, ctx.requestId),
        headers: { "Idempotency-Replayed": "true" },
      };
    }

    try {
      const result = op === "render"
        ? await renderOp(ctx, body)
        : op === "tryon"
        ? await tryOnOp(ctx, body)
        : await lookOp(ctx, body, auth.tenantId);
      await completeIdempotent(ctx.db, auth.tenantId, "vton", slot.key, result.body);
      return result;
    } catch (err) {
      await releaseIdempotent(ctx.db, auth.tenantId, "vton", slot.key);
      throw err;
    }

    async function renderOp(c: HandlerContext, b: Record<string, unknown>): Promise<HandlerResult> {
      const items = parseItems(b);
      const common = parseCommonRender(b);
      const started = performance.now();
      const result = await renderCombo(c.env, { items, ...common });
      c.timings.render = Math.round(performance.now() - started);
      return {
        body: {
          request_id: c.requestId,
          op: "render",
          image: dataUri(result.mime, result.base64),
          meta: {
            provider: result.provider,
            model: "flux-2-klein-4b",
            latency_ms: { render: c.timings.render },
          },
        },
      };
    }

    async function tryOnOp(c: HandlerContext, b: Record<string, unknown>): Promise<HandlerResult> {
      const personImageUrl = optString(b, "person_image_url", { required: true, max: 2048 })!;
      const garmentImageUrl = optString(b, "garment_image_url", { required: true, max: 2048 })!;
      const { category, num_timesteps } = parseTryOnShape(b);
      const started = performance.now();
      const result = await tryOn(c.env, {
        person_image_url: personImageUrl,
        garment_image_url: garmentImageUrl,
        category,
        num_timesteps,
        tenantId: c.auth!.tenantId,
      });
      c.timings.tryon = Math.round(performance.now() - started);
      return {
        body: {
          request_id: c.requestId,
          op: "tryon",
          image: dataUri(result.mime, result.base64),
          meta: {
            provider: result.provider,
            model: "fashn-vton-1.5",
            category,
            num_timesteps,
            latency_ms: { tryon: c.timings.tryon },
          },
        },
      };
    }

    async function lookOp(
      c: HandlerContext,
      b: Record<string, unknown>,
      tenantId: string,
    ): Promise<HandlerResult> {
      const parsed: LookBody = {
        items: parseItems(b),
        person_image_url: optString(b, "person_image_url", { required: true, max: 2048 })!,
        ...parseCommonRender(b),
        // consumer-app behaviour: the rendered full outfit goes to FASHN as a
        // single one-piece garment
        ...parseTryOnShape(b),
        category: (optString(b, "category", { values: VTON_CATEGORIES }) ??
          "one-pieces") as VtonCategory,
      };

      // 1. combo → person image (klein)
      const t0 = performance.now();
      const rendered = await renderCombo(c.env, {
        items: parsed.items,
        gender: parsed.gender,
        age: parsed.age,
        style_notes: parsed.style_notes,
      });
      c.timings.render = Math.round(performance.now() - t0);

      // 2. mannequin (in-memory base64) + person photo → final try-on. The
      // try-on gets whatever remains of the 135 s budget after the render,
      // so the route always finishes inside the platform's 150 s wall clock.
      const t1 = performance.now();
      const budget = Math.max(15_000, VTON_TIMEOUT_MS - Math.round(t1 - t0));
      const finalImage = await tryOn(
        c.env,
        {
          person_image_url: parsed.person_image_url,
          garment_image_base64: rendered.base64,
          category: parsed.category,
          num_timesteps: parsed.num_timesteps,
          tenantId,
        },
        budget,
      );
      c.timings.tryon = Math.round(performance.now() - t1);

      return {
        body: {
          request_id: c.requestId,
          op: "look",
          image: dataUri(finalImage.mime, finalImage.base64),
          meta: {
            provider: finalImage.provider,
            render_provider: rendered.provider,
            model: "fashn-vton-1.5",
            category: parsed.category,
            num_timesteps: parsed.num_timesteps,
            latency_ms: {
              render: c.timings.render,
              tryon: c.timings.tryon,
              total: c.timings.render + c.timings.tryon,
            },
          },
        },
      };
    }
  }),
);
