// _pilot/supabase.ts — the ONE database client factory.
//
// Every function runs with the service-role key INSIDE the edge runtime; no
// anon/authenticated path exists anywhere in this API layer (the pilot's
// schema grants them nothing — proven by schema_audit.sql and test T7).
//
// UNVERIFIED (2026-10, current official docs): the recommended supabase-js
// import style in Deno edge functions is `jsr:@supabase/supabase-js@2`
// (supabase.com/docs/guides/functions -> "npm: or jsr: specifiers"); the
// legacy style was `https://esm.sh/@supabase/supabase-js@2`. If the local
// or hosted runtime rejects the jsr: specifier, switch this one import to
// the esm.sh URL — nothing else changes.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { PilotEnv } from "./types.ts";

export function serviceClient(env: PilotEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
