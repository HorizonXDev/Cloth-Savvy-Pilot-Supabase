// _pilot/llm.ts — Groq (OpenAI-compatible) client for the combos LLM step.
//
// Per the brief:
//   * JSON mode (`response_format: {type:"json_object"}`), low temperature,
//     15 s timeout, exactly ONE retry, then STRICT caller-supplied schema
//     validation of the parsed output. Any failure → PilotError
//     upstream_llm (502). The caller falls back to the deterministic recipe
//     engine on upstream_llm.
//   * Model name from env GROQ_MODEL, default DEFAULT_GROQ_MODEL (the
//     consumer project uses openai/gpt-oss-20b — a Llama/gpt-oss-class
//     model; owner may override with any Groq-served model).
//   * NEVER send user identifiers, API keys or tenant secrets in prompts:
//     the prompt carries occasion/sections/facets/constraints only — no
//     tenant id, no key material, no request ids.
//   * Prompts and completions are never logged (they contain tenant catalog
//     text); only lengths and timings are.
//
// STUB SAFETY (hard rule 3): PILOT_LLM_BASE_URL redirects the client to a
// local stub for tests, but ONLY when it is a loopback URL — enforced right
// below. In production that env is unset; even if a secret named
// PILOT_LLM_BASE_URL were set to https://evil.example, the loopback check
// drops it (with a warning) and Groq is used. The local stub itself binds
// 127.0.0.1 and lives under tests/ — it is never deployed with functions.

import { PilotError } from "./errors.ts";
import { logWarn } from "./logger.ts";
import type { PilotEnv } from "./types.ts";

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";
export const LLM_TIMEOUT_MS = 15_000;
const GROQ_BASE = "https://api.groq.com/openai";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]",
  // Local dev only: when the Supabase edge runtime runs inside Docker it
  // reaches stubs on the developer's machine via this name. It cannot point
  // at an attacker server — it is Docker Desktop's built-in host alias, and
  // the override env itself is never set in production.
  "host.docker.internal"]);

/** Base URL with loopback-only stub override (see header comment). */
export function llmBaseUrl(env: PilotEnv): string {
  const override = env.PILOT_LLM_BASE_URL;
  if (override) {
    try {
      const u = new URL(override);
      if (LOOPBACK_HOSTS.has(u.hostname)) {
        return override.replace(/\/+$/, "");
      }
      logWarn("llm: PILOT_LLM_BASE_URL is not loopback — ignoring it", {});
    } catch {
      logWarn("llm: PILOT_LLM_BASE_URL is not a URL — ignoring it", {});
    }
  }
  return GROQ_BASE;
}

export interface ChatJsonInput {
  system: string;
  user: string;
  /** Strict parser: throw (or return null) to reject the parsed JSON. */
  validate: (parsed: unknown) => unknown;
  maxTokens?: number;
}

export interface ChatJsonResult<T> {
  data: T;
  attempts: number;
  ms: number;
  model: string;
}

export async function chatJson<T>(env: PilotEnv, input: ChatJsonInput): Promise<ChatJsonResult<T>> {
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) {
    // Treated the same as an LLM failure → the caller falls back to the
    // deterministic recipe engine (documented: engine="recipe_fallback").
    throw new PilotError("upstream_llm", "LLM is not configured (GROQ_API_KEY missing)");
  }
  const model = env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL;
  const url = `${llmBaseUrl(env)}/v1/chat/completions`;
  const payload = {
    model,
    temperature: 0.2,
    max_tokens: input.maxTokens ?? 1600,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
  };

  let attempts = 0;
  let lastWhy = "unknown";
  for (let attempt = 1; attempt <= 2; attempt++) { // exactly ONE retry
    attempts = attempt;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
    } catch (e) {
      lastWhy = e instanceof Error ? e.name : "network error";
      logWarn("llm: transport failure", { attempt, why: lastWhy });
      continue;
    }

    if (!res.ok) {
      lastWhy = `http ${res.status}`;
      logWarn("llm: bad response — retry decision", {
        attempt, status: res.status, retry: res.status >= 500 || res.status === 429,
      });
      await res.body?.cancel().catch(() => {});
      if (res.status >= 500 || res.status === 429) continue;
      // 4xx: auth/model errors — retrying will not help.
      throw new PilotError("upstream_llm", `LLM rejected the request (${res.status})`);
    }

    let content: string | undefined;
    try {
      const body = await res.json() as {
        choices?: { message?: { content?: string } }[];
      };
      content = body.choices?.[0]?.message?.content;
    } catch {
      lastWhy = "non-JSON response";
      continue;
    }
    if (typeof content !== "string" || content === "") {
      lastWhy = "empty completion";
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      lastWhy = "invalid JSON in completion";
      logWarn("llm: completion was not valid JSON", { attempt, chars: content.length });
      continue; // retry, then the caller's fallback engine
    }

    try {
      const validated = input.validate(parsed) as T;
      const ms = 0; // filled by caller timing
      return { data: validated, attempts, ms, model };
    } catch (e) {
      lastWhy = "schema validation failed";
      logWarn("llm: completion failed strict validation", { attempt });
      continue;
    }
  }

  throw new PilotError(
    "upstream_llm",
    `LLM step failed after ${attempts} attempt(s) (${lastWhy})`,
  );
}
