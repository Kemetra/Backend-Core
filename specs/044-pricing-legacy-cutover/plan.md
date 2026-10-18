# Spec 044 — Pricing migration and authority cutover from the legacy price fields (plan)

| | |
|---|---|
| **Jira** | RT-485 (RT-282 PR-03). Builds on RT-483 / spec 041 and RT-484 / spec 042 |
| **Work Mode** | Planning. This file is the deliverable. No code, OpenAPI, migration, package or CI change |
| **Repository** | `Kemetra/Backend-Core` |
| **Baseline** | `origin/main` @ `c6635b8` (2026-10-18). The ticket names `ddae78a7`; every anchor below was re-checked on `c6635b8` |
| **Decisions honoured** | Confluence RETAIL 23855106 §W, decisions 709–718 (mapped per the backlog: 709–711/713 import, 712 single writable authority, 713–715/717 dual read and compatibility, 716 override split, 718 rollback). Spec 041 OD-1–OD-6 and Q-1–Q-8; spec 042 §8 |
| **Depends on** | Spec 041 (model, OD-5, OD-6, Q-4, Q-6), spec 042 (Change Set, rollback, publish lock), spec 043 (RT-487, POS offline price activation: G4-2 pricing stream, G4-12 sellability, design §5.2 and §11). RT-281 (Assortment) and RT-294 (Fiscal) for the non-price halves of OD-5 |
| **Revision** | Merged as spec 043 in #827. Renumbered to 044, because RT-487 also took 043. §7 was revised to align with RT-487 / spec 043 (pricing stream G4-2, sellability G4-12, staged device switch, every-Store fan-out; MC-9 revised; MC-13, MC-14 and MC-15 added) |
| **Status** | PLANNED. The decisions in §11 are selected under the owner's standing delegation; the owner may revisit. OD-1–OD-6 themselves are still awaiting owner ratification on RT-483 (comment 12557); this plan rests on the selected options |

Everything below is a **proposal**. Tables, triggers, endpoints and jobs named here are created only by the
`[GATED]` Implementation items in §10, each needing explicit owner authorization on its own issue.

---

## 1. Objective

Move retail price authority from the two legacy columns to the Pricing domain (spec 041) **additively**:

- no Big Bang replacement;
- never two writable price authorities for one tenant at the same time (712);
- the switch happens per tenant, only after measured equivalence;
- every step can be rolled back without losing data or history, and without touching a sale fact.

## 2. Legacy inventory and current readers (re-verified on `c6635b8`)

### 2.1 Legacy price data

| Field | Shape | Constraints | Notes |
|---|---|---|---|
| `tenant_products.default_price`, `default_currency_code` | `numeric(19,4)`, `char(3)`, both nullable | paired (both null or both set); `>= 0` | One currency **per product**, not per tenant. `0` is allowed. Sub-minor values (e.g. `12.3456`) are storable |
| `store_product_overrides.price`, `currency_code` | as above | paired; `>= 0`; `at_least_one_override` (price, `is_active` or `tax_category` must be set) | Same row also carries `is_active` and `tax_category` (F11). One live row per `(tenant, store, product)` (`retired_at IS NULL` partial unique). `DELETE` is not prevented |
| `price_history` | append-only timeline (`effective_from/to`, optional `store_id`) | RLS forbids `UPDATE`/`DELETE`; one open interval per scope | **No writer exists** in `apps/api`, `apps/worker` or a trigger (F2). Expected empty; unproven on real DBs (§3) |
| `global_products.default_price` | global catalog suggestion | — | **Out of scope.** A template value for onboarding, never resolved for a sale |

### 2.2 Writers today

| Writer | Path | Effect |
|---|---|---|
| Seed CLI | `packages/db/src/cli/seed-catalog.ts:254` | Inserts `tenant_products` with `default_price` + currency |
| `StoreOverrideService.create` | `apps/api/src/modules/catalog/store-override.service.ts:197` | Inserts override rows. **Not registered in any module or controller** (F3), so unreachable over HTTP |
| Direct SQL by operators | — | Possible; nothing prevents it |

No HTTP price-authoring surface exists. Reconciliation `create-product`, unknown-items and ERPNext product
reconciliation write `tenant_products` **without** a price (grep on `c6635b8`: no `price` reference in those services).

### 2.3 Readers today

| Reader | Where | What it reads | Bearing on cutover |
|---|---|---|---|
| **POS read-down** (snapshot + deltas) | `apps/api/src/catalog/read-down/read-down.service.ts:355-384`; contract `catalog/read-down.yaml` (`/api/pos/v1/catalog/snapshot`, `/deltas`) | `COALESCE(spo.price, tp.default_price)` and `COALESCE(spo.currency_code, tp.default_currency_code)` at request time, then the sellable filter (`classifySellable`: priced, minor-unit representable, active, not retired) | **The only runtime reader of the legacy price columns.** It is what the cutover switches |
| **Catalog change log** (read-down deltas) | migration `0015`, triggers `catalog_change_log_from_tenant_products` / `_from_store_overrides` | Fires on any change of the price/currency columns (and `is_active`, `tax_category`, `name`, `retired_at`) | After cutover legacy price columns stop changing, so the catalogue `price` becomes a compatibility field; POS sells from the pricing stream instead (§7.1, §7.5) |
| **Admin-Console** | no Backend-Core endpoint returns `default_price` or override prices; `console-sales.openapi.yaml` exposes `unitPrice` **from frozen sale lines** | none | **No legacy-column reader.** Admin-Console can only read through Backend-Core contracts (architecture §4), so it has none either. The Admin-Console repo itself was not inspected |
| **ERP posting** | `apps/api/src/catalog/erpnext-posting/posting-work-item.projection.ts:242-295`; `erpnext-connector/posting-feed.yaml` | `sale_lines.unit_price`, `line_amount` — frozen sale facts | **No legacy-column reader.** The Connector posts the frozen sale rate with `ignore_pricing_rule=1` (G1, RT-380). The ERP item map is identity-only, with no price (`erpnext-item-map.yaml:16`). No Backend-Core → ERPNext Item Price push exists |
| **Sale capture / returns / history** | `apps/api/src/catalog/sales/**` | Request `unitPrice` from POS; frozen `sale_lines` | No legacy-column reader. Sale facts are never re-derived from the catalog |

**Conclusion.** The cutover changes exactly one runtime read path (read-down) and one change-feed (catalog change log).
ERP posting and Admin-Console are unaffected by construction, because both read frozen sale facts only.

## 3. Row counts on pilot and rt9 — evidence status

**NOT PERFORMED in this session.** This planning session has no database credentials or network path to the pilot or
rt9 databases (no `DATABASE_URL` or equivalent in the environment). The counts are therefore **not** recorded as
evidence here. This is the one RT-485 acceptance item this plan cannot close; §10 makes it the first slice
(**PR-03E**, Verification), and nothing in PR-16a may run on a real tenant before its output is attached.

The census to run, read-only, on each database. Run it as a role that bypasses RLS (a read replica or the migration
role), or per tenant with `app.tenant_id` set:

```sql
-- 1. Volumes
SELECT 'price_history'              AS what, count(*) FROM price_history
UNION ALL SELECT 'price_history_open',        count(*) FROM price_history WHERE effective_to IS NULL
UNION ALL SELECT 'tenant_products_live',      count(*) FROM tenant_products WHERE retired_at IS NULL
UNION ALL SELECT 'tenant_products_priced',    count(*) FROM tenant_products WHERE retired_at IS NULL AND default_price IS NOT NULL
UNION ALL SELECT 'overrides_live',            count(*) FROM store_product_overrides WHERE retired_at IS NULL
UNION ALL SELECT 'overrides_priced',          count(*) FROM store_product_overrides WHERE retired_at IS NULL AND price IS NOT NULL
UNION ALL SELECT 'overrides_is_active_only',  count(*) FROM store_product_overrides WHERE retired_at IS NULL AND price IS NULL AND is_active IS NOT NULL
UNION ALL SELECT 'overrides_tax_only',        count(*) FROM store_product_overrides WHERE retired_at IS NULL AND price IS NULL AND tax_category IS NOT NULL
UNION ALL SELECT 'stores_active',             count(*) FROM stores WHERE is_active
UNION ALL SELECT 'stores_all',                count(*) FROM stores
UNION ALL SELECT 'sweep_pairs_all_stores',
  (SELECT count(*) FROM stores s JOIN tenant_products tp ON tp.tenant_id = s.tenant_id
    WHERE tp.retired_at IS NULL);

-- 1b. Sweep-set size per tenant (drives the MC-8 single- vs two-phase choice; matches the §5.1
--     sweep set: every Store, active or not, x live product, plus one Book-layer check per live product)
SELECT tp.tenant_id,
       count(s.id)           AS store_pairs_all_stores,
       count(DISTINCT tp.id) AS book_layer_checks
  FROM tenant_products tp
  LEFT JOIN stores s ON s.tenant_id = tp.tenant_id
 WHERE tp.retired_at IS NULL
 GROUP BY 1;

-- 2. Exception census (per tenant): every row here blocks that tenant's cutover (§4.4)
SELECT tenant_id, 'zero_price' AS cls, count(*) FROM tenant_products
  WHERE retired_at IS NULL AND default_price = 0 GROUP BY 1
UNION ALL SELECT tenant_id, 'zero_price_override', count(*) FROM store_product_overrides
  WHERE retired_at IS NULL AND price = 0 GROUP BY 1
UNION ALL SELECT tenant_id, 'sub_minor_EGP', count(*) FROM tenant_products   -- exponent 2; repeat per currency
  WHERE retired_at IS NULL AND default_currency_code = 'EGP' AND default_price <> round(default_price, 2) GROUP BY 1
UNION ALL SELECT tenant_id, 'sub_minor_EGP_override', count(*) FROM store_product_overrides
  WHERE retired_at IS NULL AND currency_code = 'EGP' AND price <> round(price, 2) GROUP BY 1;

-- 3. Currencies in use per tenant (a v1 Book has exactly one)
SELECT tenant_id, default_currency_code AS ccy, count(*) FROM tenant_products
  WHERE retired_at IS NULL AND default_price IS NOT NULL GROUP BY 1, 2
UNION ALL SELECT tenant_id, currency_code, count(*) FROM store_product_overrides
  WHERE retired_at IS NULL AND price IS NOT NULL GROUP BY 1, 2;

-- 4. Store time zones per tenant (drives §4.2 bound rule)
SELECT tenant_id, timezone, count(*) FROM stores WHERE is_active GROUP BY 1, 2;
```

The PR-03E record must state, per database: the `origin/main` deploy SHA, the run time, and the results of all four
queries (including 1b). If `price_history` is non-empty, it also records whether every open interval equals the current legacy value.

## 4. Backfill into the new model (PR-16a)

### 4.1 Tenant bootstrap

For each tenant, the import first creates (once, idempotently) the v1 structure of spec 041 OD-1:

- one retail **Price Book**. Both of its declared attributes are **per-tenant inputs** to the import (decision MC-10),
  and the import refuses to run without them:
  - `currency_code`. It must equal the tenant's single legacy currency when the tenant has priced rows (§4.4 rejects
    tenants with more than one). A tenant with **no priced rows at all** still gets its Book from the declared
    currency, so the resolver answers `unpriced(no_price)`, which §5.2 treats as equivalent to legacy unpriced. It never
    answers `no_price_book`.
  - `tax_price_basis`. Legacy data carries no basis, and Pricing must not guess a Fiscal fact (G3, RT-294).
- its default **Zone** (`is_default = true`, immutable per Q-8). No other Zones and no memberships are created; every
  Store falls back to the default Zone, which reproduces the legacy two-level `Store ⊕ tenant` shape exactly.

### 4.2 Mapping

| Legacy (live rows only) | Pricing event |
|---|---|
| `tenant_products` with `default_price IS NOT NULL` and `retired_at IS NULL` | `scope = book`, `product_id`, `sell_unit = 'each'`, `price_kind = 'regular'`, `price`, `currency_code` |
| `store_product_overrides` with `price IS NOT NULL` and `retired_at IS NULL` | `scope = store`, `store_id`, same key fields |
| Override rows with `price IS NULL` | **No event.** The legacy `COALESCE` falls through to the tenant price, and so does the resolver (Store layer empty → Book layer) |
| Retired rows | No event |
| Products with `is_active = false` (tenant or override) | **Imported.** Price and assortment are separate (OD-5); read-down keeps excluding them through `is_active` |

Every imported event carries `source = 'legacy_import'`, `change_set_id` of a system **legacy-import change set**, and
`published_in_revision` = a revision of `kind = 'legacy_import'` (spec 041 data-model §2.4–§2.5). The change set is
created by the system actor, skips approval (it changes no resolved price, by construction), and still runs the
spec 041 §5 validations except the past-dated rule (520), which the import is the governed exception to. It is
audited like any publish (one `audit_events` row per transition, spec 042 §10).

**Time basis and bounds (decision MC-1).** Spec 041 Q-6 forbids mixing `store_local` and `absolute` events in one key,
and authors work in `store_local` by default (Q-1). If imported events were `absolute`, the first ordinary price change
on an imported key would have to supersede the whole import event and lose its open segment. So imported events use
`time_basis = store_local`:

- **Store-scope events:** `effective_from_local` = the import instant `T` expressed in that Store's zone. Exact, except
  when `T` falls in the later occurrence of a repeated wall-clock time (DST fall-back). Q-2 then resolves the local
  value to the earlier occurrence, so the event starts at most one overlap earlier than `T`. That is still at or
  before `T`, so the current price is right at `T`.
- **Book-scope events:** `effective_from_local` = `T` expressed in the **westernmost** zone (smallest UTC offset at `T`)
  among **all** the tenant's Stores, active or not. A tenant with no Stores at all uses a declared reference zone
  instead (an MC-10 input), so the bound is always defined. Every Store then activates the event at or before `T`, so the current price is
  right everywhere at `T`. For a single-zone tenant (the pilot is all `Africa/Cairo`, to be confirmed by PR-03E query 4)
  this is exact. For a multi-zone tenant, history inquiry in the few hours before `T` in eastern Stores shows the
  imported value early; sale facts are unaffected.
- `effective_to_local` is null (open) on the initial import.

**Before the first import.** Pricing knows nothing earlier than the tenant's first import instant `T0` (unless
`price_history` supplies real history, §4.5). The tenant's `T0` is recorded (import watermark, §4.3) so PR-04's
historical inquiry can answer "before Pricing history for this tenant" instead of a misleading `unpriced`. Historical
sold prices remain answerable from sale facts.

### 4.3 Idempotent, repeatable delta import

The import is a worker/CLI job, re-runnable at any time while the tenant's authority is `legacy`:

1. Take the per-tenant pricing publish lock (spec 042 §8).
2. Record the watermark: `max(catalog_change_log.sequence)` for the tenant, plus the instant `T`.
3. Compute the desired event set from legacy (§4.2) and diff it against **every active event of the tenant's Book,
   whatever its `source` and scope**, current or future-dated. Before the first cutover only `legacy_import` events
   exist, because Pricing authoring is rejected under `legacy` (§6.1). After an R1 rollback (§8.2), events authored
   during the cutover period can still be active, so the diff reconciles them too:
   - **unchanged** → nothing;
   - **new** (price appeared, override added) → new event from `T`;
   - **changed** (price or currency differs) → supersede the old event and add a new one from `T`, with a carried-forward
     head `[old from, T)` (the supersede-and-replace rule of spec 041 §3.1);
   - **gone** (price set to null, override retired or deleted, product retired) → end the event at `T`, also by
     supersede plus carried-forward head;
   - **not representable in legacy**: every active `zone`-scope event, and every event that starts after `T` → ended at
     `T` (a current one) or `cancelled` (a future one). Legacy has no Zones and no time dimension, so after this step the
     Pricing timeline from `T` onward is exactly the legacy state.

   A key's desired event matches an existing active event only when scope, store, price and currency are equal **and**
   the event is **open-ended** (`effective_to` null, so it covers all of `[T, ∞)` like the legacy value). Whatever its
   source, a matching event is kept; it is never duplicated or overlapped. An event with the same value but a bounded
   end (for example one authored `[F, E)` during an earlier cutover period) does **not** match. It is superseded at `T`
   by an open replacement with the same value, so it cannot expire at `E` while the legacy value stays current.

   **Time basis of new and replacement events (Q-6).** A key never ends up with mixed bases among its active rows:
   - **Key already has active events:** the new or replacement event uses that key's existing basis. For example, a
     key holding an authored `absolute` event gets an `absolute` replacement from the instant `T`. Its carried-forward
     head keeps the same basis.
   - **Key has no active events:** the new event uses the MC-1 `store_local` rule (§4.2).
   - **Mixed bases already present** (which validation should have prevented): the import ends every active row of
     that key at `T` and writes one open replacement in the MC-1 basis, with no carried-forward head. History before
     `T` stays visible at earlier revisions.

   So the `legacy_import` publication, and the R1 transaction that runs it, never fails on the mixed-basis rule.
4. If the diff is empty, **no revision is created** (a repeat run is a no-op). Otherwise publish one `legacy_import`
   revision with its fan-out (spec 041 data-model §2.6).
5. Store the watermark row `(tenant_id, run_id, T, change_log_sequence, revision_no or null, counts by outcome)`.

The import never reads or writes anything except legacy price columns (read), Pricing tables and its own run table.
It refuses to run unless the tenant's authority is `legacy`, or `cutover_in_progress` when it is invoked by the
cutover procedure itself (§6.3 step 4). A scheduled or operator run sees `cutover_in_progress` as "refused".

Cadence before cutover: on demand, plus a scheduled run (recommended every 15 minutes, worker job) so shadow
mismatches from import lag stay small. Legacy writes are rare today (F3), so most runs are no-ops.

### 4.4 Exceptions — legacy values Pricing will not accept (decision MC-2)

| Class | Why Pricing rejects it | What the import does |
|---|---|---|
| `zero_price` | Q-4: `price > 0` in v1 | Not imported |
| `not_representable` | Minor-unit exactness (spec 041 §6) | Not imported |
| `foreign_currency` | One Book currency per tenant (472) | Not imported |
| `multi_currency_tenant` | Tenant has more than one legacy currency | **Whole tenant import refused** |

A skipped **override** is not neutral: legacy would serve the override (0 is served as sellable; a sub-minor value is
excluded as not representable), while the resolver would fall back to the Book price. So every exception is reported
per row and is a **cutover blocker** for that tenant. The fix happens on the legacy side, which is still the only
writable authority: an operator sets a valid price, retires the override, or deactivates the product. The next delta
import picks it up. No exception is ever "accepted" into Pricing.

### 4.5 `price_history` (decision MC-3)

- **Empty** (expected, F2): nothing to do. The table stays as is.
- **Non-empty:** import a key's closed intervals as historical `legacy_import` events, flagged in the run report, only
  when **all** of these hold for that key:
  - its open interval equals the current legacy value;
  - its intervals do not overlap;
  - every interval passes the same value checks as current prices: no zero price, minor-unit exact, and the Book
    currency (§4.4);
  - its bounds can be represented exactly as `store_local`, checked by **round trip**: every bound, converted to local
    time and back with the Q-2 rules, must give the original instant.
    - Store-level rows use that Store's zone. They fail only for a bound in the later occurrence of a DST fall-back
      hour.
    - Tenant-level rows additionally need all the tenant's Stores to share one zone, because a single local value read
      in several zones would shift the original instants. A tenant with no Stores round-trips them in its declared
      reference zone (§4.2, MC-10).

  Any other key's history is **not imported**. It is listed in the run report by reason, and its current event starts
  at `T` as in §4.2. Unimported history does not block cutover: historical sold prices are answered from sale facts,
  and `price_history` stays available read-only.
  - **Same basis as the rest of the key (Q-6).** Imported history events are `store_local`, with bounds converted
    exactly in the single applicable zone.
  - **Contiguous timeline.** The key's current event then starts at the converted `effective_from` of its open
    `price_history` interval, instead of `T0`.
  - **Result.** One key holds one contiguous `store_local` timeline, with no `absolute` events mixed in.
- In every case `price_history` is kept, read-only, until the retirement item (PR-16c). It is never rewritten.

## 5. Dual read and the evidence threshold (PR-11, PR-V1)

### 5.1 Shadow resolution (PR-11)

While a tenant's authority is `legacy`, read-down keeps serving the legacy `COALESCE`. For every row it serves, it also
runs the spec 041 resolver at `(now, head revision)` and compares, **without serving the result**. A nightly sweep
job does the same for every tenant that has been imported. Its **sweep set**, used by every sweep in this plan
(nightly, cutover and R1), is:
- every `(Store × live product)` pair over **all** the tenant's Stores, active or not. Stores that never call
  read-down, and inactive Stores whose overrides would come back on reactivation, are both covered;
- a **Book-layer check** for every live product: legacy `default_price`/currency against the Book-scope resolution at
  `now`, evaluated in the MC-1 zone, which is the declared reference zone for a tenant with no Stores. This runs even
  when the tenant has no Stores, so the price a future Store would inherit is always compared.

### 5.2 Equivalence definition

For a pair `(store, product)`, legacy and Pricing are **equivalent** iff:

| Legacy | Pricing | Equivalent? |
|---|---|---|
| priced: `price`, `currency` (before the sellable filter) | `priced` with the same `price` (exact decimal compare at `numeric(19,4)` scale) and `currency` | yes |
| unpriced (`COALESCE` null) | `unpriced(no_price)` | yes |
| priced, but not representable | `unpriced(not_representable)` **or** `unpriced(no_price)` | yes (both not sellable); recorded with class `reason_only` |
| anything | `error(…)` | **never** |

`is_active`, `tax_category`, `name` and aliases are not compared: they do not come from Pricing (OD-5).
A second, **projection-level** check compares, for every pair legacy serves, the Pricing projection segment that
contains `now` (spec 043 §5.1) with the legacy row: amount as the same decimal string, currency, and sellability. This
catches formatting drift such as `12.5` vs `12.5000`. Products that are active but have no current price are expected
to differ *by design* after cutover (G4-12, §7.2), so they are not compared here.

### 5.3 Mismatch classes

| Class | Meaning | Allowed during the shadow window | Allowed at cutover |
|---|---|---|---|
| `import_lag` | A change-log row for this `(tenant, product, store or null)` has `sequence >` the last import watermark | yes (it is explained by construction) | no (cannot occur: legacy is frozen first, §6.3) |
| `blocked_exception` | Pair touches a §4.4 exception row | yes, but it is listed | **no** |
| `reason_only` | §5.2 row 3 | yes | yes |
| `unexplained` | Anything else | **no** — investigate before continuing | **no** |

Metric: `pricing_shadow_mismatch_total{class}` plus a per-tenant sweep report (counts by class, the first N pairs per
class with ids only — no PII, §XIV).

### 5.4 Evidence threshold before cutover (decision MC-7)

PR-V1 attaches, per tenant, before PR-16b may run:

1. **rt9 (lab tenant):** one full rehearsal. Initial import, then at least one legacy price change, one override added
   and one override retired, each picked up by a delta import, plus one seeded fixture per §4.4 class (shown blocked,
   then fixed). The final sweep has 0 `unexplained` and 0 `blocked_exception`. A cutover **and a rollback** (§8) are then
   both run on rt9, and both of their in-transaction sweeps pass.
2. **Pilot tenant:** a shadow window of at least **7 consecutive days, including a weekend**. Every nightly sweep reports
   0 `unexplained`. Every active Store has at least one online shadow comparison of a full snapshot. Any `import_lag`
   pairs are cleared by the next import. The exception census is 0 on the last day.
3. **At cutover** (inside the switch transaction, §6.3): a full sweep over the §5.1 sweep set, all Stores plus the Book-layer check, with **0 mismatches** of every
   class except `reason_only`.

## 6. Authority switch (PR-16b)

### 6.1 Single writable authority rule (712)

One per-tenant row decides **both** who may write prices and which source read-down serves, so the two can never
diverge (decision MC-4):

`tenant_pricing_authority(tenant_id PK, authority ∈ {legacy, cutover_in_progress, pricing}, changed_at, changed_by, changed_in_revision, authority_flip_sequence, run_id, reason)`
— RLS by tenant; every change also writes an `audit_events` row. `cutover_in_progress` is the frozen state of a
cutover that is running (§6.3). In the single-transaction path it is never committed; in the two-phase fallback it is
committed between phases, and an abort explicitly resets it to `legacy`. The migration that creates the table inserts a `legacy` row for
every existing tenant, and tenant creation inserts one, so the row **always exists** (the freeze in §6.2 relies on it).

| `authority` | Legacy price columns | Pricing authoring (spec 042 PR-10 API) | `legacy_import` job | What POS sells from (catalogue `pricingAuthority` / pricing manifest `authority`) |
|---|---|---|---|---|
| `legacy` (default) | writable | **rejected** (`409 pricing_authority_legacy`) | allowed | catalogue row price, legacy `COALESCE` (+ shadow); both flags read `legacy` |
| `cutover_in_progress` | **frozen** (§6.2) | **rejected** | allowed **only** for the cutover's own final import; scheduled and operator runs refused | legacy `COALESCE` (+ shadow) |
| `pricing` | **frozen** (§6.2) | allowed | **refused** | the applied pricing projection (spec 043 G4-12); the catalogue also lists active products without a current price; both flags read `pricing` |

Only the cutover (§6.3) and rollback (§8) procedures change the row, under the pricing publish lock.

### 6.2 Freeze mechanism (decision MC-5)

A `BEFORE INSERT OR UPDATE OR DELETE` trigger on `tenant_products` and `store_product_overrides`. When the row's tenant
has `authority` ∈ {`cutover_in_progress`, `pricing`} (any non-`legacy` state, including the committed first phase
of the two-phase fallback), it rejects:

- any change of `default_price`/`default_currency_code`, or `price`/`currency_code`;
- an `INSERT` that sets a price;
- a `DELETE` of an override row whose `price` is set;
- a change of `retired_at` (retire or reactivate) on an override row whose `price` is set, **while the tenant is
  `cutover_in_progress`**. Legacy read-down joins only non-retired overrides, so retiring one would switch the served
  price between the final import and the flip. Under `pricing` the legacy price is not served, so retiring is allowed:
  Assortment (still on legacy until RT-281) can retire such rows, and R1's reverse projection rebuilds override rows
  anyway.

The trigger reads the tenant's authority row with `SELECT … FOR SHARE`. A legacy price write that starts while a
cutover holds the row `FOR UPDATE` therefore waits, then re-reads the committed value: `pricing` after a successful
cutover (the write is rejected), `legacy` after an aborted one (the write proceeds). So no legacy write can commit
between the final import and the flip, which plain MVCC reads would allow. Legacy price writes are rare (F3), so the
share lock costs little.

Changes to other columns still go through: `name`, `is_active`, `tax_category`, aliases, and `retired_at` on rows with no
price. Assortment and
Fiscal stay on legacy until RT-281 and RT-294.

**The only bypass is a database privilege, not a setting.** A session variable (GUC) would not do: the runtime role
that does catalog DML could set it itself.
- The bypass is a dedicated `NOLOGIN` role, `pricing_projection_writer`.
- That role owns one `SECURITY DEFINER` function, `pricing_reverse_project(tenant_id, …)`. The function is the only
  code that writes frozen price columns.
- The trigger allows a frozen write only when `current_user = 'pricing_projection_writer'`. That is true only inside
  the function.
- `EXECUTE` on the function is granted to the operator/migration role the rollback CLI (§8.2) runs as, never to the
  API or worker runtime role.

So direct SQL by the runtime role cannot defeat the freeze. Being DB-enforced, the freeze covers the seed CLI, the orphan `StoreOverrideService` and direct SQL alike.
The seed CLI and `StoreOverrideService` also get an application-level check, so they fail with a clear message rather
than a trigger error.

### 6.3 Cutover procedure, per tenant (decision MC-8)

One transaction, run by an operator CLI (no new OpenAPI), recorded in a `pricing_cutover_runs` row whatever the result:

1. Preconditions, checked before opening the transaction: PR-V1 evidence attached for this tenant; exception census 0;
   PR-11 shadow deployed and live for at least the shadow window; **device readiness** (§7.3) met for every active
   device of the tenant; the rollback procedure
   (§8) deployed.
2. `BEGIN`; take the pricing publish lock; `SELECT … FOR UPDATE` the authority row. From here every concurrent legacy
   price write for the tenant waits on this row (§6.2).
3. Freeze legacy for the tenant: set `authority = 'cutover_in_progress'`, which the trigger treats as frozen and which
   the cutover's own import (step 4) is allowed to run under (§4.3). It is not committed in this path.
4. Final delta import (§4.3) inside the same transaction.
5. Full sweep (§5.4 item 3). Any mismatch other than `reason_only` → `ROLLBACK`. Nothing is changed: legacy stays
   writable and authoritative, no import revision from step 4 survives, and the run row (written in a separate
   autonomous step after the rollback) records the failure and its first mismatches.
6. Flip, in the same transaction:
   - publish one revision fanned out to **every** Store of the tenant (bootstrap rows at head, spec 041 data-model
     §2.6), so every device has a projection pair to apply (spec 043 §11, item 2);
   - set `authority = 'pricing'` and `changed_in_revision` = that revision. The catalogue `pricingAuthority`, the
     catalogue sellable filter and the pricing manifest `authority` all read this one row, so they flip together
     (spec 043 §11, item 1);
   - **advance** the change-log sequence: allocate a fresh value with `nextval` on the `catalog_change_log` sequence,
     so no row is inserted and the change-log shape is unchanged. Record it on the authority row as
     `authority_flip_sequence`. Every cursor issued before the flip, including a fully caught-up one equal to the old
     head, is now below it. Catalogue deltas answer `snapshot_required` (409) to any cursor below it (§7.3). A
     snapshot taken after the flip returns the cursor `max(head, authority_flip_sequence)`, so it never sits below
     the flip and never loops on 409;
   - **re-check device readiness** (§7.3) inside the transaction. In the two-phase path, time can pass between
     step 1 and the flip. A device that failed readiness in the meantime aborts the flip;
   - write the audit row and `COMMIT`.

`statement_timeout` for the transaction is set from the PR-03E pair count. If the count makes a single transaction
unreasonable (proposed threshold: more than 500 000 sweep-set rows for one tenant, i.e. `store_pairs_all_stores + book_layer_checks` from census query 1b), the fallback is a two-phase switch:
commit `cutover_in_progress` as its own step, then import and sweep, then flip to `pricing`; an abort explicitly resets
the row to `legacy`. While it is committed, legacy prices are frozen and read-down still serves the legacy `COALESCE`. For the pilot
size this is not expected to be needed; PR-03E settles it.

Order: rt9 lab tenant first (PR-V2 needs it cut over), then the pilot tenant. One tenant at a time.

**New tenants (decision MC-11).** Until the pilot tenant has been on `pricing` for a full rollback window (§8.4) without a
rollback, new tenants start on `legacy`.

After that, tenant creation takes the MC-10 inputs (Book currency, tax-price basis, reference zone). In the same
transaction it creates the tenant's Price Book and default Zone, the §4.1 bootstrap without an import, and only then
inserts `authority = pricing`. A tenant created without those inputs starts on `legacy`, so no tenant can be on
`pricing` without a Book (`no_price_book`). No legacy price is ever written for a tenant born on `pricing`.

### 6.4 What legacy columns mean after cutover (decision MC-6, 714)

After the flip the legacy price columns are a **frozen compatibility snapshot**: they hold the prices as of the cutover
instant and are not maintained. They are not read by any Backend-Core path (§2.3 shows read-down was the only reader,
and it now reads Pricing). Any new reader must call the resolver. They are refreshed in exactly one situation: the
rollback reverse projection (§8.2). They are dropped later by PR-16c.

## 7. POS impact and contract pins (OD-6; aligned with spec 043 / RT-487)

**Evidence for OD-6** (spec 043 decision record): POS validates read-down responses **leniently at runtime**, checking
required fields only and tolerating extra fields. But it **pins contract blobs** by SHA, so every Backend-Core contract
bump that POS adopts needs a POS re-pin in the same rollout. This plan was first written assuming strict validation.
The rule below holds either way: contract bumps travel with a re-pin, and **no device may sell under `pricing` before it
runs a build that understands it**.

### 7.1 How pricing reaches POS (spec 043 G4-2, decision MC-9)

- **Pricing travels on its own stream** (PR-06): `/api/pos/v1/pricing/manifest | snapshot | acks`, keyed by
  `(storeRevision, timeBasisEpoch)`. It sits next to the catalogue read-down, which is unchanged in shape apart from §7.2.
- The manifest carries the tenant's **`authority`** (`legacy` | `pricing`). That is the POS side of this plan's §6.1
  authority row, and both are the **same value**: the manifest reads `tenant_pricing_authority`, and
  `cutover_in_progress` is served as `legacy`.
- Under `legacy`, POS sells from the catalogue row price as today and does not consume the pricing snapshot. Under
  `pricing`, POS sells only from the applied projection (G4-12). A device never mixes the two.

This **replaces** this plan's earlier idea of a v-next read-down surface. It also amends the backlog's PR-11 row: PR-11
implements the shadow resolver and sweep. The new shape is PR-06's pricing stream, not a read-down variant.

### 7.2 What changes in the catalogue read-down (PR-11 / PR-16b, `[GATED OpenAPI]`)

Two additive changes, required by spec 043 §5.2:

- the snapshot response gains **`pricingAuthority`** (`legacy` | `pricing`). The device uses it for the staged switch
  (§7.3);
- under `pricing` authority the snapshot includes **active products without a current price**, so products with only
  a future price can be pre-delivered (G4-12). For those rows the row `price` becomes nullable. PR-11 makes that
  contract decision. Under `pricing` the row price is a compatibility field only, and POS ignores it for selling.

Both changes are one contract bump with a POS re-pin (OD-6 evidence). Under `legacy` authority the rows stay as they
are today, so the bump is safe to ship before any cutover.

### 7.3 Device readiness and the staged switch

- **Readiness, checked at cutover (§6.3 step 1, re-checked in step 6).** Every active device of the tenant must be on a POS build that
  implements PR-P1: pricing stream, staged switch and the re-pinned catalogue contract. The evidence is BC's
  `pricing_device_revision_state.last_check_at` (spec 043 §10.3): each active device has read the pricing manifest
  within the last 24 h (proposed). A device that has never read the manifest, or that runs an older build, blocks the
  cutover. An older build would treat a price-less catalogue row as unsellable or malformed.
- **Readiness kept after cutover (an ongoing gate).** A device enrolled, re-provisioned or downgraded after the flip
  must not get a `pricing` catalogue it cannot handle. For a tenant on `pricing`, the catalogue read-down (snapshot and
  deltas) requires the device to declare the pricing capability. This is a request header
  `X-Pos-Pricing-Capable: 1`, sent by PR-P1 builds and part of the same gated PR-11 contract bump. A device without it
  gets `409 pos_upgrade_required` and so cannot sync the price-less rows. It keeps its last catalogue, which was
  produced under `legacy` before the flip, and its manifest shows `pricing`. Under spec 043's staged switch it
  therefore keeps selling on legacy prices until upgraded. That residual risk is bounded and visible: Pricing Health
  flags the device, and the same header is checked on the pricing stream.
- **Staged switch on the device** (spec 043 §5.2).
  - When the manifest authority changes, the device keeps selling under its current authority and refreshes the
    catalogue.
  - It switches to `pricing` only after it has promoted a catalogue snapshot carrying `pricingAuthority: pricing` and
    has applied a pricing projection.
  - It switches back to `legacy` only after it has promoted a snapshot carrying `pricingAuthority: legacy`.
  - So after the cutover and after R1, every device must promote a **snapshot**: deltas alone never carry
    `pricingAuthority`, so a device that only reads deltas never completes the switch. Two mechanisms guarantee it
    (decision MC-15):
    - **device side:** spec 043 §5.2 already has the device fetch a full catalogue snapshot when the manifest
      authority differs from its own;
    - **server side, as enforcement:** each flip **advances** the sequence with `nextval` and records it as
      `authority_flip_sequence` (§6.3 step 6, R1). Catalogue deltas answer the existing `snapshot_required` (409) to
      any `since` cursor below it, and snapshot cursors are `max(head, authority_flip_sequence)`. A device fully
      synced at flip time, holding the old head, is therefore forced to re-snapshot. A device that re-snapshots
      after the flip is not forced again. A device that missed
      the manifest change is still forced onto a fresh snapshot. This changes server behaviour only; the 409 already
      exists in the contract.
- **Every Store needs a projection to apply** (spec 043 §11, item 2). At the flip, §6.3 step 6 publishes a revision
  that fans out to **every** Store of the tenant, using bootstrap rows at head (spec 041 data-model §2.6). So every
  device has a pair to apply before it can sell under `pricing`. Until a device applies one, it is `never_applied`
  and sells nothing, which is the intended fail-safe (spec 043 §5.4).

### 7.4 Sales and other surfaces

- PR-07 adds an optional sale-line `pricingCapture` and a sale-level `pricingContext` (spec 043 §9.1). They are request
  fields, so older builds keep working. The ongoing readiness gate (§7.3) means devices syncing a `pricing` catalogue run a build that sends them. They are not
  echoed in POS-facing responses until a re-pinned POS release accepts them.
- Admin-Console and the Connector need no change for the cutover (§2.3).

### 7.5 Change-log bridge — dropped (decision MC-13)

An earlier draft of this plan kept the catalogue `price` current after cutover by writing change-log rows at every
pricing boundary. Under §7.1 POS no longer sells from the catalogue price under `pricing`. The ongoing readiness gate (§7.3) keeps
older builds from syncing a `pricing` catalogue, and a device left on a pre-flip catalogue is flagged in Pricing Health. So that bridge and its state tables (watermark, emission dedup) are **not built**. The
catalogue `price` compatibility field is resolved at read time, at `now`, and may lag between catalogue snapshots.
Timed activation, expiry and Zone moves reach POS through the pricing stream, with pre-delivery and trusted-time
activation (spec 043 §6).

## 8. Rollback (718)

### 8.1 Principles

- **Nothing is deleted.** Pricing events and revisions are insert-only (530, 534); legacy rows are only updated
  through the §8.2 projection; `price_history` is untouched.
- **Sale facts are never rewritten.** No step touches `sale_lines`, sales, returns or the posting feed. Sale lines
  captured under Pricing keep their `pricing` provenance, whose `priceEventId` and revision still exist after a
  rollback.
- A rollback is itself audited and recorded in `pricing_cutover_runs`.

### 8.2 Levels

| Level | When | Procedure |
|---|---|---|
| **R0 — before cutover** | Import or shadow is wrong | Stop the import job. If needed, publish a `legacy_import` revision that ends the tenant's imported events from now (a cancel, not a delete). Legacy was authoritative throughout, so serving never changed |
| **R1 — tenant authority back to legacy** | After cutover; any reason | One transaction under the publish lock: (1) set `authority = legacy` (Pricing authoring now rejected); (2) **reverse projection** through the privileged `pricing_reverse_project` function (§6.2): for each `(store, live product)` over **every** Store of the tenant, active or not (a Store deactivated after a Store- or Zone-scoped change must keep its price for reactivation), resolve at `(now, head)`; independently of the Store loop, for **every live product** write its Book-layer price at `now` into `tenant_products.default_price` (currency from the Book). `store_local` Book events are evaluated in the MC-1 zone: the westernmost Store zone, or the declared reference zone for a tenant with no Stores. So a Store-less tenant's defaults are still refreshed, and a Store created after the rollback serves the current price; where a Store's resolved price differs from it, set the override price (insert a price-only override row if none exists); where it equals it, clear the override price, or retire the override row if price was its only content; for `unpriced`, clear the price (same rule); (3) run the §4.3 delta import in the same transaction (authority is now `legacy`): it ends Zone events and cancels future events, so the Pricing timeline from now on equals the projected legacy state and the shadow stays at 0 mismatches as time passes; (4) full §5.2 sweep over the §5.1 sweep set (all Stores plus the Book-layer check), legacy vs Pricing at `now`, must be 0 mismatches or the transaction aborts and the tenant stays on `pricing`; (5) because the authority row is now `legacy`, the catalogue `pricingAuthority`, the sellable filter and the pricing manifest `authority` all flip back together. Advance the sequence with `nextval` and record it as the new `authority_flip_sequence`, even if no catalogue row changed since the cutover. Catalogue deltas then force every device onto a fresh snapshot (§7.3). A device returns to the catalogue row price only after it has promoted a snapshot marked `pricingAuthority: legacy` (spec 043 §5.2, staged switch); (6) audit; commit |
| **R2 — code rollback** | A deploy must go back past PR-16b | **Not allowed while any tenant is on `pricing`**: older code would serve the frozen snapshot. R1 every such tenant first. The deploy checklist (PR-16b AC) states this, and the API refuses to start if the code version does not know the `authority` table but the table has a `pricing` row (a startup guard shipped one release ahead) |
| **R3 — schema rollback** | A Pricing migration must go down | Down-migrations of the Pricing tables (PR-05) **refuse to run** when they hold rows. The authority/freeze migration (PR-16a-1) refuses when any `tenant_pricing_authority` row is not `legacy`, or when `pricing_import_runs` / `pricing_cutover_runs` hold rows; the seeded all-`legacy` rows alone do not block it. Down never drops data |

What R1 does **not** carry back to legacy, and how that is handled:

- **Future-scheduled Pricing events** cannot be represented in legacy (no time dimension). Step 3 cancels them (a
  state change, not a delete), and the rollback report lists them so an operator can re-apply them by hand on legacy
  if needed. Leaving them active would make the shadow diverge when they activate.
- **Zones** are flattened: the reverse projection writes per-Store resolved prices as overrides, so current behaviour is
  preserved exactly.
- **History** remains in Pricing and stays queryable.

### 8.3 Re-cutover after a rollback

It follows §6.3 again. R1 step 3 already reconciled Pricing to the projected legacy state, so the re-cutover's delta
import only picks up legacy changes made since the rollback. It reconciles against every active event, not only
`legacy_import` ones (§4.3). Events authored in Pricing during the first cutover period stay as history: they are
superseded, ended or cancelled, never deleted.

### 8.4 Rollback window

**14 days** per tenant after cutover (proposed). During it, R1 is rehearsed once more on rt9 against post-cutover data
(after at least one real Change Set). PR-16c (legacy column retirement) cannot start before every tenant is past its
window.

## 9. OD-5 — splitting the legacy override row

| Column | Owner after split | This plan |
|---|---|---|
| `price`, `currency_code` | Pricing | Imported (§4) and cut over (§6). Frozen after cutover |
| `is_active` | Assortment (RT-281) | **Untouched.** Still read by read-down v1 through `COALESCE(spo.is_active, tp.is_active)`, still writable. RT-281 plans its own import, shadow and authority switch on the same pattern (a per-tenant authority row per domain) |
| `tax_category` | Fiscal (RT-294) | **Untouched.** Same as above, for RT-294 |

Consequences:

- After the price cutover, an override row may exist for `is_active` or `tax_category` alone. The price freeze (§6.2)
  allows that.
- An override row is only removable as a whole once **all three** domains have cut over. That is PR-16c's
  precondition, together with RT-281 and RT-294 delivering their switches.
- After the price cutover, what POS sells is therefore a composition: the price comes from the pricing stream, while
  `is_active` and `tax_category` still come from the legacy catalogue rows. The §5.2 projection check covers this
  composition.

## 10. Proposed Implementation slices

All slices are Backend-Core unless stated. `[GATED]` = touches a SQL migration or OpenAPI and needs explicit owner
authorization on its own issue. Mapping to the RT-282 backlog is shown.

| Slice | Backlog | Mode | Content | Depends on | AC (summary) |
|---|---|---|---|---|---|
| **PR-03E** | new (from this plan) | Verification | Run the §3 census on pilot and rt9 (read-only) | DB access for the operator | Results of all four queries per DB, with deploy SHA and time, attached to RT-485. Confirms or refutes F2 on real data; fixes the MC-8 single-vs-two-phase choice |
| **PR-05** | PR-05 `[GATED migration]` | Impl | Pricing tables per spec 041 data-model | PR-03 (this plan) | Already includes `source = legacy_import` and revision `kind = legacy_import`. **Add:** down-migration refuses when tables hold rows (R3) |
| **PR-16a-1** | PR-16a `[GATED migration]` | Impl | `tenant_pricing_authority`, `pricing_import_runs` (import watermarks), `pricing_cutover_runs`; the freeze trigger function on `tenant_products` and `store_product_overrides`, inert while every tenant is `legacy` | PR-05 | Up/down tests, RLS matrix; down refuses per R3 (a non-`legacy` authority row or any run row) and succeeds on seeded all-`legacy` rows; trigger unit tests for every case in §6.2, including the privileged bypass: a frozen write succeeds only through `pricing_reverse_project` as `pricing_projection_writer`, and is rejected for the runtime role even if it sets any session variable |
| **PR-16a-2** | PR-16a | Impl | Tenant bootstrap, initial and delta import job (worker + CLI), exception report | PR-16a-1, PR-09 (resolver), PR-03E | §4 behaviour; second run with no legacy change creates no revision; MC-10 input required; exception classes reported; refuses unless `authority = legacy`, or `cutover_in_progress` when called by the cutover |
| **PR-11** | PR-11 (amended by §7) | Impl `[GATED OpenAPI]` for the catalogue bump | Shadow resolver on read-down, nightly sweep job, mismatch metric and report. Catalogue read-down additions (§7.2): `pricingAuthority`, and price-less active rows under `pricing`. The ongoing readiness gate: `X-Pos-Pricing-Capable` header and `409 pos_upgrade_required`. Delta `snapshot_required` for cursors below `authority_flip_sequence`, and snapshot cursor `max(head, authority_flip_sequence)` (§7.3) | PR-09, PR-16a-2; PR-06 (spec 043 pricing stream, G4a) | §5.2/§5.3 classification; projection-level check; contract tests for the catalogue under both authorities; POS re-pin noted |
| **PR-V1** | PR-V1 | Verification | §5.4 evidence on rt9 and pilot | PR-11, PR-16a-2 | Thresholds of §5.4 met and attached per tenant |
| **PR-16b** | PR-16b | Impl | Cutover CLI (§6.3, including the every-Store fan-out revision, `authority_flip_sequence` with the delta 409 rule, and the device-readiness check before and inside the flip) **and** rollback R1 (§8.2) in the same item; app-level guards in seed CLI and `StoreOverrideService`; Pricing authoring gated by `authority`; R2 startup guard | PR-16a-2, PR-11, PR-V1, PR-10, PR-06 and POS PR-P1 rolled out to every device of the tenant | Abort path leaves the tenant byte-identical; rt9 cutover → Change Set → R1 round trip passes; sale tables checksum unchanged across cutover and rollback |
| **PR-16c** | new, later `[GATED migration]` | Impl | Retire legacy price columns and `price_history` (archive first); remove the v1 legacy path | Every tenant past its §8.4 window; RT-281 and RT-294 switches for the non-price columns | Not planned in detail here |

PR-16b may not ship without its rollback half: a cutover with no tested way back would break §8.

## 11. Decisions

Each one: **Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may
revisit.** Nothing here is in OpenAPI, a migration or code, so a reversal before PR-16a-1 merges costs a doc change.

| ID | Decision | Selected (recommended) | Alternatives considered |
|---|---|---|---|
| **MC-1** | Time basis of imported events | `store_local`; Store events at `T` in the Store's zone; Book events at `T` in the tenant's westernmost active zone (§4.2) | `absolute` instants, which needs a Q-6 amendment (a carry rule across bases) and makes the first ordinary edit of an imported key awkward |
| **MC-2** | Legacy values Pricing rejects (zero, sub-minor, foreign currency) | Not imported; each is a per-tenant **cutover blocker**, fixed on the legacy side (§4.4) | Import them with a waiver flag (breaks Q-4 and spec 041 §6); skip silently (makes overrides fall back to the Book price — a wrong price) |
| **MC-3** | `price_history` | Per key: import closed intervals only if consistent with current legacy, valid as Pricing values, and exactly representable as `store_local`; otherwise report only. Never blocks cutover; table kept read-only (§4.5) | Always ignore it; always import it |
| **MC-4** | Authority state | One per-tenant row that decides write authority **and** what POS sells from: the catalogue `pricingAuthority`, the sellable filter and the pricing manifest `authority` all read it, so they cannot diverge (§6.1, §7.1) | Two flags (write, serve), which can diverge |
| **MC-5** | Freeze | DB trigger on the legacy tables, per tenant, plus one privileged bypass: a `SECURITY DEFINER` function owned by a dedicated `NOLOGIN` role, executable only by the operator role (§6.2) | Application checks only (misses direct SQL and the seed CLI); revoking column privileges (not per tenant) |
| **MC-6** | Legacy columns after cutover | Frozen snapshot as at cutover; refreshed only by the R1 reverse projection (§6.4) | A maintained write-through projection, which needs an activation-time writer for a column nobody reads |
| **MC-7** | Evidence threshold | rt9 full rehearsal incl. rollback; pilot ≥ 7 days incl. a weekend with 0 unexplained; 0 mismatches in-transaction (§5.4) | 48 h window; in-transaction sweep only |
| **MC-8** | Cutover execution | One transaction per tenant; two-phase fallback only above ~500 000 pairs, as settled by PR-03E (§6.3) | Always two-phase |
| **MC-9** | How pricing reaches POS, and the contract pins | Follow spec 043 G4-2: a separate pricing stream (PR-06). The catalogue read-down gains `pricingAuthority`, and under `pricing` it lists active products without a current price. Each bump ships with a POS re-pin, and cutover requires every active device to be ready (§7.3). *Revised after RT-487; the first version proposed a read-down v2* | A read-down v-next surface (superseded by G4-2); a cutover with no device-readiness gate (unready builds would mis-sell price-less rows) |
| **MC-13** | Catalogue change-log bridge after cutover | **Dropped**: POS sells from the pricing stream under `pricing`, and readiness excludes builds that would not. The catalogue `price` compatibility field is resolved at read time (§7.5) | Build the boundary bridge and its watermark and dedup tables (only needed if a v1 price reader stays in service after cutover) |
| **MC-14** | Device readiness | At cutover, and again inside the flip: every active device of the tenant has read the pricing manifest within 24 h (`pricing_device_revision_state.last_check_at`). After cutover, an ongoing gate applies: catalogue reads for a `pricing` tenant require the `X-Pos-Pricing-Capable` header, otherwise `409 pos_upgrade_required` (§7.3) | Check readiness only at cutover (misses devices enrolled or downgraded later); rely on release dates or fleet version reports |
| **MC-15** | Making devices re-snapshot after an authority flip | Device-initiated snapshot on manifest authority change (spec 043 §5.2), enforced on the server by `authority_flip_sequence`, a value advanced with `nextval` at each flip. Deltas answer `snapshot_required` to cursors below it, and snapshot cursors are `max(head, flip)` (§7.3) | A change-log row per product (devices read it as deltas and never see `pricingAuthority`); adding `pricingAuthority` to delta pages |
| **MC-10** | Book `tax_price_basis` and `currency_code` for an existing tenant | Declared per-tenant inputs to the import, recorded with their evidence; no default. A tenant with no Stores also declares a reference zone for Book-scope bounds (§4.2). The currency must match the legacy currency when one exists, and it is still required for a tenant with no priced rows | Default to `inclusive` (a Fiscal guess, G3) |
| **MC-11** | New tenants | Start on `legacy` until the pilot has passed its rollback window on `pricing`. After that, start on `pricing`, with the Book and default Zone created atomically from the MC-10 inputs in the tenant-creation transaction; without those inputs, start on `legacy` | Start on `pricing` immediately after PR-16b ships |
| **MC-12** | Rollback window | 14 days per tenant (§8.4) | 7 days; open-ended |

## 12. Test plan

**Unit (Jest)**

- Import mapper: legacy rows → desired events, for every row of §4.2, including overrides with a null price and inactive products.
- Exception classifier: every class in §4.4, at `numeric(19,4)` edge values (`0.0001`, `12.345`, `12.3400`).
- `price_history` conversion (MC-3): closed intervals become one contiguous `store_local` timeline per key. A bound in the later occurrence of a DST fall-back hour fails the round-trip check, and its key is skipped. A Store-less tenant's tenant-level history round-trips in its declared reference zone.
- Delta matching: an open-ended event with equal value is kept. A bounded event with equal value is superseded by an open replacement. A bounded `absolute` event is replaced by an `absolute` replacement, so the key keeps one basis and R1 does not abort.
- Bounds: a tenant with only inactive Stores uses the westernmost zone among them; a tenant with no Stores uses its declared reference zone. A key with a zero, sub-minor or foreign-currency interval is skipped and reported. A tenant-level key in a multi-zone tenant is skipped and reported.
- Bound computation (MC-1): single zone; multi-zone tenant; a Store across a DST transition at `T` (Q-2 rules).
- Equivalence classifier: each row of §5.2 and each class of §5.3, including decimal formatting (`12.5` vs `12.5000`).
- Reverse projection planner: book/store split; override insert, clear and retire; `unpriced`.

**Integration (Testcontainers, `db-integration`)**

- Import idempotence: run twice with no legacy change → exactly one revision. Delta: price change, currency change, override add, retire and delete, product retire → one revision each with the right supersede and carried-forward rows.
- Import refused under `pricing`, and under `cutover_in_progress` unless called by the cutover; allowed there for the cutover's own final import; refused for a multi-currency tenant; refused without MC-10 inputs; a tenant with no priced rows gets a Book from the declared currency and resolves `unpriced(no_price)`.
- Freeze trigger under the two-phase fallback: with `cutover_in_progress` committed, legacy price writes are rejected. Retiring or reactivating a priced override is rejected under `cutover_in_progress` and allowed under `pricing`; retiring a price-less override is always allowed.
- Freeze trigger: under `pricing`, each legacy writer (seed path, `StoreOverrideService.create`, raw SQL `UPDATE`/`INSERT`/`DELETE`) is rejected; non-price columns still change; the runtime role cannot bypass the freeze, even with `set_config`; only `pricing_reverse_project` can.
- RLS: the new tables isolate tenants (the isolation-harness pattern); tenant A's cutover does not freeze tenant B.
- Cutover abort: inject one mismatch → `ROLLBACK`; tenant state, legacy rows and Pricing tables byte-identical to before; run row records the failure.
- Cutover success:
  - the catalogue snapshot carries `pricingAuthority: pricing` and lists active products without a current price;
  - the pricing manifest says `authority: pricing`, at the fan-out revision, for **every** Store;
  - `authority_flip_sequence` is above the pre-flip head. A device whose cursor **equals** the head at flip time gets `snapshot_required` (409). A snapshot taken right after the flip, with no new change-log rows, returns a cursor equal to `authority_flip_sequence`, and its next delta request succeeds;
  - for every pair legacy served, the projection segment at `now` equals the legacy price.
- Cutover blocked when one active device has no `last_check_at` in the readiness window, including when it lapses between step 1 and the flip (two-phase path).
- Ongoing gate: under `pricing`, a catalogue read without `X-Pos-Pricing-Capable` gets `409 pos_upgrade_required`; under `legacy` it is served as today.
- R1: the manifest and catalogue flip back to `legacy` together. The new `authority_flip_sequence` is above the previous one even when no catalogue row changed since the cutover, so devices that re-snapshotted after the cutover are forced to re-snapshot again.
- Re-import after R1: a Change-Set-authored Store event, a Zone event and a future event are reconciled (kept, ended or cancelled) with no overlap error; a second run is a no-op.
- R1 for a tenant with no Stores after a Book price change: `default_price` is refreshed from the Book layer.
- Sweep coverage: a tenant with only inactive Stores, and one with no Stores, still gets a full comparison, with the Book-layer check catching a wrong imported `default_price`.
- New tenant on `pricing`: created with MC-10 inputs, it has a Book and default Zone in the same transaction. Created without them, it starts on `legacy`.
- R1 with an inactive Store that holds a Store-scoped Pricing price: the price is projected into its legacy override and survives reactivation.
- Rollback R1 round trip: cutover → Change Set (Zone price plus a Store override) → R1 → the catalogue row price equals the resolver at the rollback instant; future events listed in the report.
- Sale-fact safety: checksum of `sale_lines` and the posting feed before and after cutover and R1 is identical.
- Migrations: up/down for PR-16a-1; down succeeds with only seeded `legacy` rows and refuses with a `pricing` row or a run row (R3).
- Scale: the sweep over a seeded tenant at the PR-03E pair count fits the MC-8 timeout.

**Runtime (rt9, then pilot)**

- rt9: the full §5.4 item 1 rehearsal, then PR-V2 runs on the cut-over lab tenant.
- Pilot: PR-03E census; import; 7-day shadow; cutover in a low-traffic window; first-day watch of `pricing_shadow_mismatch_total` (should be idle) and read-down error rates.

The 57P01 `db-integration` infra flake (repo CLAUDE.md) applies: diagnose the victim suite and error before any re-run.

## 13. Acceptance-criteria trace (RT-485)

| RT-485 scope item | Where | Status |
|---|---|---|
| 1. Row counts on pilot and rt9 | §3 | **Not met in this session**: no DB access. The census is specified and is slice PR-03E |
| 2. Initial price events with `source = legacy_import` | §4 | Planned |
| 3. Legacy fields as compatibility projections; single writable authority | §6.1, §6.2, §6.4 | Planned |
| 4. Dual-read equivalence check and evidence threshold | §5 | Planned |
| 5. Rollback keeping data and history; never rewriting sale facts | §8 | Planned |
| 6. Override split per OD-5 | §9 | Planned (Pricing part; RT-281 and RT-294 own the rest) |
| Also asked by the coordinator: readers inventory, POS pin impact, test plan, slices | §2, §7, §12, §10 | Planned |
| No code, migration or OpenAPI change | this PR | Met: docs only |
