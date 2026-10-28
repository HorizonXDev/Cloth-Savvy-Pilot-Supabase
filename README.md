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
│   ├── 0007_functions.sql       create/drop tenant, key resolve/create, search, explain
│   ├── 0008_catalog_facets.sql  facet rollups for recipe fallback text
│   └── 0009_tenant_users.sql    portal logins: which auth user belongs to which tenant
├── schema_audit.sql             read-only lockdown audit (run after every migration)
├── tests/
│   ├── isolation_tests.py       T1–T15, PASS/FAIL table, exit 1 on failure
│   └── cleanup_test_tenants.py  removes ONLY "test_" tenants + the local key file
├── .env.example                 variable NAMES only — copy to .env and fill locally
├── .gitignore                   covers .env, .env.*, *.key, tests/.test_keys
└── spike/                       the finished spike — do not modify
```

Phases 1–3 added the Edge Function API layer (`supabase/functions/`,
`tests/`, `docs/`, `../tools/issue_key.py`) — see **§11 Part B** below.

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
| `0008_catalog_facets.sql` | Materialized facet rollups (brand/category/colour) per tenant+section so the deterministic recipe fallback can match products without the encoder. |
| `0009_tenant_users.sql` | `tenant_users`: the portal-login membership table — exactly which Supabase Auth user belongs to exactly which tenant. `user_id` UNIQUE (one login = one tenant), FKs to `tenants` and `auth.users` both `ON DELETE CASCADE`, `revoked_at` fails a login closed. RLS enabled+forced, zero privileges for the API roles. |
| `0010_catalog_staging.sql` | `catalog_staging`: the TENANT's import queue — a CSV row uploaded in the portal waits here as `pending` (payload = the validated row, incl. `image_url`) until the owner's image pipeline supplies vectors. FK `tenant_id` ON DELETE CASCADE (drop_tenant needs no change), partial unique `(tenant_id, external_id)` while pending, CHECK that external_id/title/section are present, RLS enabled+forced, service_role only. |
| `0011_needs_reembed.sql` | `products.needs_reembed` boolean + partial index: set when a live product's `image_url` changes (its stored vector is stale), listed by `admin_catalog ?op=embed_export`, cleared when the owner's vectors arrive. Text is never embedded into the catalog. |
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
8. `migrations/0008_catalog_facets.sql`
9. `migrations/0009_tenant_users.sql`
10. `schema_audit.sql`   ← the trailing query must show **zero** offenders

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

---

# Part B — the API layer (Phases 1–3)

The database layer above plus four Edge Functions that talk only to it (all
queries go through the SECURITY INVOKER RPCs in `0007_functions.sql` — no
function touches a table directly). Plain language first; every claim below
was exercised locally or is listed as UNVERIFIED in §11.9.

| Endpoint (platform path) | What it does |
|---|---|
| `GET  /functions/v1/health`    | Liveness + dependency status (database, encoder). No auth beyond the platform key check. |
| `GET  /functions/v1/occasions` | The tenant's combo recipes: every occasion it knows, with its sections. The server OWNS this list. |
| `POST /functions/v1/search`    | Text search over the tenant's products (query → encoder → `search_products` RPC). |
| `POST /functions/v1/combos`    | Build `n` outfit combos for an occasion: recipe skeleton + LLM step (`GROQ_API_KEY`) with deterministic recipe fallback, greedy product dedupe, honest `missing_sections`. |

Every endpoint authenticates with `Authorization: Bearer sk_live_...` or
`sk_test_...` (decision D3: SHA-256 at rest via `resolve_api_key`). Over the
rate limit → `429` + `Retry-After` (decision D4). Tenant settings come from
`tenants.settings` — shape, defaults and brand examples: [docs/settings.md](docs/settings.md).

## 11.1 What was added

```
Cloth-Savvy-Pilot-supabase/
├── supabase/
│   ├── config.toml              544xx local ports + [functions.*] verify_jwt=false (auth is our sk_ key check)
│   ├── functions/
│   │   ├── .env                 LOCAL-ONLY env for `functions serve` (gitignored; names in .env.example)
│   │   ├── _pilot/              shared core: auth, rate limit, metering, encoder/LLM clients,
│   │   │                        settings/recipes/validation/errors, pure logic + pilot.test.ts
│   │   ├── _admin/admin.ts      shared ADMIN_TOKEN guard (constant-time) + admin helpers
│   │   ├── _tenant/tenant.ts    shared PORTAL guard: session JWT -> exactly one tenant
│   │   ├── health/index.ts      GET  /functions/v1/health
│   │   ├── occasions/index.ts   GET  /functions/v1/occasions
│   │   ├── search/index.ts      POST /functions/v1/search
│   │   ├── combos/index.ts      POST /functions/v1/combos
│   │   ├── admin_tenants/       admin: list/create/suspend tenants + settings editor
│   │   ├── admin_keys/          admin: issue (show-once)/list/revoke sk_ keys
│   │   ├── admin_usage/         admin: usage_events aggregates per tenant/key/day
│   │   ├── admin_catalog/       admin: product browse, CSV import batches, search preview
│   │   ├── admin_tenant_users/  admin: provision/list/revoke portal logins (invite|password)
│   │   ├── tenant_account/      portal: whoami + settings (session-scoped)
│   │   ├── tenant_keys/         portal: issue (plaintext ONCE)/list/revoke sk_ keys
│   │   ├── tenant_usage/        portal: usage aggregates for the session's tenant only
│   │   └── tenant_catalog/      portal: product browse + search preview (own tenant)
│   └── migrations/              0008_catalog_facets.sql (facets) + 0009_tenant_users.sql (portal logins)
├── docs/settings.md             tenants.settings reference + kurta/saree recipe examples
├── ../admin-dashboard/          Next.js ADMIN dashboard (tenants/keys/catalog/usage) — §11.10
│                                (standalone project, one level up — not inside this folder)
├── tests/
│   ├── api_tests.py             26 end-to-end API tests against the LOCAL stack + stubs
│   ├── admin_tests.py           12 end-to-end tests for the admin_* dashboard functions
│   ├── tenant_portal_tests.py   14 end-to-end tests incl. the admin/portal separation matrix
│   ├── serve_local.ts           host-Deno harness serving all 13 functions (auto-spawned)
│   ├── stub_encoder.py          deterministic local encoder stub (embed_text shared with tests)
│   ├── stub_llm.py              local OpenAI-compatible LLM stub (combo plans)
│   └── live_smoke.py            4-call smoke test against a RUNNING API (you run this)
└── (../tools/issue_key.py       owner tool: generate + register ONE sk_ key — see §11.5)
```

## 11.2 Running the API tests — LOCAL stack

Standard library only; no pip installs. The suite spawns the two stubs
itself if their ports (8841/8842) are not already up, and it NEVER touches
the live Modal encoder or a real LLM.

By default it also serves the four Edge Functions itself with a host-Deno
harness (`tests/serve_local.ts`, auto-spawned on `127.0.0.1:54431`; the
first run downloads Deno 2.1.4 via npx). Two local-stack quirks make this
necessary (verified 2026-10-24): the Docker edge-runtime runs on the
project's network where `127.0.0.1` is the container, so it cannot reach
the loopback stubs; and local Kong's `cors` plugin overrides our
`Access-Control-Allow-Origin` with `"*"`, so A19 (allowlist, never `*`)
would be untestable through the gateway. Export `PILOT_FUNCTIONS_URL` to
target an already-served instance instead (e.g. `supabase functions
serve` — A19 will then report Kong's `*`); hosted behaviour is covered by
`tests/live_smoke.py`.

```powershell
# PowerShell (Windows)
cd Cloth-Savvy-Pilot\Cloth-Savvy-Pilot-supabase
supabase start                                   # if not already running
# .env beside tests/ must have PILOT_SUPABASE_URL + the two keys (§3 above)
python tests\api_tests.py                        # PASS/FAIL table; exit 0 = 26/26
python tests\cleanup_test_tenants.py
```

```bash
# bash (Git Bash / Linux / macOS)
cd Cloth-Savvy-Pilot/Cloth-Savvy-Pilot-supabase
supabase start
python tests/api_tests.py && python tests/cleanup_test_tenants.py
```

Expected: a PASS/FAIL table, `RESULT: 26/26`, exit code 0. Plaintext test
keys go only to `tests/.test_keys` (gitignored) and are never printed.

The pure logic (settings validation, recipe lookup, combo assembly/dedupe,
error mapping, key format) is unit-tested offline — no Docker, no network:

```powershell
npx -y deno@2.1.4 run supabase\functions\_pilot\pilot.test.ts    # RESULT: 21 passed
# (or plain `deno run ...` if Deno is installed — it is a check()-style
#  script: `deno test` discovers 0 tests and would green-light vacuously)
```

## 11.3 Setting the secrets — HOSTED project

The functions read these environment variables (names only in
`.env.example`):

| Secret | Required | Meaning |
|---|---|---|
| `ENCODER_URL` | yes (search/combos) | base URL of your running encoder, e.g. `https://<your-encoder>.modal.run` |
| `ENCODER_AUTH_TOKEN` | if the encoder requires it | bearer token the encoder expects |
| `GROQ_API_KEY` | no (combos LLM step) | pilot-dedicated Groq key; WITHOUT it combos still work via the deterministic recipe fallback |
| `GROQ_MODEL` | no | defaults to `openai/gpt-oss-20b` |
| `ALLOWED_ORIGINS` | recommended | comma-separated CORS allowlist, e.g. `https://www.yourbrand.example` |

(`PILOT_LLM_BASE_URL` exists for LOCAL tests only — it redirects the LLM
call to a loopback stub and is ignored when not loopback.)

```powershell
# PowerShell — placeholders, run from Cloth-Savvy-Pilot-supabase
supabase secrets set `
  ENCODER_URL=https://<your-encoder>.modal.run `
  ENCODER_AUTH_TOKEN=<encoder-bearer-token> `
  GROQ_API_KEY=<groq-api-key> `
  ALLOWED_ORIGINS=https://www.yourbrand.example `
  --project-ref <your-project-ref>
```

```bash
# bash — one line
supabase secrets set ENCODER_URL=https://<your-encoder>.modal.run ENCODER_AUTH_TOKEN=<encoder-bearer-token> GROQ_API_KEY=<groq-api-key> ALLOWED_ORIGINS=https://www.yourbrand.example --project-ref <your-project-ref>
```

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform —
never set them yourself and never put the service key in a function `.env`
that could be committed.

## 11.4 Deploying the functions — one per command

```powershell
# PowerShell — from Cloth-Savvy-Pilot-supabase
supabase functions deploy health    --project-ref <your-project-ref>
supabase functions deploy search    --project-ref <your-project-ref>
supabase functions deploy occasions --project-ref <your-project-ref>
supabase functions deploy combos    --project-ref <your-project-ref>
```

(Same four commands in bash.) Auth is our own `sk_` key check, so local
`config.toml` sets `verify_jwt = false` per function — auth happens inside
the function. UNVERIFIED (§11.9): whether the deployed platform honours
per-function `verify_jwt` from `config.toml` on the current CLI; if a
deployed function answers platform 401s before our own errors, re-run the
deploy with `--no-verify-jwt`.

## 11.5 Issuing an API key — tools/issue_key.py

The tool prints the plaintext key EXACTLY ONCE (copy it into your password
manager — it is gone afterwards), stores only its SHA-256, and writes
nothing to disk. From `Cloth-Savvy-Pilot-supabase`:

```powershell
# PowerShell — local stack
$env:PILOT_SUPABASE_URL="http://127.0.0.1:54421"
$env:PILOT_SUPABASE_SERVICE_KEY="<service key from `supabase status`>"
$env:PILOT_TENANT_ID="<tenant uuid>"
$env:PILOT_KEY_ENVIRONMENT="sandbox"   # sk_test_... ; use "live" for sk_live_...
$env:PILOT_KEY_LABEL="demo-1"          # optional
python ..\tools\issue_key.py
```

```bash
# bash — hosted project
export PILOT_ALLOW_REMOTE=1 PILOT_PROJECT_REF=<your-project-ref>
export PILOT_SUPABASE_URL=https://<your-project-ref>.supabase.co
export PILOT_SUPABASE_SERVICE_KEY=<service key>
export PILOT_TENANT_ID=<tenant uuid>
export PILOT_KEY_ENVIRONMENT=live
python ../tools/issue_key.py
```

Keys are `sk_live_`/`sk_test_` + 43 URL-safe chars (decision D3). `pk_`
reserved for future browser-safe keys — never issued. Rotation = issue new,
switch, revoke old (§6 above).

## 11.6 Example combo recipes (kurta brand + saree brand)

Combos recipes live in `tenants.settings.combos` — occasion → ordered pilot
sections. Full copy-paste examples for a kurta brand and a saree brand (plus
every default and validation rule) are in [docs/settings.md](docs/settings.md).
The short version:

```json
// a kurta brand (kurta sets map onto "top"; "dress" for one-piece looks)
{"currency": "INR", "min_similarity": 0.30, "default_limit": 10,
 "rate_limit_per_min": 60,
 "combos": {"daily_casual": ["top", "bottom", "footwear"],
            "office":       ["top", "bottom", "outerwear", "accessory"],
            "festive":      ["dress", "footwear", "jewellery"],
            "wedding_guest":["top", "bottom", "footwear", "bag"]}}

// a saree brand
{"currency": "INR", "min_similarity": 0.25, "default_limit": 12,
 "rate_limit_per_min": 60,
 "combos": {"daily":   ["saree", "blouse", "accessory"],
            "office":  ["saree", "blouse", "bag"],
            "wedding": ["saree", "blouse", "jewellery", "bag"],
            "bridal":  ["saree", "blouse", "dupatta", "jewellery", "footwear", "bag"]}}
```

After updating settings, `GET /functions/v1/occasions` shows exactly what
the server sees — check it; a typo'd section silently drops that one recipe.

## 11.7 Running live_smoke.py against a RUNNING API

Four calls — health, occasions, one search, one combo — with a PASS/FAIL
line each; exits 1 on any failure; NEVER prints the key.

```powershell
# PowerShell — hosted, after deploy + secrets + issue_key.py
$env:PILOT_LIVE_FUNCTIONS_URL="https://<your-project-ref>.supabase.co/functions/v1"
$env:PILOT_LIVE_API_KEY="<sk_live_... key you just saved>"
$env:PILOT_LIVE_ORIGIN="https://www.yourbrand.example"   # optional: also verifies the CORS allowlist
python tests\live_smoke.py
```

```bash
# bash — LOCAL stack (a sk_test_ key from the local issue_key.py run)
export PILOT_LIVE_FUNCTIONS_URL=http://127.0.0.1:54421/functions/v1
export PILOT_LIVE_API_KEY=<sk_test_... key>
python tests/live_smoke.py
```

Optional: `PILOT_LIVE_QUERY` (search text), `PILOT_LIVE_OCCASION` (defaults
to the first occasion your recipes define). Combos may call a real LLM —
the script allows 90 s per call.

## 11.8 API-layer decisions beyond the brief

1. **CORS**: a small explicit allowlist (`ALLOWED_ORIGINS`) instead of
   `*` — the consumer web app's origin is registered per environment.
2. **LLM step is optional at deploy time**: without `GROQ_API_KEY`, combos
   fall back to the deterministic recipe text (log line says so). The API
   never 500s because an LLM is missing.
3. **`0008_catalog_facets.sql`**: per-section facet rollups (categories,
   colours) so the recipe-fallback embedding text uses the tenant's REAL
   vocabulary instead of invented words.
4. **Metering on every successful call** goes to `usage_events` with the
   key id — the same rows the rate limiter counts (D4), so billing and
   limiting can never disagree.
5. **Errors are typed** (`validation`, `auth`, `rate_limited`,
   `unsupported_occasion`, `upstream_encoder`, `upstream_llm`, ...): every
   non-2xx answer is `{error: {type, message, ...}}` with a stable `type`
   string for callers to branch on.

## 11.9 API-layer UNVERIFIED (checked 2026-10-24)

* **Everything hosted.** All API tests ran against the LOCAL Docker stack
  with the two stubs. No function, secret, deploy or key has been run
  against a hosted project — §11.3–§11.7 are written from the CLI's help
  and the local equivalents, not from a hosted run.
* **Per-function `verify_jwt` on deploy** — present in this CLI's config
  schema and the consumer project's config, but not exercised on the
  current CLI (see §11.4).
* **Real encoder parity** — the stub is deterministic; the real Modal
  encoder's model/revision strings were pinned from Step 0 but never called
  from these functions.
* **Real Groq call** — the LLM path ran only against the local stub.
  `live_smoke.py` with `GROQ_API_KEY` set is the first real check.

---

## 11.10 The admin dashboard (`../admin-dashboard/`)

A single-owner Next.js app (Next 16 / React 19 / Tailwind 4, same stack as
Cloth-Savvy-Web) that talks ONLY to the four `admin_*` Edge Functions — the
service key never reaches the browser. It gives you: create/suspend
_tenants + a validated settings editor (combo recipes, limits), issue/list/
_revoke API keys (plaintext shown exactly once), a CSV import wizard with
_run history + per-row failure reporting, a paginated product browser with
archive/restore, a search preview (real encoder + real RPC), usage
aggregates, and a health view.

**Auth (decision D5, single-owner):** one shared `ADMIN_TOKEN` secret,
pasted on the login screen, kept in browser localStorage only, verified
constant-time inside every admin function. No token set = admin routes
fail closed (500). Admin calls are NOT metered and never touch
`usage_events`.

### Run it locally

```bash
cd Cloth-Savvy-Pilot/Cloth-Savvy-Pilot-supabase
supabase start                    # if not already running
# 1. serve the functions (host harness — all 13 routes, no Docker/Kong):
npx -y deno@2.1.4 run --allow-net --allow-env --allow-read tests/serve_local.ts 54431 &
# 2. the two stubs (search preview / import need the encoder stub):
STUB_ENCODER_TOKEN=local-stub-encoder-token python tests/stub_encoder.py --port 8841 &
python tests/stub_llm.py --port 8842 &
# 3. the admin dashboard (standalone project, one level UP from here):
cd ../admin-dashboard && cp .env.example .env.local && npm install && npm run dev
# → http://localhost:3000 — login token = ADMIN_TOKEN from supabase/functions/.env
#   (local value: local-admin-token-dev)
```

Notes:
* `npm run dev` pins **port 3000** because the local admin CORS allowlist
  (`ADMIN_ALLOWED_ORIGINS=http://localhost:3000` in `supabase/functions/.env`)
  must match the dashboard origin — a different port needs that variable
  updated.
* The script passes **`--webpack`** on purpose: on this machine Turbopack
  dev crashes the render worker on every dynamic route (`[id]`) with
  "Jest worker encountered 2 child process exceptions" — webpack mode is
  stable. Revisit when the Next release fixes it.
* Test suites needed it too: `python tests/admin_tests.py` (12 tests:
  auth, tenants, strict settings, keys show-once/revoke, suspend→403,
  usage, import counters, search preview, archive, isolation, admin CORS,
  health).

### Deploy it — HOSTED

```bash
# from Cloth-Savvy-Pilot-supabase
supabase functions deploy admin_tenants --project-ref <ref>
supabase functions deploy admin_keys     --project-ref <ref>
supabase functions deploy admin_usage    --project-ref <ref>
supabase functions deploy admin_catalog  --project-ref <ref>

# one strong secret (shown once — store it in your password manager):
openssl rand -hex 32
supabase secrets set ADMIN_TOKEN=<that value> \
  ADMIN_ALLOWED_ORIGINS=https://your-dashboard-origin.example \
  --project-ref <ref>

# point the admin dashboard at hosted:
cd ../admin-dashboard && cp .env.example .env.local
#   NEXT_PUBLIC_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1
npm run build && npm run start     # or any static/Node host you choose
```

Rules: `ADMIN_TOKEN` lives ONLY in Supabase secrets + the operator's
password manager — never in a repo file, never in `.env.local` of the
repo, never logged. Rotate by re-running `supabase secrets set` with a
fresh value (both sides pick it up on the next request; no redeploy).

---

## 11.11 The tenant portal — BACKEND (`tenant_*` + `admin_tenant_users` + `0009`)

The second dashboard's server side: five new Edge Functions, one
migration, and a hard separation from the admin family — the stated
requirement is that a tenant must NEVER be able to act as the admin
(sudo) identity through the portal, in any way.

### `migrations/0009_tenant_users.sql` — the membership table

`tenant_users` is the ONLY bridge between Supabase Auth (`auth.users`,
outside `public`) and tenant data:

* `user_id` is UNIQUE → **one login = one tenant**, so session→tenant
  resolution is deterministic (no tenant picker, nothing to exploit).
* FKs to `tenants` and to `auth.users`, both `ON DELETE CASCADE`
  (`drop_tenant()` needed no change — the RI cascade covers memberships).
* `revoked_at` fails the login closed on its next request.
* RLS enabled+forced, zero privileges for `anon`/`authenticated` — the
  portal routes read it only through the service-role client inside the
  functions (schema_audit stays green; A24 proves it).

### The `tenant_*` family — every route is session-scoped

| Route | What it does |
|---|---|
| `tenant_account` | whoami: the session's user + its ONE tenant + validated settings |
| `tenant_keys` | issue (plaintext shown ONCE, `live`/`sandbox`), list, revoke — scoped to the session's tenant |
| `tenant_usage` | the same aggregates the admin sees, but only for the session's tenant |
| `tenant_catalog` | product browse + search preview over the session's tenant's catalog |

Rules enforced by the shared guard (`_tenant/tenant.ts`):

1. The bearer is a Supabase Auth JWT, verified server-side via GoTrue
   `/user`; that auth user must have an active `tenant_users` row.
2. **The tenant id comes ONLY from that membership row** — never from a
   query parameter, body or header (P05/P06 prove a forged `tenant_id`
   is ignored).
3. Revoked row → 403, suspended tenant → 403, no membership → 403.
4. Portal traffic is **not metered** — nothing lands in `usage_events` (P14).
5. `TENANT_ALLOWED_ORIGINS` (local: `http://localhost:3001`) is a
   SEPARATE CORS allowlist from `ADMIN_ALLOWED_ORIGINS` (3000) — P12
   proves neither origin is echoed on the other family's routes.

### `admin_tenant_users` — provisioning (admin side, ADMIN_TOKEN)

* `GET ?tenant_id=` — list that tenant's portal logins
* `POST {tenant_id, email, mode}` — `mode:"invite"` (GoTrue invite mail;
  needs SMTP; failures come back with the GoTrue reason and a hint to
  use `password` mode) or `mode:"password"` (admin-created login, a
  generated temporary password returned EXACTLY ONCE — the same
  show-once contract as API keys).
* `PATCH {tenant_id, user_id, action}` — `revoke` / `reinstate` /
  `delete` (`delete` removes the auth user; the membership row cascades).

Password changes are done by the tenant themselves (the portal calls
`supabase.auth.updateUser` with their own browser session).

---

## 11.12 The tenant portal — the APP (`../tenant-portal/`)

A standalone Next.js project (same stack as the admin dashboard), one
level up — NOT inside this folder, so the two dashboards are managed,
versioned and deployed independently.

Pages: `/login` (email + password via GoTrue), `/overview` (usage +
month-to-date cost), `/keys` (issue/list/revoke, plaintext once),
`/catalog` (their products), `/settings` (read-only config + password
change). The browser talks ONLY to the `tenant_*` functions with the
user's session JWT — no service key and no ADMIN_TOKEN anywhere in this
app.

### Run it locally

```bash
cd Cloth-Savvy-Pilot/Cloth-Savvy-Pilot-supabase
supabase start                    # if not already running
npx -y deno@2.1.4 run --allow-net --allow-env --allow-read tests/serve_local.ts 54431 &
STUB_ENCODER_TOKEN=local-stub-encoder-token python tests/stub_encoder.py --port 8841 &
cd ../tenant-portal && cp .env.example .env.local && npm install && npm run dev
# → http://localhost:3001  (must match TENANT_ALLOWED_ORIGINS in supabase/functions/.env)
#   login = a portal login you created from the ADMIN dashboard → tenant → Users tab
```

### Deploy it — HOSTED

```bash
cd ../tenant-portal && cp .env.example .env.local
#   NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
#   NEXT_PUBLIC_SUPABASE_ANON_KEY=<project anon key>
#   NEXT_PUBLIC_FUNCTIONS_URL=https://<your-project-ref>.supabase.co/functions/v1
npm run build && npm run start    # or any static/Node host you choose
```

---

## 11.13 The portal test suite (`tests/tenant_portal_tests.py`)

14 end-to-end tests, same harness/stubs/PASS-FAIL table as the other
suites. The ones that carry the separation requirement:

| Test | Proves |
|---|---|
| P01 | `tenant_*` reject no/garbage/admin-token/sk_ credentials |
| P08 | **sudo separation**: a portal session JWT is 401 on EVERY `admin_*` route; ADMIN_TOKEN is 401 on EVERY `tenant_*` route; an sk_ key is 401 on `tenant_*`; a portal session is 401 on the public API (11/11) |
| P05/P06 | a forged `tenant_id` in query/body is ignored; tenant B sees none of A's data |
| P09/P10 | revoke → 403 immediately, reinstate → 200, delete → the login is gone |
| P11 | an auth user with no membership row gets 403 |
| P12 | the portal (3001) and admin (3000) CORS allowlists are disjoint |
| P13 | a suspended tenant is blocked from its own portal (403) |
| P14 | portal traffic never touches `usage_events` |

```bash
python tests/tenant_portal_tests.py    # 14/14, exit 0
python tests/admin_tests.py            # 12/12
python tests/api_tests.py              # 26/26
python tests/cleanup_test_tenants.py   # removes test_* tenants + the local key file
```

---

## 11.14 Going LIVE — exact order of operations

1. **Database** — run §2's order in the hosted SQL Editor, including
   `0008_catalog_facets.sql` and `0009_tenant_users.sql`; the trailing
   `schema_audit()` must show zero offenders.
2. **Secrets** — §11.3 (`ENCODER_URL`, `ENCODER_AUTH_TOKEN`,
   `GROQ_API_KEY`, `ALLOWED_ORIGINS`) plus, for the dashboards,
   `ADMIN_TOKEN` (§11.10) and `TENANT_ALLOWED_ORIGINS` (the exact HTTPS
   origin of the tenant portal).
3. **Functions** — §11.4's four `admin_*` commands plus:
   ```
   supabase functions deploy admin_tenant_users --project-ref <ref>
   supabase functions deploy tenant_account     --project-ref <ref>
   supabase functions deploy tenant_keys        --project-ref <ref>
   supabase functions deploy tenant_usage       --project-ref <ref>
   supabase functions deploy tenant_catalog     --project-ref <ref>
   ```
4. **Dashboards** — deploy `../admin-dashboard` (your ops origin) and
   `../tenant-portal` (the tenant-facing origin) on two DIFFERENT
   origins; each `.env.local` holds only the public functions URL + the
   anon key, and each origin is allowlisted ONLY in its own family's
   CORS variable.
5. **First tenant login** — §5 creates the pilot tenant; then the admin
   dashboard → tenant → Users tab → create login (`password` mode to
   hand over out-of-band, or `invite` once SMTP is configured).
6. **Gate** — §4's hosted test run, then `python tests/live_smoke.py`
   against the deployed API with a real sk_ key.
