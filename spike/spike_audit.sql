-- ============================================================================
-- spike_audit.sql  —  READ-ONLY. Creates no spike_ data and changes nothing.
--
-- Creates public.spike_audit(), a read-only function (STABLE, no writes) that
-- lists, for the partitioned parent AND every partition (plus spike_tenants
-- and the spike_ functions):
--   * RLS enabled / RLS forced
--   * privileges held by anon, authenticated and service_role
--   * whether the Data API (PostgREST) would expose the object to those roles
--   * an `offenders` list — empty means OK
--
-- Read it as a schema_audit later: same idea, just rename the objects it
-- looks at. `public` is a PostgREST exposed schema by default on Supabase, so
-- "PostgREST exposes it" here means "the schema is exposed AND the role holds
-- at least one table privilege (or EXECUTE for functions)". Even with RLS and
-- no policies, an exposed table still answers requests — it just returns zero
-- rows — which is why the audit treats any anon/authenticated privilege as an
-- offender rather than relying on RLS alone.
--
-- Usage:  select * from public.spike_audit();
--         -- rows with an OFFENDERS list FAILED; the trailing SELECT in this
--         -- file sorts those to the top and emits a WARNING.
-- Run it any time; it is idempotent (CREATE OR REPLACE FUNCTION).
-- ============================================================================

create or replace function public.spike_audit()
returns table (
  obj_name                        text,
  obj_kind                        text,   -- parent | partition | tenants | function
  rls_enabled                     boolean,
  rls_forced                      boolean,
  anon_privs                      text[],
  authenticated_privs             text[],
  service_privs                   text[],
  postgrest_exposed_anon          boolean,
  postgrest_exposed_authenticated boolean,
  postgrest_exposed_service       boolean,
  offenders                       text[]
)
language plpgsql
stable
set search_path = ''
as $$
declare
  r          record;
  p          text;
  v_anon     text[];
  v_auth     text[];
  v_svc      text[];
  v_off      text[];
  v_dml      text[] := array['select','insert','update','delete','truncate'];
  v_noff     int := 0;
begin
  -- ---------------------------------------------------------------- tables --
  for r in
    select c.oid,
           c.relname,
           case when c.relispartition      then 'partition'
                when c.relkind = 'p'       then 'parent'
                else 'tenants' end                        as kind,
           c.relrowsecurity,
           c.relforcerowsecurity
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and (
             (c.relkind in ('p','r') and c.relname in ('spike_products','spike_tenants'))
          or (c.relkind = 'r' and c.relispartition and c.relname like 'spike\_%')
           )
     order by c.relispartition, c.relname
  loop
    select coalesce(array_agg(x.privilege order by x.privilege), '{}'::text[])
      into v_anon
      from (select unnest(v_dml) as privilege) x
     where has_table_privilege('anon', r.oid, x.privilege);

    select coalesce(array_agg(x.privilege order by x.privilege), '{}'::text[])
      into v_auth
      from (select unnest(v_dml) as privilege) x
     where has_table_privilege('authenticated', r.oid, x.privilege);

    select coalesce(array_agg(x.privilege order by x.privilege), '{}'::text[])
      into v_svc
      from (select unnest(v_dml) as privilege) x
     where has_table_privilege('service_role', r.oid, x.privilege);

    v_off := array[]::text[];
    if not r.relrowsecurity then
      v_off := v_off || 'RLS NOT ENABLED';
    end if;
    if not r.relforcerowsecurity then
      v_off := v_off || 'RLS NOT FORCED (owner would bypass)';
    end if;
    if cardinality(v_anon) > 0 then
      v_off := v_off || 'anon holds: ' || array_to_string(v_anon, ',');
    end if;
    if cardinality(v_auth) > 0 then
      v_off := v_off || 'authenticated holds: ' || array_to_string(v_auth, ',');
    end if;
    if cardinality(v_svc) = 0 then
      v_off := v_off || 'service_role holds NOTHING (S6/S14 would fail)';
    end if;
    if cardinality(v_off) > 0 then
      v_noff := v_noff + 1;
    end if;

    obj_name := r.relname;                     obj_kind := r.kind;
    rls_enabled := r.relrowsecurity;           rls_forced := r.relforcerowsecurity;
    anon_privs := v_anon;                      authenticated_privs := v_auth;
    service_privs := v_svc;
    -- `public` is an exposed PostgREST schema by default on Supabase; a table
    -- is served to a role only if that role holds at least one privilege.
    postgrest_exposed_anon          := cardinality(v_anon) > 0;
    postgrest_exposed_authenticated := cardinality(v_auth) > 0;
    postgrest_exposed_service       := cardinality(v_svc) > 0;
    offenders := v_off;
    return next;
  end loop;

  -- ------------------------------------------------------------- functions --
  for r in
    select p.oid,
           p.proname                                            as name,
           pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
           (p.prorettype = 'pg_catalog.trigger'::regtype)       as is_trigger_fn
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname like 'spike\_%'
     order by p.proname
  loop
    v_anon := case when has_function_privilege('anon',          r.oid, 'execute')
                   then array['execute'] else '{}'::text[] end;
    v_auth := case when has_function_privilege('authenticated', r.oid, 'execute')
                   then array['execute'] else '{}'::text[] end;
    v_svc  := case when has_function_privilege('service_role',  r.oid, 'execute')
                   then array['execute'] else '{}'::text[] end;

    v_off := array[]::text[];
    if cardinality(v_anon) > 0 then
      v_off := v_off || 'anon can EXECUTE';
    end if;
    if cardinality(v_auth) > 0 then
      v_off := v_off || 'authenticated can EXECUTE';
    end if;
    if cardinality(v_svc) = 0 then
      v_off := v_off || 'service_role cannot EXECUTE (RPCs would 401)';
    end if;
    if cardinality(v_off) > 0 then
      v_noff := v_noff + 1;
    end if;

    obj_name := r.name || '(' || r.args || ')';
    obj_kind := case when r.is_trigger_fn then 'function (trigger)'
                     else 'function' end;
    rls_enabled := null;                     rls_forced := null;
    anon_privs := v_anon;                    authenticated_privs := v_auth;
    service_privs := v_svc;
    postgrest_exposed_anon := (not r.is_trigger_fn) and cardinality(v_anon) > 0;
    postgrest_exposed_authenticated := (not r.is_trigger_fn) and cardinality(v_auth) > 0;
    postgrest_exposed_service := cardinality(v_svc) > 0;
    offenders := v_off;
    return next;
  end loop;

  if v_noff > 0 then
    raise warning 'SPIKE AUDIT: % object(s) with offenders — rows below with a non-empty offenders list FAILED', v_noff;
  else
    raise notice 'SPIKE AUDIT: OK — % object(s) checked, no offenders', (v_noff + 0);
  end if;
end;
$$;

revoke all  on function public.spike_audit() from public, anon, authenticated;
grant  execute on function public.spike_audit() to service_role;

-- PostgREST only learns about functions created here when told: this file is
-- applied AFTER spike_01's own notify, so without its own NOTIFY,
-- rpc/spike_audit answers 404 PGRST202 "not in the schema cache" (seen live).
notify pgrst, 'reload schema';

-- Run it immediately: offending rows sort to the top and an empty `offenders`
-- array means the object passed.
select a.*
  from public.spike_audit() a
 order by (cardinality(coalesce(a.offenders, '{}'::text[])) > 0) desc, a.obj_kind, a.obj_name;
