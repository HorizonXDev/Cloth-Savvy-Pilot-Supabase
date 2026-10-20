-- ============================================================================
-- 0001_extensions.sql  —  pgvector + project-wide lockdown defaults.
--
-- Run FIRST, in the SQL editor (hosted) or via psql (local).
-- Idempotent: every statement is safe to re-run.
--
-- What it does:
--   1. Ensures the `extensions` schema exists and pgvector is installed INTO
--      it (Supabase's documented home for extensions; the spike verified this
--      works locally on this stack). Because our functions run with
--      search_path = '', columns/operators are written as
--      extensions.vector(512) and OPERATOR(extensions.<=>).
--   2. Locks schema `public`: the API roles must not be able to CREATE
--      objects there (CREATE was granted to PUBLIC on `public` before
--      PostgreSQL 15; older projects may still carry that grant).
--   3. Sets the DEFAULT PRIVILEGES for every FUTURE table/function created
--      by `postgres` in `public`: anon and authenticated get NOTHING,
--      service_role gets full DML / EXECUTE. Supabase's platform default
--      grants SELECT/INSERT/UPDATE/DELETE on new public tables to
--      anon/authenticated/service_role (supabase.com/docs/guides/api/
--      securing-your-api), and a new PARTITION is a new table — without
--      this, every tenant partition created by `postgres` would be
--      auto-granted to anon.
--
-- NOTE (design consequence, see README "Decisions"): create_tenant() is
-- SECURITY INVOKER and runs as service_role, so service_role needs CREATE on
-- schema public to be able to create the per-tenant partition table.
-- service_role is the trusted server role (it already holds BYPASSRLS and
-- full DML on our tables); it must never be exposed to a browser.
-- ============================================================================

-- 1. pgvector -----------------------------------------------------------------
-- gen_random_uuid() is core in PG13+ (Supabase is PG15+), so no pgcrypto.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- 2. Schema public: API roles may use it, but not create objects in it -------
revoke create on schema public from public, anon, authenticated;
grant  usage on schema public to service_role;

-- 3. create_tenant() (SECURITY INVOKER, runs as service_role) must be able to
--    CREATE the per-tenant partition table in public. Verified locally:
--    service_role does NOT have this by default (has_schema_privilege=false).
grant create on schema public to service_role;

-- 4. Default privileges: future objects created by `postgres` in `public` ----
--    `revoke all on tables` covers TRUNCATE/REFERENCES/TRIGGER too — a plain
--    `revoke select, insert, update, delete` (the Supabase docs snippet)
--    leaves TRUNCATE with anon/authenticated, which our audit would flag.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public
  grant  all on tables to service_role;
alter default privileges for role postgres in schema public
  grant  execute on functions to service_role;

-- Partitions created by service_role itself (the create_tenant() path) get
-- no default grants at all beyond the owner: service_role has no
-- alter-default-privileges entries of its own, so the PostgreSQL default
-- applies (owner=ALL, PUBLIC=NONE). The explicit REVOKEs inside
-- create_tenant() are belt-and-braces against platform defaults we do not
-- control.
