// _pilot/env.ts — build the typed PilotEnv from Deno's environment.
// Names only, never values (see types.ts). Missing optional secrets are left
// undefined; the callers fail with clean upstream_* errors instead of throws.

import type { PilotEnv } from "./types.ts";

function get(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v === undefined || v === "" ? undefined : v;
}

export function readEnv(): PilotEnv {
  return {
    SUPABASE_URL: get("SUPABASE_URL") ?? "",
    SUPABASE_SERVICE_ROLE_KEY: get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    ENCODER_URL: get("ENCODER_URL"),
    ENCODER_AUTH_TOKEN: get("ENCODER_AUTH_TOKEN"),
    GROQ_API_KEY: get("GROQ_API_KEY"),
    GROQ_MODEL: get("GROQ_MODEL"),
    ALLOWED_ORIGINS: get("ALLOWED_ORIGINS"),
    ADMIN_TOKEN: get("ADMIN_TOKEN"),
    ADMIN_ALLOWED_ORIGINS: get("ADMIN_ALLOWED_ORIGINS"),
    TENANT_ALLOWED_ORIGINS: get("TENANT_ALLOWED_ORIGINS"),
    PILOT_LLM_BASE_URL: get("PILOT_LLM_BASE_URL"),
  };
}
