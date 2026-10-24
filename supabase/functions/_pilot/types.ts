// _pilot/types.ts — shared types for the pilot API layer.
//
// Env names (never values) — the owner sets these as Supabase secrets:
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — injected automatically by
//     Supabase Edge Functions. UNVERIFIED (2026-10): the exact injected names
//     on the hosted runtime are documented as SUPABASE_URL +
//     SUPABASE_SERVICE_ROLE_KEY in the official secrets docs; the local stack
//     injects the same pair. If a hosted deploy 500s with "missing env", check
//     `supabase functions secrets list` first.
//   ENCODER_URL          — the Modal FashionCLIP text encoder base URL.
//   ENCODER_AUTH_TOKEN   — bearer token the encoder expects (Modal secret
//                          "pilot-encoder-auth"; value never in any repo file).
//   GROQ_API_KEY         — pilot-dedicated Groq key (combos LLM step).
//   GROQ_MODEL           — optional; defaults to DEFAULT_GROQ_MODEL in llm.ts.
//   ALLOWED_ORIGINS      — comma-separated CORS allowlist; never "*".
//   PILOT_LLM_BASE_URL   — LOCAL TESTS ONLY: override for the OpenAI-compatible
//                          LLM base URL. Ignored unless it is a loopback host
//                          (enforced in llm.ts) so it cannot redirect prod.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export interface PilotEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ENCODER_URL?: string;
  ENCODER_AUTH_TOKEN?: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  ALLOWED_ORIGINS?: string;
  PILOT_LLM_BASE_URL?: string;
}

/** Everything the auth middleware resolves for a request. tenantId comes ONLY
 * from the API key — never from body, query or headers (this is exactly what
 * isolation test T15 checks). */
export interface AuthContext {
  tenantId: string;
  keyId: string;
  environment: "live" | "sandbox"; // from the api_keys row, not the prefix
  keyPrefixSk: "sk_live_" | "sk_test_"; // the prefix family the caller presented
  tenantModel: string; // tenants.embedding_model — the canonical model string
  settings: TenantSettings; // validated tenants.settings
}

export interface TenantSettings {
  currency: string | null;
  min_similarity: number;
  default_limit: number;
  rate_limit_per_min: number;
  combos: Record<string, string[]>; // occasion -> ordered pilot sections
}

export interface HandlerContext {
  req: Request;
  env: PilotEnv;
  db: SupabaseClient;
  requestId: string;
  auth?: AuthContext; // set when the route requires auth and it succeeded
  /** Milliseconds timings the handler wants in the Server-Timing header. */
  timings: Record<string, number>;
}

export interface HandlerResult {
  status?: number; // default 200
  body: unknown;
  headers?: Record<string, string>;
}

/** A row as returned by search_products / product_by_external_id. */
export interface ProductRow {
  id: string;
  external_id: string;
  title: string;
  section: string;
  category: string | null;
  colors: string[] | null;
  price: string | number | null; // numeric comes back as a JSON string
  in_stock: boolean;
  product_url: string | null;
  image_url: string | null;
  attributes: Record<string, unknown>;
  similarity?: number | null;
}
