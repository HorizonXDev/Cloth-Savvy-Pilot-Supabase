-- ============================================================================
-- 0005_usage_events.sql  —  metering/audit trail. APPEND-ONLY.
--
-- APPEND-ONLY implementation = PRIVILEGE REVOKE (not a trigger). service_role
-- is granted SELECT + INSERT only; UPDATE / DELETE / TRUNCATE are never
-- granted. Reasons (verified live against this Postgres build):
--   * A BEFORE UPDATE/DELETE TRIGGER would block RI ON DELETE CASCADE too
--     (row triggers fire for cascaded deletes), which would make it
--     impossible for drop_tenant() to remove a dropped tenant's events.
--   * ON DELETE CASCADE does NOT need the acting role to hold DELETE on this
--     table — the RI cascade runs with internal privileges (verified live:
--     a role without DELETE on the child deleted the parent and the child
--     rows vanished). So direct UPDATE/DELETE by the API role is blocked
--     while drop_tenant() still works.
--   * A trigger would NOT cover TRUNCATE (row triggers never fire on
--     truncate); withholding the TRUNCATE privilege covers it.
--
-- The composite FK (tenant_id, key_id) -> api_keys(tenant_id, id) (L4) means
-- an event can only ever reference a key OF THE SAME TENANT: a cross-tenant
-- reference fails at write time.
--
-- Retention cleanup (admin, documented in README "usage_events retention"):
--   the table OWNER (postgres) holds full privileges; FORCE RLS applies to
--   the owner too, so an admin briefly unforces, deletes, and re-forces:
--     alter table public.usage_events no force row level security;
--     delete from public.usage_events where created_at < now() - interval '90 days';
--     alter table public.usage_events force row level security;
--   (On the local stack `postgres` has BYPASSRLS so the NO FORCE step is a
--   no-op; on hosted it is UNVERIFIED whether postgres has BYPASSRLS — the
--   dance makes the procedure work either way.)
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.usage_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  key_id      uuid not null,
  endpoint    text,
  units       int  not null default 1,
  request_id  text,
  status_code int,
  created_at  timestamptz not null default now(),
  constraint usage_events_key_fk
    foreign key (tenant_id, key_id)
    references public.api_keys (tenant_id, id)
    on delete cascade                          -- drop_tenant(): api_keys rows go, events follow
);

create index if not exists usage_events_tenant_created_idx
  on public.usage_events (tenant_id, created_at);

alter table public.usage_events enable row level security;
alter table public.usage_events force row level security;
revoke all on table public.usage_events from public, anon, authenticated;
-- APPEND-ONLY: reads + inserts only. The explicit REVOKE below is what
-- actually implements append-only: 0001's default privileges auto-grant
-- ALL table privileges to service_role on postgres-created tables (first
-- test run proved it: PATCH/DELETE answered 204 without this line).
-- No UPDATE/DELETE/TRUNCATE for anybody except the table owner (used only
-- by the documented retention procedure).
revoke all       on table public.usage_events from service_role;
grant  select, insert on table public.usage_events to service_role;
