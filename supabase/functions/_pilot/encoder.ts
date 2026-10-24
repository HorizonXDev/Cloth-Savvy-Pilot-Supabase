// _pilot/encoder.ts — client for the Modal FashionCLIP text encoder
// (Cloth-Savvy-CLIP-server). Contract verified from that repo (Step 0b):
//
//   POST {ENCODER_URL}/embed_texts
//        Authorization: Bearer <ENCODER_AUTH_TOKEN>
//        {"texts": ["...", ...]}     1–8 strings, each ≤300 chars
//   →    {"model":"fashion-clip","revision":"7e3ba62ce16b...",
//         "dim":512,"embeddings":[[...512 floats...]],"server_ms":12.3}
//   GET  {ENCODER_URL}/health        no auth — model + revision + ready + RSS
//
// Failure policy (brief): the live container may be restarting or waiting for
// Modal capacity ("waiting to be scheduled on a CPU worker"), so every call
// gets a 10 s timeout and exactly ONE retry; if it still fails we answer
// upstream_encoder (503) with `Retry-After: 5` — never a silent empty result.
//
// Model-string guard (Step 0a): the encoder reports `model` + `revision`
// separately; the CANONICAL string is composed as "<model>@<revision[0..7]>",
// e.g. "fashion-clip@7e3ba62". It must equal the tenant's
// tenants.embedding_model exactly. Mismatch → upstream_encoder (503), NEVER a
// silent continue: vectors from a different model/revision live in a
// different vector space and every similarity would be meaningless.
// NOTE: the DB currently says 'fashion-clip-local' — until the owner migrates
// that string (README/README report list), every embedding call will 503 by
// design. That is the honesty the brief demands; see FINAL REPORT Step 0.

import { PilotError } from "./errors.ts";
import { logWarn } from "./logger.ts";
import type { PilotEnv } from "./types.ts";

export const ENCODER_MAX_TEXTS = 8;
export const ENCODER_MAX_CHARS = 300;
export const ENCODER_TIMEOUT_MS = 10_000;
export const ENCODER_RETRY_AFTER = "5";

export interface EmbedResult {
  embeddings: number[][];
  canonicalModel: string; // "fashion-clip@7e3ba62"
  attempts: number;
  serverMs: number;
}

function fail(message: string, extra?: Record<string, string>): PilotError {
  return new PilotError(
    "upstream_encoder",
    message,
    { "Retry-After": ENCODER_RETRY_AFTER, ...extra },
  );
}

/** "<model>@<revision first 7 chars>" — the canonical embedding model id. */
export function canonicalModelOf(model: string, revision: string | undefined): string {
  const rev = (revision ?? "").slice(0, 7);
  return rev ? `${model}@${rev}` : model;
}

function baseUrl(env: PilotEnv): string {
  if (!env.ENCODER_URL) {
    throw fail("encoder is not configured (ENCODER_URL missing)");
  }
  return env.ENCODER_URL.replace(/\/+$/, "");
}

/** Embed 1–8 texts. `expectedModel` is the tenant's embedding_model. */
export async function embedTexts(
  env: PilotEnv,
  texts: string[],
  expectedModel: string,
): Promise<EmbedResult> {
  if (texts.length < 1 || texts.length > ENCODER_MAX_TEXTS) {
    throw new PilotError("internal", `encoder batch must be 1..${ENCODER_MAX_TEXTS} texts`);
  }
  for (const t of texts) {
    if (typeof t !== "string" || t.length === 0 || t.length > ENCODER_MAX_CHARS) {
      throw new PilotError("internal", `encoder text must be 1..${ENCODER_MAX_CHARS} chars`);
    }
  }

  const url = `${baseUrl(env)}/embed_texts`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.ENCODER_AUTH_TOKEN) headers.Authorization = `Bearer ${env.ENCODER_AUTH_TOKEN}`;

  let attempts = 0;
  let lastWhy = "unknown";
  for (let attempt = 1; attempt <= 2; attempt++) { // ONE retry
    attempts = attempt;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ texts }),
        signal: AbortSignal.timeout(ENCODER_TIMEOUT_MS),
      });
    } catch (e) {
      lastWhy = e instanceof Error ? e.name : "network error";
      logWarn("encoder: transport failure", { attempt, why: lastWhy });
      continue; // retry once (timeout / connection refused / container waking)
    }

    if (!res.ok) {
      lastWhy = `http ${res.status}`;
      // 4xx (auth/config) will not improve on retry; 5xx/429 might.
      if (res.status >= 500 || res.status === 429) continue;
      // 401 = wrong ENCODER_AUTH_TOKEN, 400 = our texts rejected — both are
      // upstream/config problems from THIS layer's perspective.
      await res.body?.cancel();
      throw fail(`encoder rejected the request (${res.status})`);
    }

    let body: {
      model?: string; revision?: string; dim?: number;
      embeddings?: unknown; server_ms?: number;
    };
    try {
      body = await res.json();
    } catch {
      throw fail("encoder returned a non-JSON body");
    }

    if (body.dim !== 512) throw fail(`encoder dim is ${String(body.dim)}, expected 512`);
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) {
      throw fail("encoder returned the wrong number of embeddings");
    }
    const embeddings: number[][] = [];
    for (const raw of body.embeddings) {
      if (!Array.isArray(raw) || raw.length !== 512 || raw.some((v) => typeof v !== "number")) {
        throw fail("encoder returned a malformed embedding vector");
      }
      embeddings.push(raw as number[]);
    }

    const canonical = canonicalModelOf(String(body.model ?? ""), body.revision);
    if (canonical !== expectedModel) {
      // NEVER silently continue — mixing vector spaces poisons every search.
      logWarn("encoder: model mismatch", { got: canonical, expected: expectedModel });
      throw fail(
        "embedding model mismatch — encoder and tenant disagree (see request_id in server logs)",
      );
    }

    return { embeddings, canonicalModel: canonical, attempts, serverMs: body.server_ms ?? 0 };
  }

  throw fail(`encoder unavailable after ${attempts} attempt(s) (${lastWhy})`);
}

export interface EncoderHealth {
  status: "ok" | "degraded";
  latency_ms: number;
  model?: string;
  revision?: string;
  detail?: string;
}

/** Relay of the encoder's open GET /health (no auth by design). */
export async function encoderHealth(env: PilotEnv): Promise<EncoderHealth> {
  const t0 = performance.now();
  if (!env.ENCODER_URL) {
    return { status: "degraded", latency_ms: 0, detail: "ENCODER_URL not configured" };
  }
  try {
    const res = await fetch(`${baseUrl(env)}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { status: "degraded", latency_ms: ms, detail: `http ${res.status}` };
    const body = await res.json() as { model?: string; revision?: string; ready?: boolean };
    if (body.ready === false) return { status: "degraded", latency_ms: ms, detail: "not ready" };
    return {
      status: "ok",
      latency_ms: ms,
      model: body.model ? canonicalModelOf(body.model, body.revision) : undefined,
      revision: body.revision,
    };
  } catch (e) {
    return {
      status: "degraded",
      latency_ms: Math.round(performance.now() - t0),
      detail: e instanceof Error ? e.name : "unreachable",
    };
  }
}
