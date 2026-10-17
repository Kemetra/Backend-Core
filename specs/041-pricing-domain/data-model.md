# Spec 041 — Data model (proposed)

> **Proposal only.** Nothing here is migrated. The tables are created by RT-282 PR-05 (`[GATED]` migration),
> which needs explicit owner authorization on its own issue. Column names follow the repo's Drizzle/SQL
> conventions (`snake_case`, UUIDv7 ids, `numeric(19,4)` money, `char(3)` currency, `timestamptz`).
> Every table has `tenant_id NOT NULL`, RLS by `tenant_id` (constitution §II), and `created_at / created_by /
> correlation_id` like the catalog tables. These common columns are not repeated below.

## 1. Entity overview

```
price_books 1──* price_zones 1──* price_zone_memberships *──1 stores
     │                │
     └────────────────┴──< price_events >── tenant_products
                               │
pricing_revisions 1──────────* ┘   (event.published_in_revision)
pricing_revisions 1──* pricing_revision_stores *──1 stores
change_sets (spec 042) 1──* pricing_revisions
```

## 2. Tables

### 2.1 `price_books`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `code` | text | unique per tenant |
| `name` | text | |
| `currency_code` | char(3) | one currency per Book (472) |
| `tax_price_basis` | text | `inclusive` \| `exclusive` (473). Declared only; Fiscal derives tax |
| `pricing_context` | text | `retail` only in v1 (474) |
| `is_default` | boolean | v1: exactly one default Book per `(tenant, currency, context)` (partial unique index) |
| `retired_at` | timestamptz null | Books are retired, never deleted |

Unique: `(tenant_id, code)`; `(id, tenant_id)` as composite FK target (the pattern of `uq_tenant_products_id_tenant`).

### 2.2 `price_zones`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `price_book_id` | uuid | composite FK `(price_book_id, tenant_id)` |
| `code`, `name` | text | unique `(tenant_id, price_book_id, code)` |
| `is_default` | boolean | exactly one per Book (partial unique index). Created with the Book (OD-1) |
| `retired_at` | timestamptz null | a Zone with active memberships or events cannot be retired |

`category_scope` is **not** added. Category-specific zones (493) stay a seam: a nullable column can be added
later without changing precedence.

### 2.3 `price_zone_memberships`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `price_book_id`, `price_zone_id`, `store_id` | uuid | composite FKs with `tenant_id`; the Zone must belong to the Book |
| `effective_from` | timestamptz | required |
| `effective_to` | timestamptz null | exclusive |
| `state` | text | `active` \| `superseded` |
| `published_in_revision` | bigint | the revision that created it |

Constraint: `EXCLUDE USING gist (tenant_id WITH =, price_book_id WITH =, store_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&) WHERE (state = 'active')` (494). Needs `btree_gist`;
whether the extension is already available is a PR-05 check.

Membership changes go through a Change Set (moving a Store needs an Impact Preview, 488). Memberships are
**absolute-instant** only; they are structural, not wall-clock price events.

### 2.4 `price_events`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | the `priceEventId` in provenance |
| `price_book_id` | uuid | composite FK with tenant |
| `scope` | text | `book` \| `zone` \| `store` |
| `price_zone_id` | uuid null | required iff `scope = zone` |
| `store_id` | uuid null | required iff `scope = store` |
| `product_id` | uuid | composite FK to `tenant_products (id, tenant_id)` |
| `sell_unit` | text | default `'each'` (OD-2). Becomes an FK to RT-281 Sell Units later |
| `price_kind` | text | `regular` in v1. `clearance` reserved (PR-13) |
| `price` | numeric(19,4) | `>= 0` check; v1 validation additionally requires `> 0` (Q-4) and minor-unit exactness |
| `currency_code` | char(3) | must equal the Book's currency (checked through a composite FK on `(price_book_id, currency_code)`) |
| `time_basis` | text | `store_local` \| `absolute` (spec §4.3) |
| `effective_from` | timestamptz null | set iff `time_basis = absolute` |
| `effective_to` | timestamptz null | |
| `effective_from_local` | timestamp (no tz) null | set iff `time_basis = store_local` |
| `effective_to_local` | timestamp (no tz) null | |
| `state` | text | `active` \| `superseded` \| `cancelled` |
| `published_in_revision` | bigint | |
| `ended_in_revision` | bigint null | the revision that superseded/cancelled it; makes as-of-revision reads a range test |
| `supersedes_event_id` | uuid null | lineage for "why" and audit |
| `change_set_id` | uuid | spec 042 |
| `source` | text | `change_set` \| `emergency` \| `rollback` \| `legacy_import` (RT-485) |

Constraints:

- Scope consistency checks (`zone ⇒ price_zone_id`, `store ⇒ store_id`, neither otherwise).
- Time-basis consistency checks (exactly one pair of bounds is set; `to > from` when present).
- Two exclusion constraints, one per time basis, over the key
  `(tenant_id, price_book_id, scope, coalesce(price_zone_id, store_id, nil-uuid), product_id, sell_unit, price_kind)`
  with the interval `&&`, `WHERE state = 'active'`. Mixed-basis overlap inside the same key is rejected at
  validation (a key may not mix bases while active; Q-6), so the DB pair is sufficient.
- Immutability: a trigger rejects any `UPDATE` other than `state` `active → superseded|cancelled` plus
  `ended_in_revision`. `DELETE` is not granted (534).

Visibility at revision R: `published_in_revision <= R AND (ended_in_revision IS NULL OR ended_in_revision > R)`.

Indexes: `(tenant_id, product_id, sell_unit, price_book_id) WHERE state = 'active'` for resolution;
`(tenant_id, published_in_revision)` for revision fan-out.

### 2.5 `pricing_revisions`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `revision_no` | bigint | monotonic per tenant, unique `(tenant_id, revision_no)`. Allocated under a per-tenant transaction advisory lock at publish, the pattern of `lockPostingFeedSequence` (RT-456). A gap-free counter is acceptable here because publish is serialized per tenant by design (spec 042 §6) |
| `change_set_id` | uuid | spec 042 |
| `kind` | text | `publish` \| `emergency` \| `rollback` \| `legacy_import` |
| `rolls_back_revision_no` | bigint null | for `kind = rollback` |
| `published_at` | timestamptz | |
| `published_by` | uuid | |
| `earliest_effective_at` | timestamptz null | earliest absolute instant any of its events can take effect (for scheduling and G4 pre-delivery) |

Insert-only. No `UPDATE` or `DELETE` (530).

### 2.6 `pricing_revision_stores`

Fan-out of which Stores a revision can change. It is computed at publish, from every event **and membership** row the revision
creates or ends:

- a Store event → that Store;
- a Zone event → every Store whose membership in that Zone intersects the event interval. For the Book's **default
  Zone**, it also reaches every Store that has **no explicit membership** in that Book for any part of the interval
  (spec 041 §4.2 step 4: those Stores fall back to the default Zone and have no membership row);
- a Book event → every Store using the Book;
- a Zone-membership change (`move_store_zone`, spec 042 §4.2) → the moved Store. The move changes which Zone prices
  apply to it even though no event scope changes.

The rule is "every Store whose resolved price *can* differ because of this revision". A Store that is missed keeps its
applied revision while its prices change, and POS, which applies whole store revisions (628), would never pick the
change up.

| Column | Type | Notes |
|---|---|---|
| `revision_no` | bigint | composite FK `(tenant_id, revision_no)` |
| `store_id` | uuid | |

PK `(tenant_id, store_id, revision_no)`. **Store applied revision** (OD-3) =
`max(revision_no) for the store`. It is monotonic per Store and sparse, like `catalog_change_log.sequence` (F12).
POS applies whole store revisions (628). Receipt/apply state per device is **not** here; it is PR-05's
G4a-gated table, shaped by RT-487.

## 3. What happens to the legacy columns (OD-5)

| Legacy | Becomes | Owner |
|---|---|---|
| `tenant_products.default_price`, `default_currency_code` | Book-scope `price_events` (import `source = legacy_import`) | Pricing (RT-485 / PR-16a) |
| `store_product_overrides.price`, `currency_code` | Store-scope `price_events` | Pricing |
| `store_product_overrides.is_active` | Assortment | RT-281 |
| `store_product_overrides.tax_category` | Fiscal classification | RT-294 |
| `price_history` | Kept read-only. Imported if it holds rows on pilot/rt9 (F2 is unverified on real data) | RT-485 |

Legacy columns stay the **only writable authority** until the per-tenant cutover (712, PR-16b). After cutover
they become read-only compatibility projections (714).

## 4. RLS and authorization notes

- All tables: `tenant_id = current_setting('app.tenant_id')` policies, like the catalog tables.
- Store-scoped readers (Store Manager, POS) are filtered to their stores in the service layer, as today
  (`store_access`). Store Managers may author only Store-scope events within bounds (spec 042 §7).
- No table stores PII (§XIV). `created_by` / `published_by` are user ids only.
