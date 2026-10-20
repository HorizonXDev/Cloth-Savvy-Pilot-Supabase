-- ============================================================================
-- spike_99_cleanup.sql  —  removes EVERY spike_* object in the public schema
-- and nothing else. Safe to run repeatedly and after an aborted test run.
--
-- What it removes: spike_products (and, dropping with it, every partition),
-- any partition that somehow lost its parent, spike_tenants, and every
-- function whose name starts with spike_ (including the guard trigger
-- function and spike_audit()).
--
-- What it deliberately does NOT touch: the ALTER DEFAULT PRIVILEGES made in
-- spike_01_setup.sql. Those are not spike_ objects and reverting them would
-- mean guessing your project's previous state — see README "After cleanup".
-- ============================================================================

do $$
declare
  r     record;
  n_tbl int := 0;
  n_fn  int := 0;
begin
  -- 1. Partitions first. Dropping the parent would take them with it, but
  --    doing them explicitly also covers a half-created state.
  for r in
    select c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and c.relkind = 'r'
       and c.relispartition
       and c.relname like 'spike\_%'
  loop
    begin
      execute format('drop table if exists public.%I', r.relname);
      raise notice 'cleanup: dropped partition public.%', r.relname;
      n_tbl := n_tbl + 1;
    exception when others then
      raise warning 'cleanup: could not drop partition public.%: %', r.relname, sqlerrm;
    end;
  end loop;

  -- 2. The parent table, spike_tenants and any other spike_ table.
  --    No CASCADE on purpose: if something else depends on a spike_ table we
  --    want to see the error rather than delete a non-spike object.
  for r in
    select c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and c.relkind in ('p','r')
       and not c.relispartition
       and c.relname like 'spike\_%'
  loop
    begin
      execute format('drop table if exists public.%I', r.relname);
      raise notice 'cleanup: dropped table public.%', r.relname;
      n_tbl := n_tbl + 1;
    exception when others then
      raise warning 'cleanup: could not drop table public.%: %', r.relname, sqlerrm;
    end;
  end loop;

  -- 3. Functions last: a trigger function cannot be dropped while its table
  --    still exists, and the tables are gone by now.
  for r in
    select p.proname as name,
           pg_catalog.pg_get_function_identity_arguments(p.oid) as args
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname like 'spike\_%'
     order by p.proname
  loop
    begin
      execute format('drop function if exists public.%I(%s)', r.name, r.args);
      raise notice 'cleanup: dropped function public.%(%s)', r.name, r.args;
      n_fn := n_fn + 1;
    exception when others then
      raise warning 'cleanup: could not drop function public.%(%s): %', r.name, r.args, sqlerrm;
    end;
  end loop;

  raise notice 'cleanup: % table/partition(s) and % function(s) dropped', n_tbl, n_fn;
end;
$$;

-- Sanity check: this must return ZERO rows afterwards.
select c.relname
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace ns on ns.oid = c.relnamespace
 where ns.nspname = 'public'
   and c.relkind in ('p','r','f')
   and c.relname like 'spike\_%';
