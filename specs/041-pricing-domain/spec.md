# Spec 041 — Retail Pricing domain: model, resolution and inquiry

| | |
|---|---|
| **Jira** | RT-483 (RT-282 PR-01). Blocks RT-484, RT-485, RT-487, RT-488, RT-489 |
| **Work Mode** | Planning. This folder is the deliverable. No code, OpenAPI or migration |
| **Repository** | `Kemetra/Backend-Core` |
| **Baseline** | `origin/main` @ `ff9e6833` (2026-10-17). RT-282 decomposed against `ddae78a7`; the anchors below were re-checked on `ff9e6833` |
| **Decisions honoured** | Confluence RETAIL 23855106 (owner-approved 2026-10-07): 461–521, 563–572, 590–596 (interface only) |
| **Decision record** | [decision-record.md](decision-record.md) — OD-1 to OD-6 plus the open questions this spec raised |
| **Status** | PLANNED. Decisions selected under the owner's standing delegation of 2026-10-17 (see the decision record); the owner may revisit |

Companion files:

- [data-model.md](data-model.md) — proposed tables, keys and constraints (nothing is migrated).
- [plan.md](plan.md) — how this spec turns into the gated contract, schema and runtime items.
- Spec 042 ([../042-price-change-set-lifecycle/plan.md](../042-price-change-set-lifecycle/plan.md)) — RT-484, the Change Set lifecycle that is the only writer of the events defined here.

## 1. Objective

Replace today's single-level, timeless `COALESCE(store override price, tenant default_price)` with a governed,
effective-dated Retail Pricing domain owned by Backend-Core:

- a **Price Book → Price Zone → Store** model;
- a **price-event timeline** instead of current-value columns;
- a **pure, deterministic resolver** that returns a price *and its provenance*;
- first-class **current, future and historical inquiry**, and **"why this price"**.

## 2. What exists on `main` today (re-verified on `ff9e6833`)

| # | Fact | Evidence |
|---|---|---|
| F1 | Read-down resolves `COALESCE(spo.price, tp.default_price)` (and the same for currency, tax category and active flag) at the current instant only. No time dimension, no provenance. | `apps/api/src/catalog/read-down/read-down.service.ts:355-358` |
| F2 | `price_history` exists (effective_from/to, one open interval per scope, `price >= 0`) but **no runtime path writes it**. Only the test isolation harness inserts rows. | `packages/db/src/schema/catalog/price-history.ts`; grep of `apps/` |
| F3 | No HTTP price-authoring surface. `StoreOverrideService` is not wired into any module; only the seed CLI writes `default_price`. | `apps/api/src/modules/catalog/store-override.service.ts`; grep of `*module.ts` |
| F4 | Money is `numeric(19,4)`. ISO-4217 minor-unit exponents exist (`minorUnitExponent`). Read-down omits unpriced and non-representable rows. | `apps/api/src/catalog/sales/iso4217-minor-units.ts:52`; read-down |
| F6 | `sale_lines` freezes unit price, currency, quantity, amounts, unit; it has no pricing revision or provenance. | `packages/db/src/schema/sales/sale-lines.ts` |
| F8 | `stores.timezone` is an IANA name, now settable through the Store contract (spec 038, RT-401). It is not versioned. | `packages/db/src/schema/stores.ts`; `specs/038-store-timezone-contract/` |
| F9 | No Sell Unit / UOM in the catalog. `sale_lines.unit` is free text. | schema grep |
| F11 | `store_product_overrides` carries `price`, `currency_code`, `is_active` and `tax_category` in one row. | `packages/db/src/schema/catalog/store-product-overrides.ts:50-53` |
| F12 | `catalog_change_log` gives read-down a global monotonic `sequence`, filtered per tenant and sparse per store. It carries only `product_id` + `op`; rows are resolved at read time. | `packages/db/src/schema/catalog/catalog-change-log.ts` |

Everything in this spec is therefore **greenfield**, apart from the money rules (F4), which already hold and are kept.

## 3. Domain model (conceptual)

Full column-level proposal: [data-model.md](data-model.md).

| Concept | Definition | Decisions |
|---|---|---|
| **Price Book** | A tenant-owned set of regular prices in **one currency**, with a declared **tax-price basis** (`inclusive` or `exclusive`). | 471–473 |
| **Price Book assignment** | Which Book a Store uses for a pricing context. v1 has one context (`retail`) and one Book per tenant/currency, so the assignment is implicit (OD-1). | 474 |
| **Price Zone** | An independent commercial grouping of Stores *within one Book*. It inherits the Book's currency. It is not an Organization/Store Group. Each Book has one **implicit default Zone** (OD-1). | 483–486, 492 |
| **Zone membership** | Effective-dated: a Store belongs to exactly one Zone per Book at any instant. Gaps fall back to the default Zone; overlaps are invalid. | 485, 487, 494 |
| **Sell Unit** | Part of the price key. v1 has one implicit Sell Unit, `each` (OD-2). The key column exists so multi-UOM pricing (RT-281) is additive. | 475–476 |
| **Price event** | One immutable fact: *at scope S, item I in sell unit U costs P in Book B, from instant F (inclusive) until T (exclusive, optional)*. Scope is `book`, `zone` or `store`. Kind is `regular` in v1 (`clearance` later, PR-13). | 507–509, 513–514 |
| **Pricing Revision** | An immutable, tenant-wide, monotonically numbered publication of a Change Set's events (OD-3). Each event belongs to exactly one revision. | 528, 530 |
| **Store applied revision** | The number of the latest tenant revision that changed anything visible to that Store. Monotonic and sparse per Store. | OD-3 |
| **Provenance** | The identity of what produced a resolved price: source scope, event id, price kind, Book, Zone, revision. | 501 |

What the model deliberately is **not**:

- not a priority-ordered rule list (499–500): precedence comes from scope alone;
- not a promotion or discount engine (465, 537): those belong to the Offer Engine (RT-286) and act *after* the regular price;
- not a tax calculator (468, 590–591): see §7;
- not an ERPNext mirror (461–463, 506): ERPNext Price Lists are never read, and never a fallback.

### 3.1 Event lifecycle in one paragraph

Events are only created by publishing a Change Set (spec 042). An event's **price, scope, key and interval
are never edited**. A later Change Set that changes the timeline *supersedes* the affected events: it
publishes replacement events (for example a copy with an earlier `effective_to`) and marks the old ones
`superseded` in the same revision. A correction to history is a new event, never a rewrite (521, 534). A
**reset** of a Store override (491) is a superseding event set that ends the Store-scope interval, so the
inherited Zone/Book price applies again.

## 4. Resolution algorithm

### 4.1 Signature

```
resolve(item, sellUnit, store, instant, asOfRevision) -> Resolution
```

It is a **pure function** of its inputs plus the pricing data *visible at `asOfRevision`*. "Visible at R" means
the event was published in a revision ≤ R and was not superseded or cancelled by a revision ≤ R. The same
inputs always give the same output (496). `asOfRevision` defaults to the tenant's head revision.

The pair `(instant, asOfRevision)` makes inquiry **bitemporal**:

- *instant* = **when** the price applies (valid time);
- *asOfRevision* = **what we knew** (publication time).

"What price applied last Tuesday" uses the head revision. "What price did POS believe last Tuesday" uses the
revision the store had applied then.

### 4.2 Steps

1. **Book.** Take the Store's effective Book for the `retail` context. v1: the tenant's single Book (OD-1).
   No Book → `unpriced(reason: no_price_book)`.
2. **Candidate events.** Visible events with that Book, `item`, `sellUnit` and `price_kind = regular`, whose
   interval `[effective_from, effective_to)` contains `instant`.
3. **Store layer.** Candidates with `scope = store` and this `store`.
   - Exactly one → result, `sourceScope = store`.
   - More than one → `error(overlap_violation)`. It never picks one (498–500). This can only happen if a DB
     constraint was bypassed; it is reported, not resolved.
4. **Zone layer.** Find the Store's Zone membership at `instant` in this Book.
   - Exactly one membership → that Zone; none → the Book's default Zone; more than one →
     `error(ambiguous_zone_membership)` (494).
   - Exactly one candidate at `scope = zone` for that Zone → result, `sourceScope = zone`. More than one → `error(overlap_violation)`.
5. **Book layer.** Exactly one candidate at `scope = book` → result, `sourceScope = book`.
6. **Nothing found** → `unpriced(reason: no_price)`. Missing price means not sellable (480, 506). There is no
   ERP lookup and no legacy fallback inside the resolver; the legacy path lives outside it until cutover (PR-11/16b).
7. **Representability.** The price must be exact at the currency's minor unit (`minorUnitExponent`, F4). If not →
   `unpriced(reason: not_representable)`. Authoring rejects such prices (§6), so this is a defence-in-depth check.

Creation order, timestamps of authoring and numeric priorities play **no part** in any step (499–500).

### 4.3 The effective instant and store time (510)

Events store **absolute instants** (`timestamptz`). Authors usually think in store-local wall-clock time
("from 1 November, opening"), and a Book or Zone event can cover Stores in different time zones. So an event also records its **time basis** (`time_basis`):

- `store_local` (the default for authoring): the author enters a local date-time. The event stores the local
  value. Its instant **per Store** is that local value interpreted in the Store's IANA time zone
  (`stores.timezone`, F8). A Book event "from 2026-11-01T00:00 local" therefore activates at local midnight in
  every Store.
- `absolute`: the author enters an exact instant that is the same for every Store (emergency corrections, cross-zone
  campaigns).

The resolver converts `store_local` bounds to instants with the Store's zone before step 2. Two rules follow:

- **DST:** a local time that does not exist (spring-forward gap) resolves to the first valid instant after it. A
  local time that occurs twice (fall-back) resolves to the **earlier** occurrence. Both rules are fixed so the resolver stays
  deterministic.
- **Store time-zone changes** (spec 038, decisions 214–215) are not versioned on `main`. Historical inquiry for a
  `store_local` event therefore uses the Store's *current* zone. Sale facts are frozen, so no sale is affected.
  This is recorded as open question Q-3 in the decision record; it is acceptable for v1 because a zone change is
  blocked during open shifts and impact-reviewed.

Overlap validation (§5) is done **per Store on the converted instants**. Two `store_local` events in the same scope are
compared on their local values, since the same zone converts both.

### 4.4 Resolution result (draft shape, not OpenAPI)

```jsonc
// priced
{
  "status": "priced",
  "price": "125.5000",                 // decimal string, numeric(19,4) scale
  "currencyCode": "EGP",
  "taxPriceBasis": "inclusive",        // declared by the Book; Fiscal derives tax (§7)
  "sellUnit": "each",
  "provenance": {
    "origin": "pricing",               // the PR-06 / PR-07 union discriminator
    "sourceScope": "zone",             // book | zone | store
    "priceEventId": "0192…",
    "priceKind": "regular",
    "pricingRevision": 418,
    "priceBookId": "0192…",
    "priceZoneId": "0192…",            // present when sourceScope = zone
    "effectiveFrom": "2026-11-01T00:00:00+02:00",
    "effectiveTo": null
  }
}
// not sellable
{ "status": "unpriced", "reason": "no_price" }          // | no_price_book | not_representable
// data defect (never silently resolved)
{ "status": "error", "reason": "overlap_violation", "eventIds": ["…", "…"] }
```

The `provenance` object is the `origin: "pricing"` variant of the discriminated union that RT-282 PR-06
(read-down) and PR-07 (sale line) must share. The `origin: "legacy"` variant (`legacy_tenant | legacy_store` plus
the catalog cursor) is emitted only by the pre-cutover legacy path, never by this resolver.

## 5. Validity rules (enforced at authoring and by the database)

| Rule | Where | Decisions |
|---|---|---|
| No two **active** events overlap for the same `(tenant, book, scope, zone/store, item, sell_unit, price_kind)`. | DB exclusion constraint + Change Set validation | 498, 513 |
| No Store has two overlapping Zone memberships in one Book. | DB exclusion constraint + validation | 494 |
| `effective_from` is required; `effective_to`, when present, is after it. | DB check | 508–509 |
| An event's currency equals its Book's currency. | DB (composite FK or check through Book) | 472, 486 |
| Price ≥ 0 and exact at the currency minor unit. Zero needs an explicit owner decision (Q-4: rejected in v1). | Validation (minor unit is a lookup, not a DB check) | 478–479 |
| Events and revisions are immutable apart from the `state` transition `active → superseded/cancelled`. | DB trigger / grants + RLS | 521, 530, 534 |
| Past-dated events (`effective_from` before publish time) are rejected except on the governed path in spec 042. | Change Set validation | 520 |

## 6. Money and price points (478–482, 563–572)

- **Exact decimals only.** Values travel as decimal strings and are computed with decimal arithmetic.
  Floating point is prohibited anywhere in pricing (478, 572).
- **Minor-unit representability.** A publishable price must be exact at the currency's ISO-4217 minor unit
  (`minorUnitExponent`). `numeric(19,4)` is storage precision, not permission to publish sub-minor values (479, 568).
- **No FX at scan time.** A Book has one currency. Nothing converts currency during resolution or at the till.
  FX-derived prices are authoring inputs that become ordinary concrete events after validation and approval
  (481–482).
- **Authoring helpers.** Amount (+/−) and percentage changes are helpers. They resolve to a **concrete final
  price before approval** (515–517). If the result is not exact at the minor unit, the preview shows the
  candidate rounded half-up to the minor unit and the author must accept it. Nothing is rounded silently.
- **Price-point profiles** (.99/.95 endings, 563–565) are an authoring-time feature and are **out of v1**
  (OD-1). When they arrive, they apply in the preview only (566). An approved price is never re-rounded (567),
  and a later profile change never touches history (571).
- **Not Pricing's rounding:** tax rounding belongs to Fiscal (569), cash-tender rounding to Payment (570).

## 7. Fiscal boundary (G3 interface — declared, not decided)

- Pricing **declares** the Book's `tax_price_basis` (`inclusive | exclusive`) and returns it with every
  resolution (473, 592–593). Changing a Book's basis is a sensitive, effective-dated change (598). In v1 it is fixed when the Book is created (Q-5).
- Pricing **does not** derive the taxable base, compute tax, choose tax categories or round tax. Fiscal (RT-294)
  owns that (468, 591, 594–595, 600). Until RT-294 delivers, RT-283 D4 stays: an auto-applied tax row fails closed.
- Product tax category is classification, not price (596). It is **not** part of the Price event. The legacy
  `store_product_overrides.tax_category` moves to Fiscal under OD-5.

## 8. Inquiry and "why this price" (502–505)

All four are **Backend-computed** (696, 704). Admin-Console only renders them. Shapes are drafts for PR-04, not
committed to OpenAPI. Each read is tenant-scoped under RLS; store-scoped callers see only their stores (§II).

| Inquiry | Draft request | Result |
|---|---|---|
| **Current** | `GET /v1/pricing/stores/{storeId}/items/{itemId}/price?sellUnit=each` | §4.4 result at `now` |
| **Future / historical** | same, `?at=<RFC 3339 instant>&asOfRevision=<n>` | §4.4 result at that instant. A future instant uses already-published scheduled events (512) |
| **Timeline** | `GET /v1/pricing/stores/{storeId}/items/{itemId}/timeline?from=&to=&sellUnit=each` | Ordered, non-overlapping segments `{ from, to, status, price?, currencyCode?, provenance? }`. Unpriced gaps appear as segments (511) |
| **Why this price** | `GET /v1/pricing/stores/{storeId}/items/{itemId}/explain?at=&asOfRevision=` | The §4.4 result **plus** the trace below |

Explain trace (draft):

```jsonc
{
  "result": { "status": "priced", "price": "125.5000", "...": "…" },
  "storeTimeZone": "Africa/Cairo",
  "evaluatedInstant": "2026-11-03T10:15:00+02:00",
  "asOfRevision": 418,
  "layers": [
    { "scope": "store", "outcome": "none" },
    { "scope": "zone",  "outcome": "selected", "priceZoneId": "…", "zoneMembership": "explicit",
      "priceEventId": "…", "price": "125.5000", "effectiveFrom": "…", "publishedInRevision": 418,
      "changeSetId": "…" },
    { "scope": "book",  "outcome": "shadowed", "priceEventId": "…", "price": "130.0000" }
  ],
  "next": { "at": "2026-11-15T00:00:00+02:00", "price": "119.9900", "sourceScope": "store" }
}
```

`outcome` is one of `selected | shadowed | none`. `shadowed` shows the less specific price that the selected
one overrides, so an operator can see *both* what applies and what would apply after a reset (491, 699).

## 9. Out of scope (this spec)

- Change Set lifecycle, approval and publishing → spec 042 (RT-484).
- Legacy import and authority cutover → RT-485 (PR-03).
- POS offline activation, trusted time, staleness → RT-487 (PR-G4).
- Measured / catch-weight → RT-488 (G5). Cost reference → RT-489.
- Clearance, Open Price, compare-at, price-point profiles, recommendations → later items (OD-1).
- Any OpenAPI, migration or runtime code.

## 10. Acceptance-criteria trace (RT-483)

| AC | Where |
|---|---|
| Spec folder with spec, plan and data model | this file, [plan.md](plan.md), [data-model.md](data-model.md) |
| Resolution as a pure function, Store > Zone > Book, overlaps invalid, no order/priority, store-local time | §4, §5 |
| Current/future/historical inquiry and "why this price", shapes drafted | §8 |
| Money rules | §6 |
| G3 boundary explicit | §7 |
| OD-1 to OD-6 with recommendations, posted for ratification | [decision-record.md](decision-record.md); RT-483 Jira comment |
| No code, OpenAPI or migration | diff of this PR is `specs/041-*`, `specs/042-*` only |
