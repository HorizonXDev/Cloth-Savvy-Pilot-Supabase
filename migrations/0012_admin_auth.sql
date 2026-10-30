-- ============================================================================
-- 0012_admin_auth.sql  —  real admin identities + an audit trail.
--
-- Before this migration every admin_* route was protected by ONE shared
-- ADMIN_TOKEN in browser localStorage: no identity, no revocation, no trail,
-- and one XSS or one pasted token granted the entire platform. The token now
-- survives only as BREAK-GLASS (curl, tests, recovery) — normal sign-in is a
-- Supabase Auth session whose user must appear in admin_users.
--
-- Two tables, both invisible to anon/authenticated (RLS forced, zero grants,
-- service_role only — the same policy as tenant_users in 0009):
--
--   admin_users  who may call admin_* at all.
--                * user_id UNIQUE, FK auth.users ON DELETE CASCADE.
--                * NO tenant_id: an admin is platform-wide by definition and
--                  must not be confusable with tenant membership.
--                * revoked_at cuts access on the next request (fail closed).
--
--   admin_audit  one row per MUTATING admin request (POST/PATCH/DELETE),
--                written by verifyAdmin() after the actor is known and before
--                the handler runs. Append-only: no UPDATE/DELETE grant for
--                service_role either, so a bug cannot rewrite history.
--
-- Seeding the first admin (owner runs this once, in the SQL editor):
--   insert into public.admin_users (user_id, email)
--   values ('<auth.users.id>', '<email>');
-- Create the auth user first: Dashboard → Authentication → Users → Add user.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.admin_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  created_at timestamptz not null default now(),
  created_by text not null default 'owner',
  revoked_at timestamptz
);

alter table public.admin_users enable row level security;
alter table public.admin_users force row level security;
revoke all on table public.admin_users from public, anon, authenticated;
grant select, insert, update, delete on table public.admin_users to service_role;

create table if not exists public.admin_audit (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  actor_kind  text not null check (actor_kind in ('user', 'break_glass')),
  actor_id    uuid,
  actor_email text,
  method      text not null,
  path        text not null,
  request_id  text
);

create index if not exists admin_audit_created_idx
  on public.admin_audit (created_at desc);

alter table public.admin_audit enable row level security;
alter table public.admin_audit force row level security;
revoke all on table public.admin_audit from public, anon, authenticated;
-- Append-only: INSERT + SELECT for the service role, deliberately no
-- UPDATE/DELETE, so an audit row cannot be rewritten or removed by the API.
grant select, insert on table public.admin_audit to service_role;

comment on table public.admin_users is
  'Supabase Auth users allowed to call admin_* functions. ADMIN_TOKEN remains break-glass only.';
comment on table public.admin_audit is
  'Append-only record of mutating admin requests: who, what, when, request id.';
