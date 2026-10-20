-- ============================================================================
-- 0007_functions.sql  —  the ONLY way the API layer may touch tenant data.
--
-- All functions: SECURITY INVOKER (they run with the caller's privileges —
-- the only caller is service_role via the Data API), explicit
-- search_path = '' (nothing resolves from a search path), EXECUTE granted to
-- service_role ONLY. Error codes chosen so PostgREST answers sensibly:
--   22004 (null_value_not_allowed)  -> 400  a required argument was NULL
--   22023 (invalid_parameter_value) -> 400  bad argument value
--   23514 (check_violation)         -> 400  model guard / embedding mismatch
--   23505 (unique_violation)        -> 409  duplicate slug
--   P0001 (raise_exception default) -> 400  "no tenant with id ..."
--
-- Consequence of the INVOKER design (see README "Decisions"): whoever calls
-- create_tenant()/drop_tenant() must OWN the partition they create/drop
-- (DROP TABLE requires ownership). The tests always call both through the
-- service key, so service_role owns every partition. Create and drop a
-- tenant with the SAME role.
-- Idempotent where reasonable: CREATE OR REPLACE for every function.
-- ============================================================================

-- 1. create_tenant(...) -> uuid ----------------------------------------------
-- Inserts the tenant row, creates partition products_<slug> FOR VALUES IN
-- (<tenant id>), locks the partition down (RLS enabled+forced, no
-- privileges for PUBLIC/anon/authenticated, DML for service_role), and asks
-- PostgREST to refresh its schema cache. The embedding-model guard and
-- updated_at triggers live on the PARENT (migration 0003) and are cloned
-- onto new partitions automatically by PostgreSQL.
create or replace function public.create_tenant(
  p_slug            text,
  p_name            text,
  p_embedding_model text,
  p_embedding_dim   int,
  p_website_url     text default null,
  p_settings        jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id        uuid := gen_random_uuid();
  v_partition text;
begin
  -- ---- validate BEFORE any dynamic SQL is built ---------------------------
  if p_slug is null or p_slug !~ '^[a-z0-9_]+$' then
    raise exception 'create_tenant: slug % does not match ^[a-z0-9_]+$', p_slug
      using errcode = '22023';
  end if;
  -- Identifiers cap at 63 bytes: 'products_' + slug must fit or the name
  -- would be silently truncated and could collide with another tenant.
  if length(p_slug) > 40 then
    raise exception 'create_tenant: slug too long (% chars, max 40)', length(p_slug)
      using errcode = '22023';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'create_tenant: p_name must not be empty'
      using errcode = '22023';
  end if;
  if p_embedding_model is null or btrim(p_embedding_model) = '' then
    raise exception 'create_tenant: p_embedding_model must not be empty'
      using errcode = '22023';
  end if;
  -- The products.embedding column is fixed at vector(512); refuse other dims
  -- instead of storing a lie in tenants.embedding_dim.
  if p_embedding_dim is distinct from 512 then
    raise exception
      'create_tenant: products.embedding is fixed at vector(512), got dim %',
      p_embedding_dim
      using errcode = '22023';
  end if;
  if exists (select 1 from public.tenants t where t.slug = p_slug) then
    raise exception 'create_tenant: slug % already exists', p_slug
      using errcode = '23505';
  end if;

  v_partition := 'products_' || p_slug;

  -- Atomic: if the partition DDL fails, the tenant row rolls back too
  -- (plpgsql runs this block as a subtransaction).
  begin
    insert into public.tenants
      (id, slug, name, website_url, embedding_model, embedding_dim, settings)
    values
      (v_id, p_slug, p_name, p_website_url, p_embedding_model, p_embedding_dim,
       coalesce(p_settings, '{}'::jsonb));

    -- %I quotes the identifier, %L quotes the literal. No string
    -- concatenation of user input anywhere. Slug was validated above.
    execute format(
      'create table public.%I partition of public.products for values in (%L)',
      v_partition, v_id
    );

    -- Lock the partition exactly like the parent: partitions are separate
    -- tables and the parent's RLS does not protect a direct query.
    execute format('alter table public.%I enable row level security',  v_partition);
    execute format('alter table public.%I force row level security',   v_partition);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_partition);
    -- Explicit grant so behaviour does not depend on platform defaults.
    execute format(
      'grant select, insert, update, delete on table public.%I to service_role',
      v_partition
    );
  exception when others then
    raise;   -- re-raise after the subtransaction rolled everything back
  end;

  notify pgrst, 'reload schema';

  return v_id;
end;
$$;

-- 2. drop_tenant(tenant_id, confirm_slug) -> void -----------------------------
-- Refuses unless p_confirm_slug EXACTLY equals the tenant's slug AND the
-- tenant's status is 'suspended' (two independent brakes on an accident).
-- Removal order — deliberately partition FIRST: if the partition cannot be
-- dropped (e.g. another role created it and owns it), nothing else has been
-- touched yet.
--   1. drop the partition (products_<slug>),
--   2. delete the tenant's ingestion_runs rows (explicit; service_role has
--      DELETE on that table),
--   3. delete the tenant's api_keys rows (explicit) — the usage_events FK
--      (tenant_id, key_id) ... ON DELETE CASCADE then removes that tenant's
--      usage events. RI cascades run with internal privileges and do NOT
--      need the acting role to hold DELETE on usage_events, so usage_events
--      stays append-only for direct DML while a tenant drop still completes.
--   4. delete the tenants row (plain FK from api_keys is already clear).
create or replace function public.drop_tenant(
  p_tenant_id   uuid,
  p_confirm_slug text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_slug      text;
  v_status    text;
  v_partition text;
begin
  if p_tenant_id is null or p_confirm_slug is null then
    raise exception 'drop_tenant: p_tenant_id and p_confirm_slug must not be null'
      using errcode = '22004';
  end if;

  select t.slug, t.status
    into v_slug, v_status
    from public.tenants t
   where t.id = p_tenant_id;

  if v_slug is null then
    raise exception 'drop_tenant: no tenant with id %', p_tenant_id
      using errcode = 'P0001';
  end if;
  if v_slug <> p_confirm_slug then
    raise exception 'drop_tenant: confirm slug mismatch (expected the tenant''s exact slug)'
      using errcode = '22023';
  end if;
  if v_status <> 'suspended' then
    raise exception
      'drop_tenant: tenant % is "%" — only suspended tenants can be dropped',
      v_slug, v_status
      using errcode = '22023';
  end if;

  v_partition := 'products_' || v_slug;

  begin
    execute format('drop table if exists public.%I', v_partition);
    delete from public.ingestion_runs i where i.tenant_id = p_tenant_id;
    delete from public.api_keys      k where k.tenant_id = p_tenant_id;
    delete from public.tenants       t where t.id        = p_tenant_id;
  exception when others then
    raise;
  end;

  notify pgrst, 'reload schema';
end;
$$;

-- 3. resolve_api_key(key_hash) -> (tenant_id, key_id, environment, status) ---
-- L1 anchor: the API layer hashes the presented key and asks THIS function
-- which tenant it belongs to. The tenant is never taken from a request body.
-- Returns a row only for an unrevoked key of an ACTIVE tenant; updates
-- last_used_at on success; returns ZERO rows otherwise (callers map that to
-- 401).
create or replace function public.resolve_api_key(p_key_hash text)
returns table (
  tenant_id     uuid,
  key_id        uuid,
  environment   text,
  tenant_status text
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_key_hash is null or btrim(p_key_hash) = '' then
    raise exception 'resolve_api_key: p_key_hash must not be empty'
      using errcode = '22004';
  end if;

  update public.api_keys k
     set last_used_at = now()
   where k.key_hash = p_key_hash
     and k.revoked_at is null
     and exists (select 1 from public.tenants t
                  where t.id = k.tenant_id and t.status = 'active');

  return query
  select t.id, k.id, k.environment, t.status
    from public.api_keys k
    join public.tenants t on t.id = k.tenant_id
   where k.key_hash = p_key_hash
     and k.revoked_at is null
     and t.status = 'active';
end;
$$;

-- 4. create_api_key(...) -> uuid ----------------------------------------------
-- Stores ONLY the SHA-256 hash (64 lowercase hex chars, enforced by CHECK on
-- the table and validated here) plus a display prefix — never a plaintext
-- key.
create or replace function public.create_api_key(
  p_tenant_id   uuid,
  p_key_hash    text,
  p_key_prefix  text,
  p_environment text,
  p_label       text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_tenant_id is null then
    raise exception 'create_api_key: p_tenant_id must not be null'
      using errcode = '22004';
  end if;
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception
      'create_api_key: p_key_hash must be the SHA-256 hex of the full key (64 lowercase hex chars)'
      using errcode = '22023';
  end if;
  if p_environment is null or p_environment not in ('live', 'sandbox') then
    raise exception 'create_api_key: p_environment must be "live" or "sandbox"'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'create_api_key: no tenant with id %', p_tenant_id
      using errcode = 'P0001';
  end if;

  insert into public.api_keys
    (tenant_id, key_hash, key_prefix, environment, label)
  values
    (p_tenant_id, p_key_hash, p_key_prefix, p_environment, p_label)
  returning id into v_id;

  return v_id;
end;
$$;

-- 5. search_products(...) -> setof row ----------------------------------------
-- The ONLY read path for product data (L3). The tenant is a required
-- argument and every predicate filters on it; the plan prunes every other
-- partition away (confirmed by explain_search_products). Raises on a NULL or
-- nonexistent tenant and on an embedding-model mismatch (L5). Only
-- status='active' rows can come back. Similarity = 1 - (embedding <=>
-- query); the caller's p_min_similarity is applied INSIDE the query so a
-- "no good match" honestly returns ZERO rows; limit capped at 50.
create or replace function public.search_products(
  p_tenant_id       uuid,
  p_query           extensions.vector(512),
  p_embedding_model text,
  p_section         text   default null,
  p_limit           int    default 10,
  p_min_similarity  float  default null,
  p_in_stock_only   boolean default true,
  p_max_price       numeric default null,
  p_colors          text[] default null
)
returns table (
  id          uuid,
  external_id text,
  title       text,
  section     text,
  category    text,
  colors      text[],
  price       numeric,
  in_stock    boolean,
  product_url text,
  image_url   text,
  attributes  jsonb,
  similarity  double precision
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_model text;
  -- default 10, floor 1, hard cap 50
  v_limit int    := least(greatest(coalesce(p_limit, 10), 1), 50);
  -- No caller threshold -> only exclude genuinely opposite vectors
  -- (cosine distance > 1, i.e. similarity < 0) and rows without an
  -- embedding (their distance is NULL).
  v_min   double precision := coalesce(p_min_similarity, 0.0);
begin
  if p_tenant_id is null then
    raise exception 'search_products: p_tenant_id must not be null'
      using errcode = '22004';
  end if;
  if p_query is null then
    raise exception 'search_products: p_query must not be null'
      using errcode = '22004';
  end if;
  if p_embedding_model is null or btrim(p_embedding_model) = '' then
    raise exception 'search_products: p_embedding_model must not be empty'
      using errcode = '22004';
  end if;
  if p_section is not null and p_section not in (
       'top', 'bottom', 'dress', 'saree', 'blouse', 'dupatta', 'outerwear',
       'footwear', 'bag', 'jewellery', 'accessory') then
    raise exception 'search_products: invalid section "%"', p_section
      using errcode = '22023';
  end if;

  select t.embedding_model
    into v_model
    from public.tenants t
   where t.id = p_tenant_id;
  if v_model is null then
    raise exception 'search_products: no tenant with id %', p_tenant_id
      using errcode = 'P0001';
  end if;
  if v_model <> p_embedding_model then
    raise exception
      'search_products: embedding model mismatch: tenant uses "%", query sent "%"',
      v_model, p_embedding_model
      using errcode = '23514';
  end if;

  return query
  select p.id,
         p.external_id,
         p.title,
         p.section,
         p.category,
         p.colors,
         p.price,
         p.in_stock,
         p.product_url,
         p.image_url,
         p.attributes,
         1 - (p.embedding OPERATOR(extensions.<=>) p_query) as similarity
    from public.products p
   where p.tenant_id = p_tenant_id          -- strict filter on the partition key
     and p.status = 'active'
     and p.embedding_model = p_embedding_model
     and (p_section is null or p.section = p_section)
     and (not p_in_stock_only or p.in_stock)
     and (p_max_price is null or p.price is null or p.price <= p_max_price)
     and (p_colors is null or p.colors && p_colors)   -- ANY colour match
     and (1 - (p.embedding OPERATOR(extensions.<=>) p_query)) >= v_min
   order by p.embedding OPERATOR(extensions.<=>) p_query
   limit v_limit;
  -- OPERATOR(extensions.<=>) is spelled out because search_path is '': the
  -- distance operator lives in the schema the extension was installed into.
end;
$$;

-- 6. explain_search_products(...) -> setof text --------------------------------
-- Test/ops helper: EXPLAIN ANALYZEs the same scan search_products runs, so
-- a caller can confirm partition pruning (T11). VOLATILE is REQUIRED:
-- PostgreSQL rejects EXPLAIN inside a STABLE/IMMUTABLE function ("EXPLAIN is
-- not allowed in a non-volatile function" — seen live during the spike).
create or replace function public.explain_search_products(
  p_tenant_id       uuid,
  p_query           extensions.vector(512),
  p_embedding_model text
)
returns setof text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_model text;
begin
  if p_tenant_id is null or p_query is null or p_embedding_model is null then
    raise exception 'explain_search_products: arguments must not be null'
      using errcode = '22004';
  end if;

  select t.embedding_model
    into v_model
    from public.tenants t
   where t.id = p_tenant_id;
  if v_model is null then
    raise exception 'explain_search_products: no tenant with id %', p_tenant_id
      using errcode = 'P0001';
  end if;
  if v_model <> p_embedding_model then
    raise exception
      'explain_search_products: embedding model mismatch: tenant uses "%", query sent "%"',
      v_model, p_embedding_model
      using errcode = '23514';
  end if;

  return query
  execute $q$
    explain (analyze, format text)
    select p.id
      from public.products p
     where p.tenant_id = $1
       and p.status = 'active'
       and p.embedding_model = $3
     order by p.embedding OPERATOR(extensions.<=>) $2
     limit 10
  $q$
  using p_tenant_id, p_query, p_embedding_model;
end;
$$;

-- 7. Privileges: service_role ONLY ---------------------------------------------
-- PostgreSQL grants EXECUTE to PUBLIC on functions by default, and Supabase's
-- platform defaults also grant EXECUTE on new functions to
-- anon/authenticated. Every function here must be callable by service_role
-- ONLY (L3: no anonymous path to tenant data).
revoke all on function public.create_tenant(text, text, text, int, text, jsonb)
       from public, anon, authenticated;
grant  execute on function public.create_tenant(text, text, text, int, text, jsonb)
       to service_role;

revoke all on function public.drop_tenant(uuid, text)
       from public, anon, authenticated;
grant  execute on function public.drop_tenant(uuid, text)
       to service_role;

revoke all on function public.resolve_api_key(text)
       from public, anon, authenticated;
grant  execute on function public.resolve_api_key(text)
       to service_role;

revoke all on function public.create_api_key(uuid, text, text, text, text)
       from public, anon, authenticated;
grant  execute on function public.create_api_key(uuid, text, text, text, text)
       to service_role;

revoke all on function public.search_products(uuid, extensions.vector(512), text, text, int, float, boolean, numeric, text[])
       from public, anon, authenticated;
grant  execute on function public.search_products(uuid, extensions.vector(512), text, text, int, float, boolean, numeric, text[])
       to service_role;

revoke all on function public.explain_search_products(uuid, extensions.vector(512), text)
       from public, anon, authenticated;
grant  execute on function public.explain_search_products(uuid, extensions.vector(512), text)
       to service_role;

-- 8. PostgREST only learns about new functions when told -----------------------
notify pgrst, 'reload schema';
