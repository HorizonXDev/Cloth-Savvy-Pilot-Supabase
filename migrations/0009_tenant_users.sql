-- ============================================================================
-- 0009_tenant_users.sql  —  portal logins: WHICH auth user belongs to WHICH
-- tenant. This table is the ONLY bridge between Supabase Auth (auth.users,
-- outside public) and the tenant data — the tenant portal's authorization
-- anchor.
--
-- Threat model (portal separation, decision in README "Two dashboards"):
--   * A portal session resolves EXACTLY ONE tenant via this table. The
--     tenant id is NEVER read from a request body, query or header — a
--     crafted request cannot address another tenant.
--   * There is no column, path or function here that can express "all
--     tenants" or an admin capability: membership is per-tenant, full stop.
--   * Revoking a row (revoked_at) cuts that login off from every tenant_*
--     route on its next request — fail closed.
--
-- schema_audit compliance (rules for every public table):
--   * RLS enabled AND forced; anon/authenticated hold ZERO privileges;
--     service_role holds normal DML.
--   * carries a tenant_id column (it maps INTO a tenant).
--
-- drop_tenant(): the FK to tenants is ON DELETE CASCADE, so dropping a
-- tenant removes its memberships with it — RI cascades run with internal
-- privileges and need no DELETE grant on this table (proven for
-- usage_events, 0005 header). drop_tenant() needs NO change.
--
-- auth.users FK: ON DELETE CASCADE — deleting the auth user removes the
-- membership (the reverse direction is intentionally NOT cascaded; deleting
-- a membership must never delete an auth user behind the admin's back).
--
-- One login = ONE tenant (user_id UNIQUE). A human who genuinely needs two
-- tenants gets two logins — this keeps session→tenant resolution
-- deterministic (no tenant picker, no ambiguity to exploit).
--
-- email is denormalized from auth.users at invite time for listing/audit
-- without paging the GoTrue admin API; auth.users remains authoritative.
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.tenant_users (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  user_id    uuid not null unique references auth.users (id) on delete cascade,
  email      text not null,
  created_at timestamptz not null default now(),
  created_by text not null default 'admin',     -- 'admin' (who provisioned it)
  revoked_at timestamptz                        -- NULL = active membership
);

create index if not exists tenant_users_tenant_idx
  on public.tenant_users (tenant_id);

-- case-insensitive email lookups for the invite flow (invite normalizes
-- to lowercase before writing/reading)
create index if not exists tenant_users_email_idx
  on public.tenant_users (lower(email));

alter table public.tenant_users enable row level security;
alter table public.tenant_users force row level security;
revoke all on table public.tenant_users from public, anon, authenticated;
grant select, insert, update, delete on table public.tenant_users to service_role;

-- The portal/tenant routes read this table only through the service-role
-- client inside Edge Functions; nothing here is exposed via PostgREST to
-- the API roles (0001's defaults would otherwise auto-grant on future
-- tables — this explicit revoke is the enforcement, same as 0004/0005).
