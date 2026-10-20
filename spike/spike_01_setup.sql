-- ============================================================================
-- spike_01_setup.sql  —  SPIKE ONLY, empty throwaway project.
--
-- Design under test: `products` PARTITIONED BY LIST (tenant_id), one physical
-- partition per tenant (brand). Isolation is supposed to hold because:
--   1. NO DEFAULT partition  -> insert for an unknown tenant FAILS.
--   2. ENABLE + FORCE RLS with NO policies on parent AND every partition
--      -> default deny (a query naming a child ignores the parent's policies,
--         so each partition must be locked on its own).
--   3. REVOKE ALL from PUBLIC, anon, authenticated on parent AND partitions
--      -> the Data API has nothing to expose for those roles.
--   4. PRIMARY KEY (tenant_id, id) and UNIQUE (tenant_id, external_id)
--      -> uniqueness is per tenant, which is also what partitioning forces.
--
-- Everything created here is prefixed `spike_` so spike_99_cleanup.sql can
-- remove exactly these objects and nothing else.
--
-- Run order:  spike_01_setup.sql -> spike_audit.sql -> spike_tests.py
--             -> spike_02_add_column.sql (test pauses for this) -> 99 cleanup.
--
-- Sources used for the decisions below (checked 2026-10-19):
--   * postgresql.org/docs/17/ddl-partitioning.html   (LIST partitioning,
--     unique/PK rules, "no partition of relation ... found for row",
--     ALTER on partitions, partition pruning)
--   * postgresql.org/docs/17/sql-createtrigger.html  (row triggers are cloned
--     onto every partition, existing and future)
--   * postgresql.org/docs/current/ddl-inherit.html   (child's own policies
--     apply when the child is named directly; parent policies then ignored)
--   * postgresql.org/docs/current/ddl-rowsecurity.html (RLS enabled + no
--     policies = default deny)
--   * supabase.com/docs/guides/database/extensions   (pgvector lives in the
--     `extensions` schema; write the type as extensions.vector)
--   * supabase.com/docs/guides/api/securing-your-api (platform default grants
--     on new public tables/functions; ALTER DEFAULT PRIVILEGES recipe)
-- ============================================================================

-- 0. pgvector -----------------------------------------------------------------
-- Supabase ships the `extensions` schema on cloud and locally; the CREATE
-- SCHEMA is a no-op guard. gen_random_uuid() is core in PG13+ (Supabase is
-- PG15+), so no pgcrypto is needed.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- 1. spike_tenants ------------------------------------------------------------
-- Locked down like the products table: the Data API must not list tenants.
create table if not exists public.spike_tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  embedding_model text not null,
  embedding_dim   int  not null
);

alter table public.spike_tenants enable row level security;
alter table public.spike_tenants force row level security;
-- No policies on purpose -> default deny for everyone, owner included.
revoke all on table public.spike_tenants from public, anon, authenticated;
-- spike_search (SECURITY INVOKER) needs to read the tenant table.
grant select on table public.spike_tenants to service_role;

-- 2. spike_products (partitioned parent) --------------------------------------
-- The PRIMARY KEY and the UNIQUE constraint MUST include the partition key:
--   "To create a unique or primary key constraint on a partitioned table, the
--    partition keys must not include any expressions or function calls and the
--    constraint's columns must include all of the partition key columns."
--   (postgresql.org/docs/17/ddl-partitioning.html#DDL-PARTITIONING-DECLARATIVE-LIMITATIONS)
create table if not exists public.spike_products (
  tenant_id       uuid not null,
  id              uuid not null default gen_random_uuid(),
  external_id     text not null,
  title           text,
  section         text,
  colors          text[],
  price           numeric(12,2),
  in_stock        boolean default true,
  attributes      jsonb not null default '{}'::jsonb,
  embedding       extensions.vector(512),   -- no index on purpose (see risks)
  embedding_model text not null,
  status          text not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, external_id)
) partition by list (tenant_id);

-- NOTE: no DEFAULT partition, deliberately. An insert for a tenant that has
-- no partition fails with `no partition of relation "spike_products" found
-- for row` (SQLSTATE 23514, text+code verified in PG source, not in the docs
-- page — the docs page itself only states that the row matches no partition).
-- That guarantee holds simply because DEFAULT is never declared; there is no
-- setting that can create one behind our back.

alter table public.spike_products enable row level security;
alter table public.spike_products force row level security;
-- ENABLE + FORCE + zero policies = default deny even for the table owner:
--   "If no policy exists for the table, a default-deny policy is used, meaning
--    that no rows are visible or can be modified." (docs, Row Security Policies)
revoke all on table public.spike_products from public, anon, authenticated;
-- service_role needs SELECT (spike_search, audit) and DML (the tests insert
-- through the parent on purpose: that is the writer path we are testing).
grant select, insert, update, delete on table public.spike_products to service_role;

-- 3. Default privileges for FUTURE partitions ---------------------------------
-- Supabase's platform defaults grant SELECT/INSERT/UPDATE/DELETE on new
-- tables in `public` to anon, authenticated AND service_role, and EXECUTE on
-- new functions (supabase.com/docs/guides/api/securing-your-api). A new
-- PARTITION is a new table, so it would be auto-granted to anon/authenticated.
-- These two statements stop that for every FUTURE object created by `postgres`
-- in `public`. They are the only project-wide (non spike_) change in the spike;
-- spike_99_cleanup.sql deliberately does not touch them — see README.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public;
-- service_role's future grants are left alone on purpose: S6 reads a partition
-- directly with the service key, and spike_search runs as service_role.

-- 4. Guard trigger: embedding_model must match the tenant's model -----------
-- Question asked by the spike: does a per-row trigger on the PARENT work when
-- the table is partitioned? YES, per current docs:
--   "Creating a row-level trigger on a partitioned table will cause an
--    identical 'clone' trigger to be created on each of its existing
--    partitions; and any partitions created or attached later will have an
--    identical trigger, too."  (postgresql.org/docs/17/sql-createtrigger.html)
-- So the parent trigger covers partitions created later by
-- spike_create_tenant with no extra work. (Two related limits from the same
-- page: row triggers on partitioned tables may not be INSTEAD OF, and a
-- BEFORE ROW trigger cannot change the final partition destination. Neither
-- matters here.)
create or replace function public.spike_products_guard()
returns trigger
language plpgsql
set search_path = ''      -- every reference below is schema-qualified
as $$
declare
  v_model text;
begin
  select t.embedding_model
    into v_model
    from public.spike_tenants t
   where t.id = new.tenant_id;

  if v_model is null then
    raise exception
      'spike_products: no tenant with id % — create it with spike_create_tenant()',
      new.tenant_id
      using errcode = '23514';   -- check_violation; PostgREST maps 23xxx -> 400
  end if;

  if new.embedding_model is distinct from v_model then
    raise exception
      'spike_products: embedding_model "%" does not match tenant model "%" (tenant %)',
      new.embedding_model, v_model, new.tenant_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists spike_products_guard on public.spike_products;
create trigger spike_products_guard
  before insert on public.spike_products
  for each row execute function public.spike_products_guard();

-- 5. spike_create_tenant(slug, model, dim) -> uuid ---------------------------
-- SECURITY DEFINER because it must run DDL (CREATE TABLE ... PARTITION OF,
-- ALTER TABLE, REVOKE). It is executable by service_role ONLY, so the only
-- way to create a tenant is this validated path.
create or replace function public.spike_create_tenant(
  p_slug  text,
  p_model text,
  p_dim   int
)
returns uuid
language plpgsql
security definer
set search_path = ''       -- nothing is resolved from the search path
as $$
declare
  v_id        uuid := gen_random_uuid();
  v_partition text;
begin
  -- ---- validate BEFORE any dynamic SQL is built ---------------------------
  if p_slug is null or p_slug !~ '^[a-z0-9_]+$' then
    raise exception 'spike_create_tenant: slug % does not match ^[a-z0-9_]+$', p_slug
      using errcode = '22023';
  end if;
  -- Identifiers cap at 63 bytes: a longer slug would be silently truncated
  -- and could collide with another tenant's partition name.
  if length(p_slug) > 40 then
    raise exception 'spike_create_tenant: slug too long (% chars, max 40)', length(p_slug)
      using errcode = '22023';
  end if;
  if p_model is null or btrim(p_model) = '' then
    raise exception 'spike_create_tenant: p_model must not be empty'
      using errcode = '22023';
  end if;
  -- The column is fixed at vector(512) in this spike, so refuse other dims
  -- instead of storing a lie in spike_tenants.embedding_dim.
  if p_dim is distinct from 512 then
    raise exception 'spike_create_tenant: this spike fixes the column at vector(512), got %', p_dim
      using errcode = '22023';
  end if;
  if exists (select 1 from public.spike_tenants t where t.slug = p_slug) then
    raise exception 'spike_create_tenant: slug % already exists', p_slug
      using errcode = '23505';
  end if;

  v_partition := 'spike_products_' || p_slug;

  -- Atomic: if the partition DDL fails, the tenant row is rolled back too
  -- (plpgsql runs this block as a subtransaction).
  begin
    insert into public.spike_tenants (id, slug, embedding_model, embedding_dim)
    values (v_id, p_slug, p_model, p_dim);

    -- %I quotes the identifier, %L quotes the literal. No string concatenation
    -- of user input anywhere.
    execute format(
      'create table public.%I partition of public.spike_products for values in (%L)',
      v_partition, v_id
    );

    -- Lock the partition exactly like the parent. Partitions are separate
    -- tables and the parent's RLS/policies do not protect a direct query.
    execute format('alter table public.%I enable row level security',  v_partition);
    execute format('alter table public.%I force row level security',   v_partition);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_partition);
    -- Normally a no-op (the default privileges above skip anon/authenticated
    -- and Supabase's defaults grant service_role). Made explicit so S6 does
    -- not depend on platform defaults we do not control.
    execute format(
      'grant select, insert, update, delete on table public.%I to service_role',
      v_partition
    );
  exception when others then
    raise;   -- re-raise after the subtransaction rolled everything back
  end;

  -- Ask PostgREST to refresh its schema cache so /rest/v1/<partition> works
  -- immediately. Harmless no-op if nothing listens for it.
  notify pgrst, 'reload schema';

  return v_id;
end;
$$;

-- 6. spike_drop_tenant(tenant_id) --------------------------------------------
create or replace function public.spike_drop_tenant(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug      text;
  v_partition text;
begin
  if p_tenant_id is null then
    raise exception 'spike_drop_tenant: p_tenant_id must not be null'
      using errcode = '22004';
  end if;

  select t.slug into v_slug from public.spike_tenants t where t.id = p_tenant_id;
  if v_slug is null then
    raise exception 'spike_drop_tenant: no tenant with id %', p_tenant_id
      using errcode = 'P0002';
  end if;

  v_partition := 'spike_products_' || v_slug;

  begin
    -- Dropping a partition directly is allowed and leaves the parent and every
    -- other partition untouched. (ATTACH/DETACH are operations on the parent;
    -- see the risks list in the README about ALTER on partitions.)
    execute format('drop table if exists public.%I', v_partition);
    delete from public.spike_tenants t where t.id = p_tenant_id;
  exception when others then
    raise;
  end;

  notify pgrst, 'reload schema';
end;
$$;

-- 7. spike_search(tenant_id, query, limit) -----------------------------------
-- SECURITY INVOKER on purpose: it runs with the caller's privileges, so the
-- only caller that can read anything is service_role (which bypasses RLS).
-- The tenant filter is on the partition key, which is also what lets the
-- planner prune every other partition away (see spike_explain_search, S12).
create or replace function public.spike_search(
  p_tenant_id uuid,
  p_query     extensions.vector(512),
  p_limit     int default 10
)
returns table (
  id          uuid,
  external_id text,
  title       text,
  similarity  double precision
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  -- default 10 when null/negative, hard cap 50
  v_limit int := least(greatest(coalesce(p_limit, 10), 1), 50);
begin
  if p_tenant_id is null then
    raise exception 'spike_search: p_tenant_id must not be null'
      using errcode = '22004';
  end if;
  if not exists (select 1 from public.spike_tenants t where t.id = p_tenant_id) then
    raise exception 'spike_search: no tenant with id %', p_tenant_id
      using errcode = 'P0002';
  end if;

  return query
  select p.id,
         p.external_id,
         p.title,
         1 - (p.embedding OPERATOR(extensions.<=>) p_query) as similarity
    from public.spike_products p
   where p.tenant_id = p_tenant_id        -- strict filter on the partition key
   order by p.embedding OPERATOR(extensions.<=>) p_query
   limit v_limit;
  -- OPERATOR(extensions.<=>) is spelled out because search_path is '': the
  -- distance operator lives in the schema the extension was installed into.
end;
$$;

-- 8. spike_explain_search(tenant_id, query) ----------------------------------
-- S12 needs the actual plan of the search, and plans cannot be fetched over
-- the Data API any other way, so the spike ships this read-only helper.
-- It EXPLAIN ANALYZEs the exact SELECT that spike_search runs.
-- VOLATILE is REQUIRED: PostgreSQL rejects EXPLAIN inside a STABLE/IMMUTABLE
-- function with "EXPLAIN is not allowed in a non-volatile function" (seen
-- live on PG17 — an earlier `stable` marking made S12 fail with exactly that
-- error). If it ever fails on your build anyway, run the manual query in
-- README "S12 fallback" instead.
create or replace function public.spike_explain_search(
  p_tenant_id uuid,
  p_query     extensions.vector(512)
)
returns setof text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_tenant_id is null then
    raise exception 'spike_explain_search: p_tenant_id must not be null'
      using errcode = '22004';
  end if;

  return query
  execute $q$
    explain (analyze, format text)
    select p.id,
           p.external_id,
           p.title,
           1 - (p.embedding OPERATOR(extensions.<=>) $2) as similarity
      from public.spike_products p
     where p.tenant_id = $1
     order by p.embedding OPERATOR(extensions.<=>) $2
     limit 10
  $q$
  using p_tenant_id, p_query;
end;
$$;

-- 9. Privileges on the functions ---------------------------------------------
-- PostgreSQL grants EXECUTE to PUBLIC on functions by default, and Supabase's
-- platform defaults also grant EXECUTE on new functions to anon/authenticated.
-- Every spike_ function must be callable by service_role ONLY.
revoke all on function public.spike_products_guard()        from public, anon, authenticated;
grant  execute on function public.spike_products_guard()    to service_role;
revoke all on function public.spike_create_tenant(text, text, int) from public, anon, authenticated;
grant  execute on function public.spike_create_tenant(text, text, int) to service_role;
revoke all on function public.spike_drop_tenant(uuid)        from public, anon, authenticated;
grant  execute on function public.spike_drop_tenant(uuid)    to service_role;
revoke all on function public.spike_search(uuid, extensions.vector(512), int)
       from public, anon, authenticated;
grant  execute on function public.spike_search(uuid, extensions.vector(512), int)
       to service_role;
revoke all on function public.spike_explain_search(uuid, extensions.vector(512))
       from public, anon, authenticated;
grant  execute on function public.spike_explain_search(uuid, extensions.vector(512))
       to service_role;

-- 10. Kick PostgREST so the Data API sees the new objects right away.
-- PostgREST caches the schema and only refreshes when notified; without this
-- line, /rest/v1/spike_* keeps answering 404 "... not in the schema cache"
-- until Studio's "Reload schema" button or a restart happens to fire.
-- (Also emitted by spike_create_tenant / spike_drop_tenant after DDL.)
notify pgrst, 'reload schema';

-- Done. Next: spike_audit.sql, then python spike_tests.py.
