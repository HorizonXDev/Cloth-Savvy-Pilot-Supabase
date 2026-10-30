-- ============================================================================
-- schema_audit.sql  —  READ-ONLY. Creates no data and changes nothing.
--
-- Promoted from spike/spike_audit.sql. Creates public.schema_audit(), a
-- read-only function (STABLE, no writes) that checks EVERY table in `public`
-- (the partitioned parent, every partition, and every other table) and EVERY
-- function in `public` against the project's isolation rules (L2/L3):
--
--   * RLS enabled AND forced on every table
--   * anon / authenticated hold NO privileges on any table (they must not,
--     not even TRUNCATE/REFERENCES/TRIGGER leftovers)
--   * service_role holds normal DML on every table (otherwise the API layer
--     is broken)
--   * every table EXCEPT the platform-wide ones (tenants, admin_users,
--     admin_audit) carries a tenant_id column
--   * anon / authenticated cannot EXECUTE any function; service_role can
--     EXECUTE every function
--   * an `offenders` list per object — EMPTY means OK
--
-- "PostgREST exposes it" here means "the schema is exposed AND the role holds
-- at least one privilege". Even with RLS and no policies, an exposed table
-- still ANSWERS requests (it just returns zero rows), which is why the audit
-- treats any anon/authenticated privilege as an offender rather than relying
-- on RLS alone.
--
-- Usage (runnable standalone after EVERY future migration):
--   * hosted SQL editor / local psql:  \i schema_audit.sql
--     (the file ends with its own NOTIFY + a sorted SELECT; offenders sort
--      to the top and a non-empty offenders list FAILED)
--   * via the Data API (service key):  POST /rest/v1/rpc/schema_audit
-- Idempotent: CREATE OR REPLACE FUNCTION.
-- ============================================================================

create or replace function public.schema_audit()
returns table (
  obj_name                        text,
  obj_kind                        text,   -- parent | partition | table | function | function (trigger)
  rls_enabled                     boolean,
  rls_forced                      boolean,
  anon_privs                      text[],
  authenticated_privs             text[],
  service_privs                   text[],
  postgrest_exposed_anon          boolean,
  postgrest_exposed_authenticated boolean,
  postgrest_exposed_service       boolean,
  has_tenant_id                   boolean,
  offenders                       text[]
)
language plpgsql
stable
set search_path = ''
as $$
declare
  r      record;
  v_anon text[];
  v_auth text[];
  v_svc  text[];
  v_off  text[];
  v_dml  text[] := array['select','insert','update','delete','truncate'];
  v_tid  boolean;
  v_noff int := 0;
  -- The ONLY public tables allowed to carry no tenant_id, each deliberately
  -- platform-wide rather than tenant-scoped:
  --   tenants     the tenant registry itself (a tenant is not inside a tenant)
  --   admin_users 0012 — an admin may act on ANY tenant, so scoping the row
  --   admin_audit 0012 — records WHO called an admin route, not which tenant
  -- Anything else missing tenant_id still FAILS.
  v_platform text[] := array['tenants', 'admin_users', 'admin_audit'];
begin
  -- ---------------------------------------------------------------- tables --
  for r in
    select c.oid,
           c.relname,
           c.relrowsecurity,
           c.relforcerowsecurity,
           case when c.relispartition then 'partition'
                when c.relkind = 'p'   then 'parent'
                else 'table' end as kind
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and c.relkind in ('p','r')
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

    select exists (
      select 1 from pg_catalog.pg_attribute a
       where a.attrelid = r.oid
         and a.attname = 'tenant_id'
         and a.attnum > 0
         and not a.attisdropped
    ) into v_tid;

    v_off := array[]::text[];
    if not r.relrowsecurity then
      v_off := v_off || 'RLS NOT ENABLED'::text;
    end if;
    if not r.relforcerowsecurity then
      v_off := v_off || 'RLS NOT FORCED (owner would bypass)'::text;
    end if;
    if cardinality(v_anon) > 0 then
      v_off := v_off || 'anon holds: '::text || array_to_string(v_anon, ',');
    end if;
    if cardinality(v_auth) > 0 then
      v_off := v_off || 'authenticated holds: '::text || array_to_string(v_auth, ',');
    end if;
    if cardinality(v_svc) = 0 then
      v_off := v_off || 'service_role holds NOTHING (API writes/reads would 403)'::text;
    end if;
    if not (r.relname = any (v_platform)) and not v_tid then
      v_off := v_off || 'no tenant_id column'::text;
    end if;
    if cardinality(v_off) > 0 then
      v_noff := v_noff + 1;
    end if;

    obj_name := r.relname;                        obj_kind := r.kind;
    rls_enabled := r.relrowsecurity;              rls_forced := r.relforcerowsecurity;
    anon_privs := v_anon;                         authenticated_privs := v_auth;
    service_privs := v_svc;
    has_tenant_id := v_tid;
    postgrest_exposed_anon          := cardinality(v_anon) > 0;
    postgrest_exposed_authenticated := cardinality(v_auth) > 0;
    postgrest_exposed_service       := cardinality(v_svc) > 0;
    offenders := v_off;
    return next;
  end loop;

  -- ------------------------------------------------------------- functions --
  -- EVERY function in public is audited: on a clean project the schema holds
  -- only this project's functions (trigger helpers + the RPC layer). If a
  -- later migration adds a function, the audit keeps checking it for free.
  for r in
    select p.oid,
           p.proname                                            as name,
           pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
           (p.prorettype = 'pg_catalog.trigger'::regtype)       as is_trigger_fn
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
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
      v_off := v_off || 'anon can EXECUTE'::text;
    end if;
    if cardinality(v_auth) > 0 then
      v_off := v_off || 'authenticated can EXECUTE'::text;
    end if;
    if cardinality(v_svc) = 0 then
      v_off := v_off || 'service_role cannot EXECUTE (RPC would 403)'::text;
    end if;
    if cardinality(v_off) > 0 then
      v_noff := v_noff + 1;
    end if;

    obj_name := r.name || '(' || r.args || ')';
    obj_kind := case when r.is_trigger_fn then 'function (trigger)'
                     else 'function' end;
    rls_enabled := null;                     rls_forced := null;
    anon_privs := v_anon;                    authenticated_privs := v_auth;
    service_privs := v_svc;                  has_tenant_id := null;
    postgrest_exposed_anon := (not r.is_trigger_fn) and cardinality(v_anon) > 0;
    postgrest_exposed_authenticated := (not r.is_trigger_fn) and cardinality(v_auth) > 0;
    postgrest_exposed_service := cardinality(v_svc) > 0;
    offenders := v_off;
    return next;
  end loop;

  if v_noff > 0 then
    raise warning 'SCHEMA AUDIT: % object(s) with offenders — rows below with a non-empty offenders list FAILED', v_noff;
  else
    raise notice 'SCHEMA AUDIT: OK — no offenders';
  end if;
end;
$$;

revoke all  on function public.schema_audit() from public, anon, authenticated;
grant  execute on function public.schema_audit() to service_role;

-- PostgREST only learns about functions created here when told: without its
-- own NOTIFY, rpc/schema_audit answers 404 PGRST202 "not in the schema cache"
-- (seen live during the spike).
notify pgrst, 'reload schema';

-- Run it immediately: offending rows sort to the top and an empty
-- `offenders` array means the object passed.
select a.*
  from public.schema_audit() a
 order by (cardinality(coalesce(a.offenders, '{}'::text[])) > 0) desc, a.obj_kind, a.obj_name;
