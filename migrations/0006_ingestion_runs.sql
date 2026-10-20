-- ============================================================================
-- 0006_ingestion_runs.sql  —  one row per catalog import/sync job.
--
-- Written by the future ingestion service: status lifecycle, row counters,
-- start/finish timestamps, free-form notes for failures. tenant_id has a
-- plain FOREIGN KEY to tenants (delete is refused while run rows exist —
-- drop_tenant() removes them explicitly first, in the documented order).
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.ingestion_runs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id),
  status      text not null,                           -- e.g. 'running' | 'done' | 'failed' (app-defined)
  rows_total  int  not null default 0,
  rows_ok     int  not null default 0,
  rows_failed int  not null default 0,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  notes       text
);

alter table public.ingestion_runs enable row level security;
alter table public.ingestion_runs force row level security;
revoke all on table public.ingestion_runs from public, anon, authenticated;
grant select, insert, update, delete on table public.ingestion_runs to service_role;
