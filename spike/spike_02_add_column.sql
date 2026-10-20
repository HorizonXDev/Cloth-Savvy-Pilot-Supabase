-- ============================================================================
-- spike_02_add_column.sql  —  SPIKE ONLY (schema-evolution test, S7/S8)
--
-- Run this while spike_tests.py is paused at S7, then press Enter.
--
-- Why on the PARENT and never on a partition: the PostgreSQL docs are explicit
--   "It is not possible to add columns to partitions after-the-fact using
--    ALTER TABLE."
--   (postgresql.org/docs/17/ddl-partitioning.html#DDL-PARTITIONING-DECLARATIVE-LIMITATIONS)
-- A single ALTER on the partitioned table propagates to every existing
-- partition, and partitions created afterwards (S8) inherit it too.
-- Idempotent: `if not exists` makes re-running safe.
-- ============================================================================

alter table public.spike_products
  add column if not exists spike_probe text default 'x';

-- PostgREST caches column lists too: without this, the S7 read of spike_probe
-- 404s until a manual schema reload (the tests pause here, so nothing else
-- refreshes the cache for them).
notify pgrst, 'reload schema';
