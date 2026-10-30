-- ============================================================================
-- 0013_idempotency.sql  —  replay protection for expensive routes.
--
-- A client that times out on /vton (GPU render, up to ~135 s) and retries the
-- same request used to pay for the render twice. With an `Idempotency-Key`
-- header the first response is stored and replayed instead: same key + same
-- request => one GPU run, one image.
--
-- Rules enforced by the API layer (_pilot/idempotency.ts):
--   * scope is (tenant, endpoint, key): one tenant can never read or collide
--     with another tenant's key. The tenant comes from the API key, never the
--     request body.
--   * the request hash must match; reusing a key for a DIFFERENT request is a
--     400, not a silent wrong response.
--   * a row is reserved (status='in_progress') BEFORE the GPU call and filled
--     (status='done', response=jsonb) after it. A concurrent duplicate gets a
--     429 with Retry-After instead of starting a second render.
--   * a reservation older than 10 minutes is treated as crashed and taken
--     over, so one dead worker cannot block a key for its whole lifetime.
--   * rows expire after 24 hours; delete them with the statement at the
--     bottom (safe to run from a cron or by hand).
--
-- RLS forced + zero grants to anon/authenticated, service_role only — the
-- same policy as every other pilot table. The stored response contains the
-- rendered image (data URI), which is why this table must never be exposed
-- through PostgREST.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.idempotency_keys (
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  endpoint     text not null,
  key          text not null,
  request_hash text not null,
  status       text not null default 'in_progress'
                 check (status in ('in_progress', 'done')),
  response     jsonb,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '24 hours',
  primary key (tenant_id, endpoint, key)
);

create index if not exists idempotency_keys_expires_idx
  on public.idempotency_keys (expires_at);

alter table public.idempotency_keys enable row level security;
alter table public.idempotency_keys force row level security;
revoke all on table public.idempotency_keys from public, anon, authenticated;
grant select, insert, update, delete on table public.idempotency_keys to service_role;

comment on table public.idempotency_keys is
  'Idempotency-Key reservations/results for expensive pilot routes (tenant-scoped).';

-- Housekeeping (run manually or from a cron), safe at any time:
--   delete from public.idempotency_keys where expires_at < now();
--
-- APPLY ORDER (observed 2026-10-30 while testing): this file must be applied
-- to the environment the tests target. After manual DDL the PostgREST schema
-- cache still holds the OLD schema, and every insert fails with
-- `PGRST205: Could not find the table ... in the schema cache` (the API
-- answers 500 and the guard logs `idempotency: insert failed`). Fix it with:
--   NOTIFY pgrst, 'reload schema';
-- The Supabase CLI/dashboard do this automatically when migrations run through
-- them; only hand-applied SQL needs the NOTIFY.
