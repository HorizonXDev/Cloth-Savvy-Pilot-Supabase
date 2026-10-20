-- ============================================================================
-- 0004_api_keys.sql  —  hashed API keys, one row per issued key.
--
-- L1: the plaintext key NEVER reaches the database. The caller (the future
-- API layer) stores only:
--   * key_hash  — SHA-256 hex of the FULL key string (lookup identity),
--   * key_prefix— short display fragment, e.g. 'pk_live_a1b2c3'.
-- The tenant is read FROM this table by resolve_api_key(); a request's
-- tenant is never taken from a request body (L1).
--
-- The UNIQUE (tenant_id, id) constraint exists because usage_events points
-- here with the composite foreign key (tenant_id, key_id) (L4) — a foreign
-- key target must be unique.
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id),
  key_prefix   text,                                    -- display only, e.g. 'pk_live_a1b2c3'
  key_hash     text not null unique,                    -- sha256 hex of the full key
  environment  text not null,                           -- 'live' | 'sandbox'
  label        text,                                    -- human note, e.g. 'shopify-prod'
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,                             -- maintained by resolve_api_key()
  revoked_at   timestamptz,                             -- NULL = still valid
  unique (tenant_id, id),                               -- FK target for usage_events (L4)
  constraint api_keys_environment_valid check (environment in ('live', 'sandbox')),
  constraint api_keys_hash_is_sha256    check (key_hash ~ '^[0-9a-f]{64}$')
);

alter table public.api_keys enable row level security;
alter table public.api_keys force row level security;
revoke all on table public.api_keys from public, anon, authenticated;
-- service_role needs the lot: create_api_key inserts, resolve_api_key
-- updates last_used_at and reads, admin tooling revokes (revoked_at).
grant select, insert, update, delete on table public.api_keys to service_role;
