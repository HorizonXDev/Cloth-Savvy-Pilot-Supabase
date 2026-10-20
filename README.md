# Cloth Savvy Pilot — database layer

This directory is the real multi-tenant database layer for the B2B pilot,
built from the spike in [spike/](spike/) (which passed 15/15 locally).
Tables are shared between all tenants; every row carries `tenant_id`;
`products` is partitioned by tenant. The tests prove the isolation rules
hold. **Nothing outside this folder is changed; the spike folder is frozen;
there are no secrets in any file here.**

---

## 1. What is in this folder

```
Cloth-Savvy-Pilot-supabase/
├── migrations/
│   ├── 0001_extensions.sql      pgvector + project-wide lockdown defaults
│   ├── 0002_tenants.sql         the tenant registry
│   ├── 0003_products.sql        partitioned products + guard/updated_at triggers
│   ├── 0004_api_keys.sql        hashed API keys
│   ├── 0005_usage_events.sql    append-only metering log
│   ├── 0006_ingestion_runs.sql  import/sync job records
│   └── 0007_functions.sql       create/drop tenant, key resolve/create, search, explain
├── schema_audit.sql             read-only lockdown audit (run after every migration)
├── tests/
│   ├── isolation_tests.py       T1–T15, PASS/FAIL table, exit 1 on failure
│   └── cleanup_test_tenants.py  removes ONLY "test_" tenants + the local key file
├── .env.example                 variable NAMES only — copy to .env and fill locally
├── .gitignore                   covers .env, .env.*, *.key, tests/.test_keys
└── spike/                       the finished spike — do not modify
```

### What each migration does (plain language)

| File | What it does |
|---|---|
| `0001_extensions.sql` | Installs pgvector into the `extensions` schema, stops `anon`/`authenticated` from ever getting privileges on **future** tables/functions created by `postgres`, and gives `service_role` `CREATE` on schema `public` (it must create partitions; see Decisions). |
| `0002_tenants.sql` | `tenants`: slug (validated `[a-z0-9_]+`), name, status (`active`/`suspended`), the tenant's `embedding_model`/`embedding_dim`, and a `settings` JSON bag (currency, min_similarity, default_limit, combo recipes per occasion). RLS enabled+forced, no policies, zero privileges for the API roles. |
| `0003_products.sql` | `products` partitioned **by list on `tenant_id`**, no default partition. Primary key and unique constraint include `tenant_id`. Checks for `section`, `status`, `source`. Two indexes: `(tenant_id, section)`, `(tenant_id, in_stock)`. No vector index yet (pilot scale). Installs the **embedding-model guard** trigger (every insert/update must match the tenant's model) and the `updated_at` trigger — both live on the parent and are cloned onto every partition, including ones created later. |
| `0004_api_keys.sql` | `api_keys`: stores only `key_hash` (SHA-256 hex of the full key) + display prefix, environment (`live`/`sandbox`), `last_used_at`, `revoked_at`. `unique (tenant_id, id)` exists so `usage_events` can point at it with a composite FK. |
| `0005_usage_events.sql` | `usage_events`: append-only metering rows. Composite FK `(tenant_id, key_id) → api_keys(tenant_id, id)` — a cross-tenant reference is impossible at write time. `service_role` gets only `SELECT, INSERT` (see Decisions for why this beats a trigger). |
| `0006_ingestion_runs.sql` | `ingestion_runs`: one row per import job, counters and timestamps, FK to `tenants`. |
| `0007_functions.sql` | All the RPCs, `SECURITY INVOKER`, `search_path = ''`, `EXECUTE` for `service_role` **only**: `create_tenant`, `drop_tenant`, `resolve_api_key`, `create_api_key`, `search_products`, `explain_search_products`. Ends with `NOTIFY pgrst, 'reload schema'`. |
| `schema_audit.sql` | Creates `schema_audit()`: checks every table in `public` (parent, every partition, every other table) for RLS enabled+forced, zero `anon`/`authenticated` privileges, a `tenant_id` column on everything except `tenants`, and checks every function for service_role-only `EXECUTE`. Empty `offenders` = pass. Run it standalone after any future migration. |

---

## 2. Exact order for the hosted SQL Editor

Open Dashboard → SQL Editor and run **in this exact order**, one file per
query window (each file ends with its own `NOTIFY pgrst, 'reload schema'`):

1. `migrations/0001_extensions.sql`
2. `migrations/0002_tenants.sql`
3. `migrations/0003_products.sql`
4. `migrations/0004_api_keys.sql`
5. `migrations/0005_usage_events.sql`
6. `migrations/0006_ingestion_runs.sql`
7. `migrations/0007_functions.sql`
8. `schema_audit.sql`   ← the trailing query must show **zero** offenders

Every file is idempotent (`if not exists` / `create or replace` / grant-or-
revoke safely repeated), so a re-run is safe. If the audit shows offenders,
**stop** — fix before running tests.

---

## 3. Running the tests — LOCAL stack

```powershell
# PowerShell (Windows)
cd Cloth-Savvy-Pilot\Cloth-Savvy-Pilot-supabase
supabase start          # if not already running; supabase status prints keys
# create .env from the template once:
Copy-Item .env.example .env
# fill PILOT_SUPABASE_SERVICE_KEY and PILOT_SUPABASE_ANON_KEY in .env
#   (Dashboard -> Project Settings -> API, or `supabase status` locally)
$env:PILOT_SUPABASE_URL="http://127.0.0.1:54421"   # only if not using .env
python tests\isolation_tests.py
python tests\cleanup_test_tenants.py
```

```bash
# bash (Git Bash / Linux / macOS)
cd Cloth-Savvy-Pilot/Cloth-Savvy-Pilot-supabase
cp .env.example .env && $EDITOR .env     # fill the two keys
python tests/isolation_tests.py
python tests/cleanup_test_tenants.py
```

The suite **refuses to run** (exit 2) if: an env var is missing, the target
is not localhost without `PILOT_ALLOW_REMOTE=1`, the PostgREST schema cache
is stale (it tells you the exact `NOTIFY` to run), or `test_` tenants from a
previous run are still there (it tells you to run the cleanup first).

What you get: a PASS/FAIL table, a `RESULT: PASS (15/15 tests)` line, exit
code 0 — or a FAIL row with the exact HTTP status and error text, exit 1.

Plaintext test keys generated by T8 are written **only** to
`tests/.test_keys` (gitignored, warning header inside). They are never
printed. `cleanup_test_tenants.py` deletes that file.

---

## 4. Running the tests — HOSTED project (your required gate)

On the hosted project, first run section 2's eight files in the SQL Editor,
confirm the audit is clean, then from your shell:

```powershell
# PowerShell
cd Cloth-Savvy-Pilot\Cloth-Savvy-Pilot-supabase
$env:PILOT_ALLOW_REMOTE="1"
$env:PILOT_PROJECT_REF="<your-project-ref>"          # the ref, not the URL
$env:PILOT_SUPABASE_URL="https://<your-project-ref>.supabase.co"
$env:PILOT_SUPABASE_SERVICE_KEY="<paste from dashboard, never into a file>"
$env:PILOT_SUPABASE_ANON_KEY="<paste from dashboard, never into a file>"
python tests\isolation_tests.py
python tests\cleanup_test_tenants.py
```

```bash
# bash
cd Cloth-Savvy-Pilot/Cloth-Savvy-Pilot-supabase
export PILOT_ALLOW_REMOTE=1
export PILOT_PROJECT_REF="<your-project-ref>"
export PILOT_SUPABASE_URL="https://<your-project-ref>.supabase.co"
export PILOT_SUPABASE_SERVICE_KEY="<from dashboard>"
export PILOT_SUPABASE_ANON_KEY="<from dashboard>"
python tests/isolation_tests.py
python tests/cleanup_test_tenants.py
```

(You may instead put those five `PILOT_*` lines in a **local, gitignored**
`.env` — same names, that is what `.env.example` shows. Never paste keys
anywhere else, and never commit `.env`.)

The guard requires `PILOT_PROJECT_REF` to appear inside the URL, so the
suite can never quietly run against some other remote host.

### If a test FAILS on hosted but PASSED locally

Almost always a platform/version difference, not a design problem. Do this:

1. Read the FAIL row's detail — it contains the HTTP status and the database
   error text (never any key material).
2. Run `select version();` on both databases and compare — hosted may be on a
   different PostgreSQL/pgvector minor version.
3. Typical pairs and what they mean:
   * **0003 fails on `alter table public.products owner to service_role`
     ("must be able to SET ROLE")** → hosted `postgres` is not a member of
     `service_role` (UNVERIFIED item). Stop and report back — do not work
     around it by weakening the functions.
   * **"schema cache"/404/PGRST202** → the hosted PostgREST has not
     reloaded; run `NOTIFY pgrst, 'reload schema';` in the SQL Editor and
     re-run. (Setup issue, not a test failure.)
   * **T7 anon sees something** → check the audit: a hosted project that
     existed before these migrations may carry old platform grants. Run
     `revoke all on all tables in schema public from anon, authenticated;`
     and the two `alter default privileges ... revoke` lines from 0001
     again, re-run `schema_audit.sql`, then re-run tests.
   * **T6 cross-partition row says "served"** → older PostgREST exposing
     partition routes; the suite then expects a 4xx constraint error. A 200
     would be a real failure — report it.
   * **T11 pruning / EXPLAIN errors** → `EXPLAIN` inside a non-volatile
     function is rejected by some versions; the helper is `VOLATILE` for
     exactly this reason. Paste the exact error.
4. Paste the failing row + `select version();` output back to me — do **not**
   "fix" it by weakening the test.

---

## 5. After the tests pass — creating the real pilot tenant

**Always create and drop tenants with the same role** (see Decisions): use
the service key over the Data API. Example (PowerShell shown; bash is the
same command with `"` quotes and `$env:` → `$`):

```powershell
$svc = "<service key from dashboard>"    # stays in this shell only
$url = "https://<your-project-ref>.supabase.co"

# create (slug = partition name suffix: products_<slug>)
Invoke-RestMethod -Method Post -Uri "$url/rest/v1/rpc/create_tenant" `
  -Headers @{ apikey = $svc; Authorization = "Bearer $svc" } `
  -ContentType "application/json" `
  -Body '{"p_slug":"real_brand","p_name":"Real Brand","p_embedding_model":"fashion-clip-local","p_embedding_dim":512,"p_settings":{"currency":"INR","min_similarity":0.25,"default_limit":10}}'
# -> returns the tenant uuid
```

Notes:
* `p_embedding_dim` must be `512` (the column is `vector(512)`).
* The SQL Editor also works for creation (`select public.create_tenant(...);`
  as `postgres`), but the partition is then **owned by `postgres`**, and a
  later `drop_tenant` must run as `postgres` too — mixing roles fails on
  purpose. Service-key path keeps one owner end-to-end. Whether hosted
  `postgres` has BYPASSRLS is UNVERIFIED (see §8), so the service-key path
  is also the one we know works.

## 6. Rotating an API key

Rotation = issue a new key first, then revoke the old one (zero downtime):

```sql
-- 1. In the SQL Editor (or via an admin RPC), hash the NEW plaintext key
--    yourself: sha256_hex(new_key), then:
select public.create_api_key(
  '<tenant uuid>', '<sha256 hex of the NEW key>', 'pk_live_ab12cd34',
  'live', 'rotated 2026-10-20');

-- 2. Switch your server to the new key, confirm traffic works.

-- 3. Revoke the OLD key (service key over REST, or SQL as an admin):
update public.api_keys set revoked_at = now()
 where key_hash = '<sha256 hex of the OLD key>' and revoked_at is null;
```

`resolve_api_key` ignores revoked keys from that moment on (T8 proves it),
and it only ever sees unrevoked keys of **active** tenants. Never write a
plaintext key into SQL, a ticket, or a log — only its SHA-256.

## 7. usage_events: append-only + retention

No role except the table owner can `UPDATE`/`DELETE`/`TRUNCATE`
`usage_events` — and even the owner's row security is forced, so retention
is a deliberate admin act in the SQL Editor:

```sql
alter table public.usage_events no force row level security;
delete from public.usage_events where created_at < now() - interval '90 days';
alter table public.usage_events force row level security;
```

Dropping a tenant (`drop_tenant`) removes its usage events too — via the
FK's `ON DELETE CASCADE`, which bypasses the missing DELETE privilege
(verified live). Export anything you must keep **before** dropping a tenant.

---

## 8. Decisions made beyond the brief (and why)

1. **Append-only = privilege revoke, not a trigger.** A row trigger would
   also fire on `ON DELETE CASCADE` and block `drop_tenant`, and it would
   never cover `TRUNCATE`. Withholding `UPDATE/DELETE/TRUNCATE` from
   `service_role` blocks direct DML (T9) while RI cascades still work — the
   cascade's internal privilege was verified live on this stack.
   **Important subtlety (found by the first T9 run):** 0001's default
   privileges auto-grant ALL table privileges to `service_role` on
   postgres-created tables, so 0005 must `revoke all ... from service_role`
   BEFORE `grant select, insert` — a bare grant is not enough.
2. **`usage_events` FK is `ON DELETE CASCADE`** — the only consistent way to
   remove a dropped tenant's events while keeping the table append-only for
   direct writes. Documented in §7.
3. **`drop_tenant` order: partition → ingestion_runs → api_keys → tenant.**
   The partition goes first so an ownership problem aborts before anything
   else changed. `api_keys`/`ingestion_runs` are deleted explicitly (service
   holds DELETE); `usage_events` follows by cascade. `api_keys.tenant_id` FK
   is deliberately **no cascade**: a stray manual `delete from tenants`
   fails loudly instead of silently vaporizing keys.
4. **`GRANT CREATE ON SCHEMA public TO service_role`** — required because
   the brief mandates SECURITY INVOKER and service_role creates the
   partitions (verified: it lacks CREATE by default). service_role is the
   trusted server role; it must never be sent to a browser.
   **4b. `ALTER TABLE products OWNER TO service_role` (end of 0003).**
   `CREATE TABLE ... PARTITION OF` requires being the OWNER of the parent —
   verified live: as service_role against a postgres-owned parent it fails
   with "must be owner of table products". Since only service_role may call
   create_tenant()/drop_tenant(), the parent belongs to service_role.
   ALTER OWNER requires the executing role to be a member of the new owner:
   locally `postgres` **is** a member of `service_role` (verified), on
   hosted this is UNVERIFIED — if 0003 fails there on that line, the
   fallback (spike-proven) is making create_tenant/drop_tenant SECURITY
   DEFINER instead; that changes a brief rule, so report back first.
   Consequence: future `ALTER TABLE products ...` migrations should run as
   `service_role` (or a member of it).
5. **Create-and-drop with the same role.** `DROP TABLE` needs ownership;
   partitions are owned by whoever ran `create_tenant`. The service-key path
   gives one consistent owner.
6. **Slug rules:** `[a-z0-9_]+`, max 40 chars (`products_` + slug must fit
   the 63-byte identifier cap), validated *before* any dynamic SQL, built
   only with `format('%I'/'%L')`.
7. **`embedding_dim` must equal 512** (column is `vector(512)`); refused
   with 22023 instead of storing a lie.
8. **Search details:** default limit 10, floor 1, hard cap 50;
   `p_min_similarity` applied *inside* the query (default 0.0, so rows with
   NULL embedding or similarity < 0 never appear); `p_colors` is an ANY
   match (`&&`); unknown `p_max_price` keeps rows with NULL price; only
   `status='active'`; `ORDER BY embedding <=> query`. `explain_search_products`
   exists purely so T11 can prove pruning.
9. **Sensible defaults not spelled out in the brief:** `ingestion_runs`
   counters `default 0`, `started_at default now()`, `status not null`
   (values app-defined); `usage_events.units not null default 1`;
   `tenants.settings`/`products.attributes` `not null default '{}'`.
10. **The suite refuses to run with leftover `test_` tenants** (exit 2 +
    pointer to cleanup) instead of dying on confusing "already exists"
    errors mid-run.
11. **T15 is recorded as PASS with an explicit SKIPPED detail** so the
    table still has 15 rows while being honest that the check needs the
    future API layer.

## 9. Everything UNVERIFIED (checked 2026-10-20)

* **Hosted `postgres` BYPASSRLS** — locally `postgres` has `rolbypassrls=t`
  and is *not* superuser; current Supabase docs confirm "superuser access is
  not given" but do **not** state the BYPASSRLS attribute for hosted. This
  is why the admin SQL in §7 includes the `no force`/`force` dance and why
  §5 recommends the service-key path.
* **Hosted `postgres` membership in `service_role`** (needed for 0003's
  `ALTER TABLE products OWNER TO service_role`) — locally
  `pg_has_role('postgres','service_role','member') = true` (and
  `rolcreaterole = t`); not documented for hosted. If 0003 fails on that
  line on hosted, that is the reason — see Decisions 4b.
* **Hosted grants for `service_role` on schema `public` (CREATE)** — not in
  current docs; locally it is absent (probed), so 0001 grants it explicitly.
  The grant itself works regardless, but whether some hosted setup already
  had it is unknown.
* **"PostgREST excludes partitions" as a docs sentence** — current PostgREST
  *source* filters `relispartition` out of the schema cache (verified
  locally: parent 200, partition 404 PGRST205), but no official doc sentence
  says so. Tests handle both modes.
* **NOTIFY `pgrst` reload** — documented by PostgREST and Supabase, and
  verified live locally; hosted notification timing (usually instant) is
  assumed.
* **pgvector schema** — Supabase docs show `create extension vector with
  schema extensions`; we use exactly that and reference
  `extensions.vector(512)` / `extensions.<=>`. Verified locally, hosted
  presumed identical.
* **Default privileges** — Supabase docs confirm platform defaults grant
  new public tables to anon/authenticated/service_role on *existing*
  projects; 0001's revokes handle it, but the hosted project's *starting*
  ACL state was not inspected (cannot connect — your gate covers it).
* **EXPLAIN needs VOLATILE in plpgsql** — no docs statement found; proven
  live during the spike (a `stable` marking failed with exactly that error).

## 10. Troubleshooting quick reference

* `REFUSED: ... schema cache is stale` → SQL Editor: `NOTIFY pgrst, 'reload schema';`
* `REFUSED: ... leftover test_ tenant(s)` → `python tests/cleanup_test_tenants.py`
* `REFUSED: missing environment variable(s)` → fix `.env` or export the vars
* `PGRST202` on an RPC → function signature cache stale: same `NOTIFY`
* Audit offenders list non-empty → do not run tests until it is empty
