-- ============================================================================
-- 0008_catalog_facets.sql  —  read helpers the combos endpoint needs.
--
-- Adds two functions, NO tables (nothing new for schema_audit's table rules;
-- the generic function rules pick both functions up automatically — run
-- schema_audit() after applying and both must show empty `offenders`):
--
--   catalog_facets(p_tenant_id)
--     -> per section: the distinct categories and a capped list of the most
--        common colours of that tenant's ACTIVE, IN-STOCK products. The LLM
--        prompt uses this so generated descriptions only mention vocabulary
--        the brand actually sells (port of the consumer blueprints'
--        excludeLabels intent, re-expressed over pilot sections).
--     -> SECURITY INVOKER, search_path = '', EXECUTE service_role ONLY,
--        NULL tenant raises (22004). Always returns ALL 11 sections (empty
--        arrays when the tenant stocks nothing in one) so callers can map
--        by section without existence checks.
--
--   product_by_external_id(p_tenant_id, p_external_id)
--     -> exact-catalogue lookup for the combos `base_external_id` anchor.
--        Zero rows when not found (caller continues WITHOUT an anchor).
--        Only status='active' rows; row shape mirrors search_products minus
--        `similarity` (no vector matched — callers must not invent one).
--
-- Both keep the lockdown: no anon/authenticated EXECUTE, service_role only.
-- Idempotent: CREATE OR REPLACE everywhere.
-- ============================================================================

create or replace function public.catalog_facets(p_tenant_id uuid)
returns table (
  section    text,
  categories text[],
  colors     text[]
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_section   text;
  v_cats      text[];
  v_colors    text[];
  -- Same list as products.section CHECK (0003) and search_products (0007).
  v_sections constant text[] := array[
    'top','bottom','dress','saree','blouse','dupatta','outerwear',
    'footwear','bag','jewellery','accessory'
  ];
begin
  if p_tenant_id is null then
    raise exception 'catalog_facets: p_tenant_id must not be null'
      using errcode = '22004';
  end if;

  foreach v_section in array v_sections loop
    -- Categories: distinct, non-null, deterministic order, capped at 20.
    select coalesce(array_agg(t.c order by t.c), '{}')
      into v_cats
      from (
        select distinct p.category as c
          from public.products p
         where p.tenant_id = p_tenant_id
           and p.section = v_section
           and p.status = 'active'
           and p.in_stock is distinct from false
           and p.category is not null
         order by p.category
         limit 20
      ) t;

    -- Colours: distinct unnested values, most frequent first, capped at 24.
    select coalesce(array_agg(t.color order by t.cnt desc, t.color), '{}')
      into v_colors
      from (
        select unnest(p.colors) as color, count(*) as cnt
          from public.products p
         where p.tenant_id = p_tenant_id
           and p.section = v_section
           and p.status = 'active'
           and p.in_stock is distinct from false
           and p.colors is not null
         group by 1
         order by count(*) desc, 1
         limit 24
      ) t;

    section    := v_section;
    categories := v_cats;
    colors     := v_colors;
    return next;
  end loop;
end;
$$;

revoke all on function public.catalog_facets(uuid)
       from public, anon, authenticated;
grant  execute on function public.catalog_facets(uuid)
       to service_role;

create or replace function public.product_by_external_id(
  p_tenant_id   uuid,
  p_external_id text
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
  attributes  jsonb
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_tenant_id is null then
    raise exception 'product_by_external_id: p_tenant_id must not be null'
      using errcode = '22004';
  end if;
  if p_external_id is null or btrim(p_external_id) = '' then
    raise exception 'product_by_external_id: p_external_id must not be empty'
      using errcode = '22004';
  end if;

  return query
  select p.id, p.external_id, p.title, p.section, p.category, p.colors,
         p.price, p.in_stock, p.product_url, p.image_url, p.attributes
    from public.products p
   where p.tenant_id = p_tenant_id          -- partition-key predicate
     and p.external_id = p_external_id
     and p.status = 'active'
   limit 1;
end;
$$;

revoke all on function public.product_by_external_id(uuid, text)
       from public, anon, authenticated;
grant  execute on function public.product_by_external_id(uuid, text)
       to service_role;

-- PostgREST only learns about new functions when told.
notify pgrst, 'reload schema';
