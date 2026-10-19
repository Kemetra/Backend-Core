# RT-743 — Console catalog list / search / get-one: decision record and contract proposal

> **Status:** decision record (Work Mode: **Planning**, contract-first). Every decision below is
> **Proposed, awaiting owner**, except **D6, Selected: (i), owner-approved 2026-10-19**. None is self-selected.
> **Jira holds the live status.** This file records the 2026-10-19 planning pass and is not a status tracker.
>
> No production code, OpenAPI, migration, package or CI change. Any contract change in §4 is a **proposal**.
> It is applied to `packages/contracts/openapi/**` only by a follow-up under its own `[GATED]` approval.
>
> **Sources:** Jira RT-743 (this item), RT-281 (catalog decomposition), RT-738 (console writes, Done),
> RT-724 (unknown-items RF-4b, Done, link deferred), RT-725 (ERPNext mapping screens, Done), RT-744
> (Unknown items sidebar ungate). Backend-Core `origin/main` **`6c14f5b`** (#862), inspected read-only.
> Admin-Console, ERPNext-Connector, POS and Orchestrator were **not inspected**. No runtime was exercised.
> Every row-volume and latency statement below is **NOT VERIFIED**.

---

## 0. Headline: the read RT-743 asks for is already on `main`

RT-743 says *"Backend-Core has no console catalog list/search contract"*. That was true when RT-724 and
RT-725 were written. It is **no longer true on `main`**: RT-729 (contract, #855) and RT-730 (runtime, #858)
shipped the console catalog read, and RT-738 (#860 / #862) added the writes on top. The same file names the
unknown-item link picker as a consumer (`console-catalog.yaml:7-8`, tag text `:231-236`).

| RT-743 scope item | On `main`? | Where |
| --- | --- | --- |
| Paginated product list | **Yes**: keyset, opaque cursor, `limit` 1..100 (default 50) | `consoleListCatalogProducts`, `GET /api/v1/catalog/products` (`console-catalog.yaml:242-283`) |
| Search by name / identifier | **Yes**: `q`, exact active `barcode`/`sku`/`plu` **or** case-insensitive name substring; identifier hits rank first | `console-catalog.yaml:78-92`, `:771-785`; SQL `console-catalog.service.ts:155-190` |
| Get-one | **Yes**: summary + description + active in-scope identifiers + in-scope store overrides | `consoleGetCatalogProduct`, `GET /api/v1/catalog/products/{productId}` (`console-catalog.yaml:343-380`) |
| Store-override visibility | **Yes**: `store_id` on the list adds a resolved `storeView`; the detail lists in-scope `storeOverrides` | `console-catalog.yaml:51-65`, `:806-816`; `StoreView` / `StoreOverride` schemas |
| Tenant isolation, roles, non-disclosing 404 | **Yes** | `console-catalog.yaml:41-76`; controller `:84-138` |

So this record **narrows the scope**. It proposes **no new operation**. What remains are the decisions
the console picker actually depends on (D1–D8). For each one the question is whether the existing
`1.1.0-draft` semantics are enough or need a small additive change. The recommended path (§4) is **no
contract change**. The RT-743 contract step then turns into console consumption plus at most one optional,
additive clarification.

---

## 1. Current state on `main` (file:line evidence)

### 1.1 Operations (`packages/contracts/openapi/catalog/console-catalog.yaml`, `1.1.0-draft`)

| operationId | Route | Roles | Rate class | Notes |
| --- | --- | --- | --- | --- |
| `consoleListCatalogProducts` | `GET /api/v1/catalog/products` | owner, tenant_admin, store_manager | `expensiveRead` (60/min/user) | `q`, `status` (default `active`), `category_id`, `store_id`, `cursor`, `limit` |
| `consoleGetCatalogProduct` | `GET /api/v1/catalog/products/{productId}` | owner, tenant_admin, store_manager | `cheapRead` (300/min/user) | any status, retired included |
| `consoleListCatalogCategories` | `GET /api/v1/catalog/categories` | owner, tenant_admin, store_manager | `cheapRead` | flat, unpaginated, non-retired |
| `consoleCreateCatalogProduct` … `consoleRetireStoreOverride` (7 writes) | `POST/PATCH/PUT …/products…` | W1 owner/tenant_admin; W2 + store_manager (availability) | write | RT-738; out of RT-743 scope |

Evidence: roles `console-catalog.controller.ts:84-89`, `:110-114`, `:134-138`; rate classes
`console-catalog.controller.ts:88-89` (comment "a name scan with no trigram index (O-8)"), `:114`, `:138`;
budgets `console-rate-limit/console-rate-limit.config.ts:39-40`.

### 1.2 Search, ordering, paging (as built)

* **Identifier match:** `product_aliases.value = q` byte for byte, `identifier_type IN (barcode, sku, plu)`,
  `retired_at IS NULL`. Tenant-wide aliases always count. Store-scoped aliases count only for live stores in the
  caller's scope, or only for `store_id` when it is given (`console-catalog.service.ts:157-167`;
  contract `:80-87`). `supplier_code` and `external_pos_id` are **not** searched.
* **Name match:** `name ILIKE '%q%' ESCAPE '\'` with `%`, `_` and `\` escaped (`console-catalog.query.ts:191-198`,
  `console-catalog.service.ts:179`). No trimming, no Unicode/Arabic normalization.
* **Order:** `(match_rank, name, id)`, where rank 0 is an identifier hit or no `q` (`console-catalog.service.ts:170`, `:181`).
  Names compare in the DB collation (contract `:96-106`).
* **Cursor:** opaque base64url byte layout `[version, matchRank, tenant, productId, filter digest, name]`, bound
  to the operation, tenant and a SHA-256 digest of `(q, status, category_id, store_id)`. The store scope is
  re-checked on every page, never carried (`console-catalog.query.ts:12-22`, `:129-189`; contract `:819-840`).
  Over-fetch by one row for `nextCursor` (`console-catalog.service.ts:30`).
* **Validation:** `.strict()` (an unknown key or a smuggled `tenant_id` is 400). `q` is 1..100 code points,
  well-formed and NUL-free. `limit` is a digit string 1..100 (`console-catalog.query.ts:43-69`).

### 1.3 Returned fields

`ConsoleCatalogProductSummary` (`console-catalog.yaml:963-1027`): `productId, name, status, categoryId,
categoryName, primarySku, primaryBarcode, defaultPrice, taxCategory, trackingMode, updatedAt`, plus optional
`storeView {storeId, effectivePrice, effectiveActive, effectiveTaxCategory, hasOverride}` (`:933-961`).
**Prices are already returned** (`defaultPrice`, `storeView.effectivePrice`, `StoreOverride.price`), as
exact-decimal strings with a currency (`:108-116`), never floats. No `created_by`/`updated_by` and no ERP mapping (`:124-126`).

### 1.4 Isolation

* Guards: `SessionOnlyAdminGuard → TenantContextGuard → RolesGuard`. Cookie session only; a bearer is 401
  (contract `:41-50`).
* Tenant from the session; every read under RLS. `tenant_products`, `product_aliases` and `store_product_overrides`
  are `ENABLE` + `FORCE ROW LEVEL SECURITY` (`packages/db/drizzle/0007_catalog.sql:181-182`, `:236-237`, `:310-311`),
  and every query also carries an explicit `tenant_id = $1` (`console-catalog.service.ts:161`, `:172`, `:187`).
* Non-disclosing 404, identical for: `store_staff`, an out-of-scope, soft-deleted or foreign `store_id`, a foreign
  product and an absent product. There is no 403 on the reads (contract `:67-76`, `NotFound` response).
  Soft-deleted stores: `liveStoreSql` (`console-catalog.service.ts:112-116`).

### 1.5 Indexes that serve it today

| Index | Serves | Evidence |
| --- | --- | --- |
| `idx_product_aliases_lookup (tenant_id, identifier_type, value) WHERE retired_at IS NULL` | identifier exact match (one probe per type) | `0007_catalog.sql:304-305` |
| `idx_tenant_products_tenant_active (tenant_id, id) WHERE retired_at IS NULL` | tenant scan for non-retired | `0007_catalog.sql:169-170` |
| `idx_tenant_products_tenant_category (tenant_id, category_id) WHERE retired_at IS NULL` | `category_id` filter | `0007_catalog.sql:172-173` |
| *(none)* | name substring; `ORDER BY name, id` | O-8: no trigram/full-text in v1 (contract `:91-92`) |

The name path is a scan of the tenant's products that pass the other filters, followed by a sort.
The list is classed `expensiveRead` (RT-619 / RT-574 D3), but that budget is **not yet a live control**:
`CONSOLE_RATE_LIMIT_MODE` defaults to `off` when unset (`console-rate-limit.config.ts:14`, `:50-51`), and `report`
mode lets over-budget requests through. Only `enforce` throttles, and switching any environment to it is RT-622
(owner). Until then, nothing bounds how often the un-indexed name scan runs. Even in `enforce` the guard **fails
open**: a limiter error, a limiter call over its timeout (250 ms default) or an open circuit breaker allows the request
(`console-rate-limit.guard.ts:22-25`, `:186-210`). So the budget is never a hard database-side bound.

### 1.6 What the consumers need from it

* **Unknown-item link** (`tenantAdminLinkUnknownItem`, deferred in RT-724). Roles owner / tenant_admin /
  store_manager (`reconciliation/reconciliation.controller.ts:172-178`). **Spec/runtime conflict.** FR-050(a) and
  FR-051 (`specs/005-pos-catalog-sync-reconciliation/spec.md:233-234`) require the target to be **active**: a retired,
  deleted "or any other non-active" target must fail closed with `target_unavailable`. Spec 007 (`spec.md:171`) and
  the controller docstring ("existing, active tenant product", `reconciliation.controller.ts:161`) say the same. The
  runtime checks only `retired_at` (`reconciliation/reconciliation.service.ts:364-377`), so it **accepts an inactive
  target today**, against the spec. The owner resolved this on 2026-10-19 (D6, **Selected: (i)**).
* **ERPNext suggest** (`tenantAdminSuggestErpnextItemMapping`, RT-725). Roles owner / tenant_admin only
  (`erpnext-item-map.controller.ts:89`, `:105`).
* **RF-3 catalog screens:** list, detail and the RT-738 write forms (the writes need `summary.updatedAt` and
  `StoreOverride.updatedAt` for `expectedUpdatedAt`, which are already returned).

---

## 2. Decisions

Each decision lists the options and marks one **Recommended**. **Every decision is Proposed, awaiting owner, except D6 (Selected: (i), owner-approved 2026-10-19).**

### D1 — Surface: new operation(s) or the existing reads?

| Option | For | Against |
| --- | --- | --- |
| **A. Use the existing `consoleListCatalogProducts` / `consoleGetCatalogProduct` unchanged (Recommended)** | Already contract-pinned, implemented and tested (`apps/api/test/catalog/console-catalog/console-catalog.{contract,unit,http.integration}.spec.ts`). Same roles, scope and 404 rules as the writes the console already uses. Zero Backend-Core work. | The picker takes the full summary projection (D4). |
| B. Add a dedicated picker op (`GET /api/v1/catalog/products/picker`) with a slimmer projection | Smaller payload; its own rate class. | Duplicates search, cursor, scope and isolation logic and its tests. Two search semantics to keep in step. No consumer need beyond payload size. |

**Proposed, awaiting owner.**

### D2 — Keyset pagination: cursor shape and sort key

| Option | |
| --- | --- |
| **A. Keep `(matchRank, name, productId)` with the opaque filter-bound cursor (Recommended)** | Stable total order (`productId` breaks ties). Identifier hits stay first across pages. The cursor is bound to tenant + filters and never carries scope (§1.2). It matches the `console-sales` / `shift-closes` convention. |
| B. Sort by `updatedAt DESC, productId` | Useful for a "recently changed" view, but wrong for a name picker; it can be added later as a `sort` parameter if RF-3 asks. |
| C. Offset paging | Unstable under concurrent writes and O(offset). Rejected by the repo convention. |

The walk is not a snapshot (contract `:100-106`). That is acceptable for a picker. **Proposed, awaiting owner.**

### D3 — Search semantics: identifier exact, name substring, normalization, Arabic

Today: exact identifier (`barcode` / `sku` / `plu`, byte-equal) **or** case-insensitive name **substring**.

| Sub-question | Options | Recommended |
| --- | --- | --- |
| D3a Name: prefix or substring | (i) keep substring; (ii) prefix only (`q%`), which could later use a btree `text_pattern_ops` index, but loses mid-name hits ("milk" in "Almarai milk 1L") | **(i) keep substring.** Changing to prefix would narrow existing semantics, which is breaking for RF-3. |
| D3b Identifier normalization | (i) keep byte-for-byte (leading zeros significant, no trim); (ii) trim or strip | **(i) keep.** It matches the RT-738 uniqueness rule (contract `:195-205`) and POS lookup. A scanner value must equal the stored value exactly. |
| D3c Identifier types searched | (i) keep `barcode`/`sku`/`plu`; (ii) add `supplier_code` | **(i) keep.** `supplier_code` can be added additively if an operator asks. `external_pos_id` stays out (it is keyed by `sourceSystem`). |
| D3d Arabic / Unicode folding | (i) none in v1: `ILIKE` folds Latin case only, so Arabic letter variants (أ/إ/آ/ا, ة/ه, ى/ي) and tashkeel/tatweel must match exactly; (ii) query-time folding (`translate()` on both sides plus diacritic strip); this widens matches, changes the `q` contract text, and blocks any future plain trigram index unless it is an expression index; (iii) a stored normalized-name column and its index (`[GATED]` migration) | **(i) for RT-743**, with D3d raised as a **separate planning follow-up** (F2). It is a real usability gap for an Arabic-first console, but it is a search-semantics decision with index consequences (D8). It should not be folded into a picker unblock. |
| D3e Whitespace in `q` | (i) verbatim (today); (ii) trim | **(i) verbatim on the server.** The console trims before sending (a client rule; no contract change). |

**Proposed, awaiting owner.** D3d is the main open question.

### D4 — Returned fields (prices)

The brief says "no prices unless justified". The existing projection **already returns** prices (§1.3), under the
RT-729 contract that the owner approved on 2026-10-19.

| Option | |
| --- | --- |
| **A. Keep the projection as is; the picker simply does not render price (Recommended)** | Removing `defaultPrice` / `effectivePrice` is a **breaking** change to a pinned, owner-approved contract that RF-3 needs (catalog screens show the price the POS resolves). Read access to price is not the risk RT-738 O-2 excluded; O-2 excluded price **writes**. All three allowed roles already see sale prices on `console-sales`. |
| B. Add a `fields=picker` / `view=compact` query parameter that omits money | Additive and smaller payload. Adds a cursor-digest input and a second response shape. No security gain (same roles can call without it). |
| C. Remove prices | Breaking; contradicts RT-729. |

**Proposed, awaiting owner.**

### D5 — Store-override visibility

| Option | |
| --- | --- |
| **A. Keep: tenant data for every allowed role; store data (`storeView`, store-scoped identifiers, overrides) limited to the caller's store scope; soft-deleted stores absent (Recommended)** | Already the rule (contract `:51-65`; owner decision O-7 and the RT-730 soft-delete decision). A picker that needs a store's effective availability passes `store_id`. `storeView.effectiveActive: false` is shown, not filtered (contract `:805-817`). |
| B. Add a `store_id` **filter** mode (only products the store sells) | Useful for a store-manager catalog screen, but not needed to pick a link target: the link binds a tenant-wide or store-scoped **identifier** to a **tenant** product. It can be added additively later if RF-3 asks. |

**Proposed, awaiting owner.**

### D6 — Roles, and which products the picker offers

Roles: **mirror the existing reads**: `owner`, `tenant_admin`, `store_manager`; `store_staff` → 404. No change.
**Platform-admin exception:** a platform admin's human session passes `RolesGuard` before any membership-role match
(`apps/api/src/auth/roles.guard.ts:165-166`, RT-132 D6 / RT-149), in the session's tenant only, and the catalog
contract keeps that exception (`console-catalog.yaml:72-75`). The same `RolesGuard` bypass applies to the link and
suggest actions. Client gating must therefore show the picker (and the actions the API allows) when the session is
`is_platform_admin`, whatever its membership role. Better still, it can gate on the API's own 403/404 rather than
copying role codes.
The RT-725 suggest action is owner/tenant_admin (plus a platform admin); a store_manager can list but the console
hides that action. That is console gating, not a contract change.

Picker eligibility depended on a **spec/runtime conflict** (§1.6). The spec (FR-050(a) / FR-051) allows only an
**active** target. The runtime refuses only **retired** targets and so accepts inactive ones. The owner ruled for
the spec (below).

| Option | |
| --- | --- |
| **(i) Conform the runtime to FR-051; the picker uses the default `status=active` (Recommended)** | Keeps the spec as written and fails closed. The picker needs no contract change: the list default `active` is exactly the set of valid targets. The runtime fix (add `is_active` to the target check in `reconciliation.service.ts:364-377`, mapping an inactive target to `target_unavailable`) is a **separate Implementation follow-up** (F6 = **RT-745**), outside RT-743. The server still answers `target_unavailable` if a product is retired or deactivated between pick and link. |
| (ii) Amend FR-050(a) / FR-051 to allow inactive targets | Makes today's runtime correct. The picker would then need inactive products too: either `status=any` with retired rows disabled client-side, or a new `status=not_retired` filter (an additive `[GATED]` contract change). It changes link semantics, which needs explicit owner authorization (RT §9). |

**Selected: (i), owner-approved 2026-10-19** (RT-743 Jira comment 12996). The runtime is conformed to FR-051 via
follow-up **F6 = RT-745**; FR-050/051 are not amended. The picker uses the default `status=active` and does not offer inactive
products. The role part of D6 (mirror the existing reads) is unchanged and was covered by the same approval.

### D7 — Tenant isolation, RLS, non-disclosing 404

| Option | |
| --- | --- |
| **A. Unchanged (Recommended)** | Session-derived tenant; FORCE RLS plus explicit `tenant_id` predicates. Cursor bound to tenant and filters, never trusted for lookup. Scope re-checked every page. One 404 body for role, foreign, absent, out-of-scope and soft-deleted (§1.4). Nothing in RT-743 needs a new rule. |

The console must treat a 404 on get-one after a pick (the product was deleted or the role changed) as "not available",
with no retry loop. **Proposed, awaiting owner.**

### D8 — Limits, rate limiting, index needs

**Limits:** `limit` 1..100, default 50; `q` 1..100 code points; cursor ≤ 4096 chars. Keep them as they are.

**Rate limiting:** the list is `expensiveRead`, 60 requests/min/user (`console-rate-limit.config.ts:40`). A typeahead
that fires per keystroke can spend that budget in well under a minute.

| Option | |
| --- | --- |
| **A. Console-side: debounce (≥ 300 ms), cancel in-flight requests, start a name search at ≥ 2 characters (an identifier scan may search at 1), and handle 429 + `Retry-After` (Recommended)** | No server change. The 429 contract already exists (`TooManyRequests`, contract `:1415-1440`). This is client discipline only. The server budget protects nothing until `CONSOLE_RATE_LIMIT_MODE=enforce` is set (§1.5), and even then it fails open on a limiter error, timeout or open breaker. Enforcement (RT-622) is therefore **necessary but not sufficient**: relying on the no-index path in production also needs F3 to show the measured query stays acceptable **unthrottled** (e.g. with concurrent scans during a limiter outage), or a database-side bound (an I-1 / I-2 index, or a statement timeout on this read). |
| B. Re-class the list to `cheapRead` | Drops the scan's budget class, the intended control for the un-indexed name scan (O-8) once enforcement is on. Not before D8 indexes exist. |
| C. A separate picker budget class | Server config change for one consumer; premature. |

**Index needs (future `[GATED]` migration only; not written here):**

| # | Candidate index | Serves | When |
| --- | --- | --- | --- |
| I-1 | `CREATE EXTENSION pg_trgm` + `GIN (name gin_trgm_ops)` on `tenant_products` (tenant-leading via a composite `btree_gin`, or a partial per status) | name substring `ILIKE '%q%'` | Only if `EXPLAIN (ANALYZE)` on a seeded large tenant shows the scan is too slow. Extension creation is an infra/ops decision as well as a migration. If D3d (ii)/(iii) is chosen, the index must be on the **normalized** expression or column instead. |
| I-2 | `btree (tenant_id, name, id) WHERE retired_at IS NULL` | the no-`q` list path `ORDER BY name, id` with keyset | Only if the unfiltered list is measured as slow; `match_rank` is constant 0 without `q`, so this index can serve the keyset seek. |

**Recommended:** no index in RT-743. Record I-1 and I-2 as candidates gated on measurement (F3). F3 measures the scan
as if unthrottled, because the limiter fails open (§1.5). Volume is NOT VERIFIED.
**Proposed, awaiting owner.**

---

## 3. What does **not** change

* All 10 operations of `console-catalog.yaml` keep their wire shape, version (`1.1.0-draft`), roles and errors.
* No write, audit, `catalog_change_log`, POS read-down or ERPNext behavior changes. Read-only.
* No migration, no package, no CI change.

## 4. Proposed contract shape

**Recommended: no OpenAPI change.** The console consumes `console-catalog.yaml` `1.1.0-draft` as it is:

```http
# Picker: identifier scan or typed name; default status=active = link-eligible under D6 (i)
GET /api/v1/catalog/products?q=6221234567890&limit=20
GET /api/v1/catalog/products?q=%D8%AD%D9%84%D9%8A%D8%A8&limit=20      # "حليب"
GET /api/v1/catalog/products?q=…&limit=20&cursor=<nextCursor>
# Optional store context (effective availability for one store in scope)
GET /api/v1/catalog/products?q=…&store_id=<uuid>
# Confirm the pick
GET /api/v1/catalog/products/{productId}
```

**Only if the owner picks one of the additive options**, the delta is one `[GATED]` minor bump
(`1.1.0-draft` → `1.2.0-draft`), non-breaking for the generated client:

* D6 (ii) only: `ProductStatusFilter.enum += not_retired` (`retired_at IS NULL`, either `is_active`). It is a cursor-digest input like
  every other filter value.
* D4-B: `view` query parameter, `enum [full, compact]`, default `full`; `compact` omits `defaultPrice` and `storeView.effectivePrice`.
  Not recommended.
* D3c-ii: `supplier_code` added to the identifier match list (description-only change plus runtime).

No contract clarification about link-target status is proposed until the owner resolves the D6 spec/runtime conflict.

## 5. Test plan

**If D1-A / no contract change (recommended):** no Backend-Core tests are added. The existing suites already cover the
behavior: `console-catalog.contract.spec.ts` (conformance), `console-catalog.unit.spec.ts` (cursor, query schema,
escaping) and `console-catalog.http.integration.spec.ts` (isolation, scope, 404 and paging). Before Admin-Console builds
the picker, the coordinator may run a **Verification** pass on those suites against `main` (`6c14f5b`) to produce
evidence, with no fix.

Admin-Console picker (follow-up F1) must test:
* identifier exact hit ranked first; leading-zero value matches only exactly;
* Arabic name substring returns the expected product (and documents that hamza and ta-marbuta variants do **not** match, per D3d-i);
* the picker offers only the targets the owner's D6 decision allows (`status=active` under D6 (i)); a `target_unavailable` race (product retired or deactivated after the pick) shows the contract copy;
* paging follows `nextCursor` until `null`; a 400 on a stale cursor restarts the search;
* 429 honours `Retry-After`; debounce keeps a normal typing burst under the budget;
* 404 on get-one after a pick → "not available"; `store_staff` never sees the picker;
* a platform-admin session (`is_platform_admin`) with no tenant membership role, or any role, sees the picker and the actions the API allows.

**If an additive option is chosen** (D6 (ii) `not_retired` / D3c-ii): contract conformance for the new enum value or match type;
a cursor-digest test (a cursor from `status=active` is a 400 under `not_retired`); isolation and scope tests repeated
for the new filter; unit tests for the SQL predicate.

**F6 / RT-745 (D6 (i), selected):** a link to an inactive product returns 409 `target_unavailable` and leaves the item `pending`; a link to an active product still succeeds; a retired product is still `target_unavailable`.

**If D8 indexes are later proposed (F3):** `EXPLAIN (ANALYZE)` on a seeded large tenant for (a) `q` name substring,
(b) `q` identifier hit, (c) no-`q` first page and a deep keyset page, each with and without `store_id`.

## 6. Known gaps

* **Arabic folding (D3d):** name search does not fold Arabic letter variants, diacritics or tatweel. This is a real gap for an
  Arabic-first console; see F2.
* **Link target status: runtime not yet conformed (D6).** D6 is **resolved**: Selected (i), owner-approved 2026-10-19.
  FR-050(a) / FR-051 stand as written. The implementation is **outstanding in RT-745 (F6)**. Until it merges, the runtime
  still accepts an inactive target (`reconciliation.service.ts:364-377` checks only `retired_at`). The picker uses
  `status=active` regardless, so it never offers one.
* **Name search is an un-indexed scan (O-8)**, and it is unthrottled today: the `expensiveRead` budget only applies once
  `CONSOLE_RATE_LIMIT_MODE=enforce` (default `off`; RT-622), and even then it fails open when the limiter is unavailable
  (`console-rate-limit.guard.ts:22-25`, `:186-210`). There is no database-side bound. Volume is NOT VERIFIED.
* **No "products this store sells" filter (D5-B).** `store_id` annotates rows; it does not filter them.
* **`supplier_code` is not searchable.**
* **Admin-Console not inspected:** whether its `contracts/backend-core/PIN` already includes `console-catalog.yaml`
  `1.1.0-draft` is unknown. RT-724 said it did not have a catalog read when it shipped.
* RT-743's own text ("no console catalog list/search contract") conflicts with `main`. The owner should restate RT-743's
  outcome from "write a contract" to "confirm the existing contract is sufficient".

## 7. Proposed follow-ups (not created)

| # | Proposed item | Mode | Repo | Gate | Depends on |
| --- | --- | --- | --- | --- | --- |
| F1 | Admin-Console: repin to `console-catalog.yaml` `1.1.0-draft` (if not already), build the product picker, deliver the `tenantAdminLinkUnknownItem` action and wire the RT-725 suggest action from the picker | Implementation | Admin-Console | PIN bump per its rules | Owner approval of D1/D6/D8 |
| F2 | Backend-Core: Arabic-aware catalog name search (D3d ii/iii), covering the folding rules, contract text and any index | Planning | Backend-Core | later `[GATED]` contract (+ migration if iii) | Owner wants it |
| F3 | Backend-Core: measure the console catalog list on a seeded large tenant **without throttling** (the limiter fails open), including concurrent scans; propose I-1/I-2 or a statement timeout if the unthrottled cost is not acceptable | Verification → Planning | Backend-Core | later `[GATED]` migration | none |
| F4 | Backend-Core: `status=not_retired` (only under D6 (ii)) and/or `supplier_code` search (D3c-ii) | Implementation | Backend-Core | `[GATED]` contract | Only if the owner picks them |
| F5 | Admin-Console: RF-3 catalog screens on the existing reads + RT-738 writes | Implementation | Admin-Console | none beyond PIN | F1 (shared client) |
| F6 = **RT-745** | Backend-Core: conform `tenantAdminLinkUnknownItem` to FR-051. An inactive target becomes 409 `target_unavailable` (`reconciliation.service.ts:364-377`) | Implementation | Backend-Core | none expected (no contract or migration change: `target_unavailable` already exists) | D6 (i) owner-approved 2026-10-19; created as RT-745 |

RT-744 (sidebar ungate) is independent of this record. The link action itself is F1.

## 8. Next safe action

D6 is settled (Selected: (i), 2026-10-19). The owner reviews the remaining decisions (D1–D5, D7, D8) and confirms
**D1-A (no new contract)**. F6 is RT-745 (runtime conformance to FR-051).
On D1-A, RT-743 needs no `[GATED]` contract PR, and the next work item is F1 in Admin-Console.
