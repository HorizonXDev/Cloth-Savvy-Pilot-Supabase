# `tenants.settings` — the per-tenant JSON bag

Every API function reads this row's `settings` column through
`_pilot/settings.ts`. **Every key is optional.** A missing key, or a value
of the wrong type/range, falls back to the documented default and is logged
as an `issue` — a broken settings row never 500s a request.

Set it with the service key (never in SQL with a plaintext key nearby):

```powershell
Invoke-RestMethod -Method Post -Uri "$url/rest/v1/rpc/create_tenant" `
  -Headers @{ apikey = $svc; Authorization = "Bearer $svc" } `
  -ContentType "application/json" `
  -Body '{"p_slug":"kurta_brand","p_name":"Kurta Brand","p_embedding_model":"fashion-clip@7e3ba62","p_embedding_dim":512,"p_settings":{ ... }}'
```

(For an existing tenant, update the column in the SQL Editor as an admin:
`update public.tenants set settings = settings || '{ ... }'::jsonb where id = '<uuid>';`)

## Keys

| Key | Type / range | Default | Meaning |
|---|---|---|---|
| `currency` | short non-empty string (≤ 8 chars) | `null` (omitted from responses) | e.g. `"INR"` — echoed in API responses so the caller can price-format |
| `min_similarity` | number 0..1 | `0.25` | default similarity floor applied by search/combos (per-request override allowed) |
| `default_limit` | integer 1..50 | `10` | default number of rows for search / combos |
| `rate_limit_per_min` | integer 1..10000 | `60` | per-key requests per minute (decision D4), enforced by counting recent `usage_events` rows |
| `vton_rate_limit_per_min` | integer 1..1000 | `3` | per-key, per-minute cap for `POST /v1/vton` only — the GPU route. Stricter than `rate_limit_per_min` because every call bills GPU seconds |
| `vton_monthly_cap` | integer 0..100000 | `100` | per-tenant ceiling on billable `/v1/vton` calls per **UTC calendar month**, across all keys. `0` disables the cap |
| `combos` | object: occasion → array of 1..8 pilot sections | see "Demo defaults" | THE recipe map: which sections a combo for an occasion must fill |

## Occasion keys and sections

* Occasion names are normalized: trimmed, lowercased, spaces/dashes → `_`.
  `"Karwa Chaut"` and `"karwa-chaut"` are the same occasion, stored as
  `karwa_chaut`.
* Section values MUST be pilot sections (see the CHECK constraint on
  `products.section`): `top, bottom, dress, saree, blouse, dupatta,
  outerwear, footwear, bag, jewellery, accessory`. A recipe containing an
  unknown section is **dropped for that occasion only** (the rest of the map
  survives; the event is reported as an `issue`).
* Max 50 occasions; max 8 sections per recipe (= one encoder batch).

### Demo defaults (used when `combos` is absent)

```json
{
  "casual": ["top", "bottom", "footwear"],
  "office": ["top", "bottom", "accessory"],
  "festive": ["dress", "jewellery", "bag"]
}
```

These are generic on purpose (no saree/kurta assumption). A real brand must
set its own map.

## Example: a kurta brand

```json
{
  "currency": "INR",
  "min_similarity": 0.30,
  "default_limit": 10,
  "rate_limit_per_min": 60,
  "combos": {
    "daily_casual":   ["top", "bottom", "footwear"],
    "office":         ["top", "bottom", "outerwear", "accessory"],
    "festive":        ["kurta_set", "footwear", "jewellery"],
    "wedding_guest":  ["kurta_set", "bottom", "footwear", "bag"]
  }
}
```

Note `"kurta_set"` is **not** a pilot section, so that recipe would be
dropped — a kurta brand maps its kurta sets onto `top` (or `dress` for
one-piece looks). Corrected version:

```json
{
  "currency": "INR",
  "min_similarity": 0.30,
  "default_limit": 10,
  "rate_limit_per_min": 60,
  "combos": {
    "daily_casual":  ["top", "bottom", "footwear"],
    "office":        ["top", "bottom", "outerwear", "accessory"],
    "festive":       ["dress", "footwear", "jewellery"],
    "wedding_guest": ["top", "bottom", "footwear", "bag"]
  }
}
```

## Example: a saree brand

```json
{
  "currency": "INR",
  "min_similarity": 0.25,
  "default_limit": 12,
  "rate_limit_per_min": 60,
  "combos": {
    "daily":        ["saree", "blouse", "accessory"],
    "office":       ["saree", "blouse", "bag"],
    "wedding":      ["saree", "blouse", "jewellery", "bag"],
    "festive":      ["saree", "blouse", "jewellery", "footwear"],
    "bridal":       ["saree", "blouse", "dupatta", "jewellery", "footwear", "bag"]
  }
}
```

All sections here are valid pilot sections, so every recipe survives
validation. `GET /functions/v1/occasions` shows exactly what the server
sees after normalization — check it after any settings change.

## What each setting does in the API

* `min_similarity` — floor applied inside `search_products` (rows below it
  are simply absent; combos additionally report the section in
  `missing_sections` instead of returning a weak match).
* `default_limit` — used when a request omits `limit`.
* `rate_limit_per_min` — checked per key before any work; over the limit the
  API answers `429` with a `Retry-After` header. The count is a `COUNT(*)`
  over that key's `usage_events` rows from the last 60 s (index:
  `(tenant_id, created_at)`). Cost: one indexed count per request — fine at
  pilot scale (thousands of requests/min per key would need a real counter;
  see the comment in `_pilot/rate_limit.ts`).
* `vton_rate_limit_per_min` / `vton_monthly_cap` — the spend controls for the
  GPU route, checked **before** any render or try-on work starts:
  * the per-minute check is per API key, same rolling 60 s window as
    `rate_limit_per_min`; over it the API answers `429 rate_limited` with
    `Retry-After: 60`.
  * the monthly check spans **every key of the tenant**, so issuing a second
    key does not buy a second month; at the cap the API answers
    `402 quota_exceeded` and names the reset date.
  * calls refused by these checks (429/402) are metered like every other
    call but are **not counted** against the quota, so hammering the limit
    cannot exhaust the month by itself.
  * `/vton` **fails closed**: if the usage count cannot be read, the call is
    refused with `503 quota_unavailable` + `Retry-After: 30` rather than
    letting an unaccounted GPU job through. Every other route keeps the
    original fail-open behaviour for its rate limit.
  * counting rows is racy by design: concurrent calls can all read "under
    cap", so a burst can overshoot by roughly the per-minute allowance. That
    is acceptable for a spend ceiling (and much cheaper than an atomic
    reservation); tighten `vton_rate_limit_per_min` if you need a harder one.
  * `op=look` runs TWO GPU stages (render + try-on) but counts as ONE call,
    because the meter counts requests. Price accordingly.
* `combos` — the ONLY source of occasions: `GET /occasions` lists its keys,
  `POST /combos` looks the requested occasion up in it, and an unknown
  occasion is answered `422 unsupported_occasion` listing the valid ones.
  Nothing in the API layer hardcodes an occasion name.
