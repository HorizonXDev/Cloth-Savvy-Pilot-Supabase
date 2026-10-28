-- ============================================================================
-- 0011_needs_reembed.sql  —  image vectors are the only catalog vectors.
--
-- Decision (2026-10-26, owner): a product's embedding comes from its IMAGE,
-- produced offline by the owner's FashionCLIP pipeline (Colab) over the
-- image_url the tenant supplied. title / category / colours / section are
-- FILTERS ONLY — they are never turned into vectors. Search still embeds the
-- shopper's QUERY with the encoder's text tower, and CLIP's two towers share
-- one joint 512-d space, so query-vs-image cosine is exactly right.
--
-- Consequence: editing a live product's image_url makes its stored vector
-- stale, and nothing in the tenant's hands can fix that (they do not run the
-- pipeline). So the edit flags the row, the flag puts it into the owner's
-- id->url export (admin_catalog ?op=embed_export), and uploading the
-- regenerated vectors clears it.
--
-- Scope: one boolean + one partial index. RLS, partitions, drop_tenant() and
-- products_guard are untouched (the guard still requires the row's
-- embedding_model to equal the tenant's — image vectors live in the tenant's
-- single space like every other vector).
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.products
  add column if not exists needs_reembed boolean not null default false;

comment on column public.products.needs_reembed is
  'true when the stored IMAGE vector no longer matches image_url (image edited). '
  'Listed by admin_catalog ?op=embed_export; cleared when the owner uploads vectors.';

-- Partial index: the export asks "which rows of THIS tenant need vectors" and
-- that set is normally zero — a partial index keeps it tiny.
create index if not exists products_tenant_needs_reembed_idx
  on public.products (tenant_id)
  where needs_reembed;
