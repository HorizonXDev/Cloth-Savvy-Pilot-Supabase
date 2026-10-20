-- ============================================================================
-- 0003_products.sql  —  the partitioned products table (parent only).
--
-- PARTITION BY LIST (tenant_id), one physical partition per tenant, created
-- by create_tenant() later. NO DEFAULT partition on purpose: an insert for a
-- tenant without a partition fails with "no partition of relation found for
-- row" (23514) — there is no setting that can create a DEFAULT behind our
-- back. The PRIMARY KEY and UNIQUE constraint MUST include the partition key
-- (postgresql.org/docs/current/ddl-partitioning.html).
--
-- L2 on the parent AND (via create_tenant) on every partition:
-- ENABLED + FORCE RLS, zero policies, no privileges for PUBLIC/anon/auth.
--
-- L5 guard: the products_guard trigger checks every INSERT and UPDATE that
-- the row's embedding_model equals the tenant's model. Row-level triggers on
-- a partitioned table are CLONED onto every existing partition, and onto any
-- partition created later (postgresql.org/docs/current/sql-createtrigger.html)
-- — so partitions made by create_tenant() are covered automatically.
--
-- NO vector index yet (pilot scale: sequential scans per tenant partition).
-- Add HNSW later ONLY after measuring on real data; see README.
-- Idempotent: safe to re-run.
-- ============================================================================

-- 1. The embedding-model guard (L5) ------------------------------------------
create or replace function public.products_guard()
returns trigger
language plpgsql
set search_path = ''                 -- every reference below is schema-qualified
as $$
declare
  v_model text;
begin
  select t.embedding_model
    into v_model
    from public.tenants t
   where t.id = new.tenant_id;

  if v_model is null then
    raise exception
      'products: no tenant with id % — create it with create_tenant()',
      new.tenant_id
      using errcode = '23514';       -- check_violation; PostgREST maps 23xxx -> 400
  end if;

  if new.embedding_model is distinct from v_model then
    raise exception
      'products: embedding_model "%" does not match tenant model "%" (tenant %)',
      new.embedding_model, v_model, new.tenant_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- 2. updated_at maintenance ----------------------------------------------------
create or replace function public.products_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- 3. The partitioned parent ----------------------------------------------------
create table if not exists public.products (
  tenant_id       uuid not null,
  id              uuid not null default gen_random_uuid(),
  external_id     text not null,                        -- brand's own SKU/GID
  title           text not null,
  section         text not null,
  category        text,
  gender          text,
  colors          text[],
  price           numeric(12,2),
  in_stock        boolean default true,
  product_url     text,
  image_url       text,
  attributes      jsonb not null default '{}'::jsonb,
  embedding       extensions.vector(512),               -- nullable: not every row must be embedded yet
  embedding_model text not null,                        -- guarded against the tenant's model
  status          text not null default 'active',       -- 'active' | 'archived'
  source          text not null default 'manual',       -- 'manual' | 'csv' | 'shopify' | 'api'
  last_synced_at  timestamptz,
  image_hash      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, external_id),
  constraint products_section_allowed check (section in (
    'top', 'bottom', 'dress', 'saree', 'blouse', 'dupatta', 'outerwear',
    'footwear', 'bag', 'jewellery', 'accessory')),
  constraint products_status_valid    check (status in ('active', 'archived')),
  constraint products_source_valid    check (source in ('manual', 'csv', 'shopify', 'api'))
) partition by list (tenant_id);

-- Filtering/support indexes (propagate to every partition, existing and
-- future). No vector index yet — pilot scale does not need one.
create index if not exists products_tenant_section_idx
  on public.products (tenant_id, section);
create index if not exists products_tenant_in_stock_idx
  on public.products (tenant_id, in_stock);

-- 4. Triggers (cloned onto partitions, current and future) ---------------------
drop trigger if exists products_guard on public.products;
create trigger products_guard
  before insert or update on public.products
  for each row execute function public.products_guard();

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.products_set_updated_at();

-- 4b. Trigger functions: EXECUTE for service_role ONLY ------------------------
-- PostgreSQL grants EXECUTE to PUBLIC by default and Supabase's platform
-- defaults grant new functions to anon/authenticated — both would show up in
-- schema_audit() as offenders.
revoke all on function public.products_guard()
       from public, anon, authenticated;
grant  execute on function public.products_guard()
       to service_role;
revoke all on function public.products_set_updated_at()
       from public, anon, authenticated;
grant  execute on function public.products_set_updated_at()
       to service_role;

-- 5. Lockdown (L2) --------------------------------------------------------------
alter table public.products enable row level security;
alter table public.products force row level security;
revoke all on table public.products from public, anon, authenticated;
-- service_role: reads for search_products/explain, writes for ingestion.
grant select, insert, update, delete on table public.products to service_role;

-- 6. Hand the parent table to service_role ------------------------------------
-- create_tenant() is SECURITY INVOKER (design rule) and runs as service_role
-- via the Data API, but "CREATE TABLE ... PARTITION OF" requires being the
-- OWNER of the parent table — verified live: as service_role against a
-- postgres-owned parent it fails with "must be owner of table products".
-- service_role is the ONLY role allowed to call create_tenant()/drop_tenant(),
-- so the parent must belong to it. ALTER OWNER requires the executing role
-- to be a member of the new owner: locally postgres IS a member of
-- service_role (verified: pg_has_role = true) — on hosted this is UNVERIFIED;
-- if this line fails there, see README "Decisions" item 4b.
alter table public.products owner to service_role;

-- Let the Data API see the new table right away.
notify pgrst, 'reload schema';
