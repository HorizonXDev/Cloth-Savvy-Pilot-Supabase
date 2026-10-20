# SPIKE — `products` partitioned by LIST (tenant_id), one partition per brand

**This is a throwaway experiment on an EMPTY (ideally LOCAL) Supabase project.**
It exists to answer one question:

> Can we partition `products` by `tenant_id` (one physical table per brand)
> and still have tenant isolation that actually holds?

Everything here is prefixed `spike_` so cleanup removes exactly these objects
and nothing else. There are no Edge Functions, no API code, no encoder calls
and no real data. The Python tests talk to the Data API (PostgREST) over HTTP
using only the Python standard library — no pip installs needed.

## What's in this folder

| File | What it is |
| --- | --- |
| `spike_01_setup.sql` | Extensions, both tables, all locks, all functions, the guard trigger |
| `spike_02_add_column.sql` | Adds one test column to the parent (schema-evolution test S7) |
| `spike_audit.sql` | Read-only "who can see what" report for parent + every partition |
| `spike_99_cleanup.sql` | Removes every `spike_*` object and nothing else; safe to re-run |
| `spike_tests.py` | The S1–S15 test suite (stdlib only, prints a PASS/FAIL table) |
| `.env.example` | Names of the environment variables, no values |
| `.gitignore` | Keeps `.env`, `.env.*` and `*.key` out of git |

## The design under test (short version)

* `spike_tenants` — one row per brand (slug, embedding model, dim).
* `spike_products` — `PARTITION BY LIST (tenant_id)`. **No DEFAULT
  partition**, so inserting a product for a brand that has no partition
  simply fails. Uniqueness is `(tenant_id, id)` and `(tenant_id, external_id)`
  because PostgreSQL **requires** the partition key inside every unique/PK
  constraint on a partitioned table.
* `spike_create_tenant()` — inserts the tenant, creates the partition
  `spike_products_<slug>`, then locks that partition: RLS enabled + forced,
  no policies, all privileges revoked from `PUBLIC`/`anon`/`authenticated`.
* `spike_search()` — tenant-scoped vector search, `SECURITY INVOKER`,
  executable by `service_role` only.
* The parent gets the same lock-down, and **default privileges** are changed
  so *future* partitions are not auto-granted to `anon`/`authenticated`
  (Supabase's platform default grants new public tables to those roles).

## Exact order to run things

1. Read the safety rules below.
2. Apply `spike_01_setup.sql` in the SQL editor (see "Run locally" for how
   to get a local project; on a hosted project paste into its SQL editor).
3. Apply `spike_audit.sql` — you want to see "no offenders" before testing.
4. Set the environment variables (below), then run:
   `python spike_tests.py`
5. The test **pauses at S7** and asks you to apply
   `spike_02_add_column.sql`. Do that in the SQL editor, then press Enter.
6. Read the final table. All PASS/FAIL per test, then one `RESULT:` line.
7. When you're done, apply `spike_99_cleanup.sql` (see "After cleanup").

## Safety rules (baked into the tests, not just advice)

* `spike_tests.py` **refuses to run** unless `SPIKE_SUPABASE_URL`,
  `SPIKE_SUPABASE_SERVICE_KEY` and `SPIKE_SUPABASE_ANON_KEY` are all set.
* The URL must be a **localhost** address (`127.0.0.1` / `localhost`).
  A remote URL only works if you *also* set `SPIKE_ALLOW_REMOTE=1` **and**
  `SPIKE_PROJECT_REF=<ref>` (and the ref must appear in the URL).
  Default is local-only on purpose.
* Keys are never printed — the script prints only their lengths.
* Nothing in this folder may ever be pointed at the production
  ClothSavvy project.

## Environment variable setup

Fill `.env.example` in as `.env` next to `spike_tests.py` (the script reads
it automatically), or export them per shell:

**PowerShell (current session only):**

```powershell
# 54421 = this repo's API port (see "Run locally"); stock setups use 54321
$env:SPIKE_SUPABASE_URL      = "http://127.0.0.1:54421"
$env:SPIKE_SUPABASE_SERVICE_KEY = "<local secret key from supabase status>"
$env:SPIKE_SUPABASE_ANON_KEY    = "<local publishable key from supabase status>"
python .\spike_tests.py
```

**bash / Git Bash:**

```bash
# 54421 = this repo's API port (see "Run locally"); stock setups use 54321
export SPIKE_SUPABASE_URL="http://127.0.0.1:54421"
export SPIKE_SUPABASE_SERVICE_KEY="<local secret key from supabase status>"
export SPIKE_SUPABASE_ANON_KEY="<local publishable key from supabase status>"
python spike_tests.py
```

## What each test proves

| Test | What it proves | SQL feature it leans on |
| --- | --- | --- |
| S1 | Two tenants can be created with 20 products each, identical vectors, canary titles | `spike_create_tenant`, parent-table INSERT routing |
| S2 | Search only ever returns the asking tenant's rows | partition-key filter + `SECURITY INVOKER` search |
| S3 | A product for a tenant without a partition **fails** | **no DEFAULT partition** → `no partition of relation ... found for row` |
| S4 | You cannot slip a row into another tenant's partition — and on current PostgREST the partition has no route at all, so the attack surface is *absent* | per-partition `FOR VALUES IN (...)` constraint + PostgREST excluding partitions (PR #2022) |
| S5 | The anon key sees nothing and can change nothing (parent, every partition route, RPC) | REVOKE ALL + RLS enabled/forced with no policies + revoked `EXECUTE` (+ partitions simply not routable) |
| S6 | Reads scoped to one tenant contain only that tenant's rows (partition route when exposed; parent + `tenant_id` filter otherwise) | physical separation (one table per tenant) |
| S7 | Adding a column to the parent lands on parent **and** every partition, rows keep working | ALTER on the partitioned parent propagates (you cannot ALTER a partition directly) |
| S8 | A tenant created *after* the schema change also gets the new column and is locked | `CREATE TABLE ... PARTITION OF` after ALTER + default privileges |
| S9 | `spike_search` refuses NULL and unknown tenants | explicit `RAISE` guards in plpgsql |
| S10 | A product whose `embedding_model` differs from the tenant's is rejected | BEFORE INSERT row trigger on the parent, **cloned to every partition** |
| S11 | `external_id` is unique per tenant, not globally | `UNIQUE (tenant_id, external_id)` — which partitioning forces anyway |
| S12 | The search plan scans only the asking tenant's partition | partition pruning on the partition-key WHERE clause |
| S13 | Dropping a tenant removes its partition (catalog + data proof); other tenants unaffected | `DROP TABLE` on an individual partition |
| S14 | After all that, the audit finds no holes | RLS + privileges + the audit function itself |
| S15 | Creating 3 more tenants is fast and each is locked | DDL in plpgsql via `format(%I/%L)` |

## How to read the result

* **All PASS** → the partitioned design behaves as promised. Commit to
  partitioning.
* **Any FAIL** → before committing, look at *which* test:
  * **S2, S5, S6, S9, S10 FAIL** = isolation hole. **Fall back** to one plain
    shared table with `tenant_id` + RLS. These are the tests that must never
    fail.
  * **S3, S4, S11, S13 FAIL** = the partition mechanics themselves don't work
    as documented. **Fall back** to the shared table.
  * **S7, S8 FAIL** = schema changes or new-tenant bootstrap are too fragile
    (worth trying to fix, but if you can't, **fall back**).
  * **S12 FAIL** = search still works but doesn't prune — every search would
    scan every brand. Not a security problem, a **performance** problem:
    decide consciously (it may still be fine at pilot scale).
  * **S15 FAIL** = tenant creation is slow or unlocked; slow alone is
    information, unlocked is a **fall back**.

## S12 fallback

`spike_explain_search()` runs `EXPLAIN` inside plpgsql and **must be declared
VOLATILE** — PostgreSQL rejects `EXPLAIN` in a STABLE/IMMUTABLE function
with `EXPLAIN is not allowed in a non-volatile function` (observed live on
PG17; the setup file declares it correctly). If it ever errors on your
build anyway, run this manually in the SQL editor and check that only
`spike_products_alpha` appears:

```sql
explain (analyze, format text)
select p.id
  from public.spike_products p
 where p.tenant_id = (select id from public.spike_tenants where slug = 'alpha')
 order by p.embedding OPERATOR(extensions.<=>)
          (select embedding from public.spike_products
            where tenant_id = (select id from public.spike_tenants where slug = 'alpha')
            limit 1)
 limit 10;
```

## Run locally (Windows)

1. Install **Docker Desktop** (needs WSL2 on modern Windows) and the
   **Supabase CLI** (e.g. `winget install supabase.cli` — UNVERIFIED: check
   the current install instructions at
   supabase.com/docs/guides/local-development/cli/getting-started).
2. In this folder (or its parent), run:
   ```powershell
   supabase init     # creates supabase/config.toml
   supabase start    # starts the local stack (Docker); takes a while first run
   ```
3. `supabase status` prints the local URL and keys. You want:
   * API URL: normally `http://127.0.0.1:54321` — **but this repo's
     `supabase/config.toml` was moved to the 544xx block (54421 API,
     54422 db, 54423 Studio) because another local Supabase project on
     this machine owns the default ports. Trust whatever `supabase
     status` prints.**
   * `secret` key (legacy name: **service_role** key)
   * `publishable` key (legacy name: **anon** key)
   (Supabase renamed the keys; both names mean the same roles — UNVERIFIED:
   verify which label your CLI version prints.)
4. Apply the SQL files locally, in order — pick whichever you prefer:
   * **SQL editor**: open the local Studio (printed by `supabase start`;
     `http://127.0.0.1:54423` with this repo's config) → SQL → paste each
     file → Run.
   * **psql** (UNVERIFIED: port from `supabase status`):
     `psql "postgresql://postgres:postgres@127.0.0.1:54422/postgres" -f spike_01_setup.sql`
   Do **not** use `supabase db reset` for this — it rebuilds the whole local
   database from migrations and is destructive (per the official CLI docs).
5. Run the tests with the local URL and keys (see env setup above).

## Troubleshooting

**Every test 404s with "Could not find the table/function ... in the schema cache"**
The objects exist in the database (the SQL editor sees them) but PostgREST
caches its schema and only refreshes when told. Run this once in the SQL
editor:

```sql
NOTIFY pgrst, 'reload schema';
```

…or in Studio: Settings → API → **Reload schema**. Or `supabase restart`.
The script now checks for this before S1 and refuses with this exact message
instead of failing all over, and S3/S4/S9 no longer "pass" on a schema-cache
404 — a pass must come from the real database rule.

**S14/S15 (or the preflight) say `spike_audit` is missing / not in the
schema cache**
The function lives in `spike_audit.sql`, applied *after* setup. Run that
file (it now ends with its own `NOTIFY pgrst, 'reload schema'`) and re-run.

**A partition route (`spike_products_alpha` …) answers 404 `PGRST205`
"not in the schema cache"**
That is **not** a stale cache — PostgREST deliberately excludes partition
children from its schema cache (PR postgrest/postgrest#2022; the 9.0
changelog says "Partitions (created using `PARTITION OF`) are no longer
included in the schema cache"), so no reload will ever expose them. The
tests detect this state (`excluded` mode) and assert through the parent
endpoint + `spike_audit` instead; only a 404 on the **parent** means the
cache is stale.

## How to clean up

Apply `spike_99_cleanup.sql`. It drops every `spike_*` table, partition and
function (it survives a half-aborted run) and then lists anything left —
that final query must return zero rows.

**After cleanup — one deliberate leftover:** `spike_01_setup.sql` changes
**default privileges** for the `postgres` role in schema `public` so future
tables/functions are not auto-granted to `anon`/`authenticated`. Those
statements are *not* `spike_` objects, so cleanup leaves them alone (reverting
them would mean guessing your project's previous state). On a throwaway
project, ignore it. On a real project, this is exactly the change you would
want to keep anyway (it's the recipe from Supabase's "Securing your API"
guide).

## Where the design decisions come from (docs checked 2026-10-19)

* PK/unique must include the partition key, no DEFAULT partition unless
  declared, insert into a missing partition errors, you cannot ADD COLUMN to
  a partition directly, partition pruning, DROP TABLE on one partition:
  postgresql.org/docs/17/ddl-partitioning.html
  (+ postgresql.org/docs/17/sql-createtable.html)
* The exact "no partition of relation ... found for row" error text and its
  SQLSTATE 23514 come from PostgreSQL source (execPartition.c) and the error
  code appendix, not from the partitioning doc page.
* Row triggers on a partitioned table are cloned onto every existing and
  future partition: postgresql.org/docs/17/sql-createtrigger.html
* Querying a partition *directly* uses that partition's own RLS (parent's
  policies ignored); RLS enabled + forced + zero policies = default deny,
  but BYPASSRLS (service_role) still bypasses:
  postgresql.org/docs/current/ddl-inherit.html and ddl-rowsecurity.html
* pgvector installs into the `extensions` schema, write the type as
  `extensions.vector(512)`: supabase.com/docs/guides/database/extensions
  (+ .../pgvector)
* Supabase default grants on new public tables/functions and the
  `alter default privileges ... revoke` recipe, plus EXECUTE governing RPC
  access: supabase.com/docs/guides/api/securing-your-api and
  supabase.com/docs/guides/database/functions
* PostgREST exposes tables/functions of exposed schemas that the active
  role can access: docs.postgrest.org (tables_views + schemas) and
  supabase.com/docs/guides/api/using-custom-schemas
* Local CLI flow (`supabase init/start/status`, destructive `db reset`):
  supabase.com/docs/guides/local-development/cli/getting-started

### Verified live (2026-10-20, local PG17.6 stack, PostgREST 12)

* **PostgREST does not expose partition children.** Parent → 200, every
  `spike_products_<slug>` → 404 `PGRST205`, OpenAPI lists no partition,
  PostgREST's own log shows "2 Relations" after successful reloads —
  consistent with PR postgrest/postgrest#2022 (`AND NOT relispartition`)
  and the PostgREST 9.0 changelog ("Partitions (created using `PARTITION
  OF`) are no longer included in the schema cache"). `NOTIFY pgrst,
  'reload schema'` does not change this; the tests detect it
  (`partition_route_mode`) and assert through the parent + `spike_audit`
  instead of fighting it.
* `EXPLAIN` inside plpgsql **works, but only in a VOLATILE function** —
  STABLE fails with `EXPLAIN is not allowed in a non-volatile function`
  (that was S12's failure). The pruned plan shows a single index scan on
  `spike_products_alpha`.
* The guard trigger is cloned onto partitions created *after* the trigger
  exists (S10/S8 pass on runtime-created partitions), and
  `spike_create_tenant` → partition usable is 0.01–0.04 s (S15).

### Explicitly UNVERIFIED (could not be confirmed from docs or by running)

* The exact timing of the `NOTIFY pgrst, 'reload schema'` refresh (reload
  completion is observed in PostgREST's log; the tests no longer depend on
  a timing window — S13 proves the drop via catalog + data instead).
* Supabase's *current* platform default grants can vary by project age
  (their docs note they are changing defaults) — which is why every grant
  and revoke in this spike is written explicitly.
* The Windows install one-liner for the Supabase CLI and the exact local
  Studio port — both printed/verifiable at your end.
