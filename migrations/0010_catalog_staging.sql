-- ============================================================================
-- 0010_catalog_staging.sql  —  the tenant's import queue: rows a TENANT
-- uploaded in the portal that are waiting for the owner's embedding pipeline.
--
-- Ownership decision (2026-10-26): catalog MUTATION belongs to the tenant —
-- upload / edit / archive / delete all happen in the tenant portal. The owner
-- never hand-edits a catalogue; their step starts when rows land here:
--
--     tenant uploads CSV  ->  catalog_staging (pending, NO vector)
--     owner downloads the id->url table (admin ?op=embed_export)
--                         ->  runs FashionCLIP over the IMAGES (their Colab)
--                         ->  uploads the generated file to the admin
--                             dashboard, applied BY ID (?op=embeddings_merge)
--                         ->  products, row marked merged
--   Text (title / category / colours / section / price) is FILTERING ONLY —
--   it is never embedded. Search embeds the shopper's QUERY (CLIP text
--   tower), which shares the joint space with those image vectors.
--
-- Why a staging table and not `products` directly:
--   * products.embedding_model is guarded and every row must belong to the
--     tenant's single vector space — a row inserted before the encoder has
--     spoken would be unsearchable garbage sitting in the live partition.
--   * the tenant may EDIT or DELETE a staged row before it merges; that has
--     to be possible without touching live search results.
--   * a failed merge must leave a reason the tenant can actually see.
--
-- Schema_audit compliance (same rules as every public table): RLS enabled
-- AND forced, anon/authenticated hold ZERO privileges, service_role holds
-- normal DML, and the table carries tenant_id.
--
-- drop_tenant(): FK is ON DELETE CASCADE, so dropping a tenant removes its
-- staged rows with it (RI cascades need no DELETE grant here — same argument
-- proven for usage_events in 0005 and tenant_users in 0009). drop_tenant()
-- needs NO change.
--
-- Status lifecycle (app-enforced, CHECK-enforced where it is cheap):
--   pending  -> waiting for the pipeline (the only state the tenant edits)
--   merged   -> embedded + inserted into products (product_id records which)
--   failed   -> the pipeline tried and could not: `error` says why, tenant
--               may fix the row (back to pending) or delete it
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.catalog_staging (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  external_id  text not null,
  -- the normalized import row exactly as the portal validated it:
  -- {title, section, category, gender, colors[], price, in_stock,
  --  product_url, image_url}
  payload      jsonb not null,
  status       text not null default 'pending',
  error        text,
  source_file  text,                            -- the filename the tenant picked
  -- audit link only: deliberately NOT a foreign key, because drop_tenant()
  -- deletes ingestion_runs explicitly and a FK here would refuse that. If the
  -- run goes away, the staged row keeps its own timestamps.
  run_id       uuid,
  product_id   uuid,                           -- filled on merge (products.id)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  merged_at    timestamptz,
  constraint catalog_staging_status_valid
    check (status in ('pending', 'merged', 'failed')),
  -- keep the payload honest: every staged row must carry the three fields
  -- the API requires, so an invalid row can never enter the queue at all
  constraint catalog_staging_required_fields
    check (
      coalesce(payload ->> 'title', '') <> ''
      and coalesce(payload ->> 'section', '') <> ''
      and coalesce(payload ->> 'external_id', '') <> ''
    )
);

-- a tenant cannot stage the same SKU twice while it is still pending;
-- once merged the products.unique(tenant_id, external_id) takes over
create unique index if not exists catalog_staging_pending_uniq
  on public.catalog_staging (tenant_id, external_id)
  where status = 'pending';

create index if not exists catalog_staging_tenant_status_idx
  on public.catalog_staging (tenant_id, status, created_at desc);

alter table public.catalog_staging enable row level security;
alter table public.catalog_staging force row level security;
revoke all on table public.catalog_staging from public, anon, authenticated;
grant select, insert, update, delete on table public.catalog_staging to service_role;

-- Edge Functions read and write it through the service-role client only —
-- nothing here is reachable from the Data API by anon/authenticated, exactly
-- like products/ingestion_runs/tenant_users.
notify pgrst, 'reload schema';
