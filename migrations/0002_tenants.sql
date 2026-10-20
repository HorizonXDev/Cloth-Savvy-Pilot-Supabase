-- ============================================================================
-- 0002_tenants.sql  —  the tenant registry (the L1/L5 anchor for everything).
--
-- Every tenant row pins the embedding model+dimension its products must use
-- (L5). `settings` is the JSON bag the API layer will read later: currency,
-- min_similarity, default_limit and combo recipes per occasion, e.g.
--   {"currency": "INR", "min_similarity": 0.25, "default_limit": 10,
--    "combos": {"wedding": ["saree", "blouse", "jewellery"]}}
--
-- L2: ENABLED + FORCE row security with ZERO policies = default deny for
-- everyone including the table owner; all privileges revoked from
-- PUBLIC/anon/authenticated; service_role (the server role, BYPASSRLS) holds
-- normal DML so the SQL functions and admin tooling work.
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,                 -- [a-z0-9_]+, also names the partition
  name            text not null,
  website_url     text,
  status          text not null default 'active',       -- 'active' | 'suspended'
  embedding_model text not null,                        -- products must carry exactly this
  embedding_dim   int  not null,                        -- must be 512 (column is vector(512))
  settings        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  constraint tenants_slug_format  check (slug ~ '^[a-z0-9_]+$'),
  constraint tenants_status_valid check (status in ('active', 'suspended')),
  constraint tenants_dim_positive check (embedding_dim > 0)
);

alter table public.tenants enable row level security;
alter table public.tenants force row level security;
-- No policies on purpose -> default deny for everyone, owner included.
revoke all on table public.tenants from public, anon, authenticated;
-- service_role needs the lot: create_tenant/drop_tenant write, resolve_api_key
-- and search_products read, admin tooling suspends/reactivates.
grant select, insert, update, delete on table public.tenants to service_role;
