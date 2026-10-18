# RT-282 — Pricing domain decomposition record

> **Status:** decomposition record (Work Mode: **Planning**). **Jira holds the live status.** This file
> records the 2026-10-15 decomposition and is not a status tracker.
>
> **Created in Jira (Phase 0, 2026-10-15):**
>
> | Key | Item |
> |---|---|
> | RT-483 | PR-01 |
> | RT-484 | PR-02 |
> | RT-485 | PR-03 |
> | RT-486 | PR-G2V |
> | RT-487 | PR-G4 |
> | RT-488 | PR-G5 |
> | RT-489 | PR-14P |
>
> Everything else here is **proposed, not created**. Those items get created after the owner ratifies OD-1–6 (in RT-483) and the relevant gate's **unlock condition** is met (see §2). For G4 that condition is **G4a**, design ratification. It is not G4b, runtime closure, which is produced by the G4-gated items themselves. The precedent is RT-283, which was ratified before RT-376–380 were created.
>
> No production code, OpenAPI, migration, package or CI change.
>
> **Sources:** Jira RT-282; Confluence RETAIL page 23855106 "Pricing & Store Overrides Product
> Architecture — 2026-10-07" (decisions 461–718 + five planning gates); RT-283 decision package and
> comments; RT-376–380; Backend-Core `origin/main` **`ddae78a7`** (read-only inspection).
> Admin-Console and POS pricing code were **not inspected**. Their current state is unknown here.

---

## 1. Where the decisions live and what main does today

Decisions 461–718 are recorded only on Confluence page 23855106, in sections A–W plus the
"Planning gates" section. They are not in the Orchestrator handbook or in this repo.

Code anchors on Backend-Core `ddae78a7`:

| # | Finding | Evidence | Bearing on decisions |
|---|---|---|---|
| F1 | Runtime resolution is a single-level `COALESCE(store override price, tenant default_price)`, read at the current instant only. It carries no time dimension and no provenance. | `apps/api/src/catalog/read-down/read-down.service.ts:355` | 489–506 and 507–513 are greenfield |
| F2 | `price_history` exists (migration 0007): effective_from/to, open-interval unique indexes, `price >= 0`. **Neither `apps/api` nor `apps/worker` writes to it, and no trigger populates it.** | `packages/db/src/schema/catalog/price-history.ts`, `0007_catalog.sql` | 710 ("preserve history") likely preserves an empty table. Must be confirmed on the real pilot/rt9 DBs |
| F3 | **No HTTP price-authoring surface exists.** `StoreOverrideService` is not registered in any module or controller. Only the seed CLI writes `tenant_products.default_price`. | `apps/api/src/modules/catalog/store-override.service.ts` (orphan), `packages/db/src/cli/seed-catalog.ts` | 697 "Product → Price → Change Price" is greenfield. The 712 dual-writer risk is low today |
| F4 | Money is `numeric(19,4)`. Read-down omits unpriced and non-representable rows and emits an unpriced-issue metric. | `read-down.service.ts:412-434` | 478–480 and 548 already hold |
| F5 | Sale capture rejects fractional quantity and enforces `lineAmount = unitPrice × qty` at minor-unit precision (RT-105). | `packages/contracts/openapi/pos-sales/sales.yaml:91,961` | Gate 5 anchor |
| F6 | `sale_lines` freezes `unit_price`, `currency_code`, `quantity`, `line_amount`, `tax_amount`, `unit` and optional `tenant_product_ref`. It has **no pricing revision, source scope or price-event identity.** | `packages/db/src/schema/sales/sale-lines.ts:47-58` | 604 and 630 need an additive contract change |
| F7 | Read-down is a snapshot plus delta with an opaque cursor and a per-row `row_cursor`. It has **no coherent pricing-revision concept and no future-dated rows.** | `packages/contracts/openapi/catalog/read-down.yaml:25-57` | 620, 621 and 628 need design work, not a tweak |
| F8 | `stores.timezone` is an IANA name, defaulting to `UTC`. | `packages/db/src/schema/stores.ts:19-21` | Gives 510 an anchor. RT-279 owns the timezone gate (212–213) |
| F9 | The catalog has no Sell Unit / UOM concept. `sale_lines.unit` is free text, and the ERP UOM map is Connector-side (`unit→Nos`). | schema grep | 475–476 depend on Sell Unit modelling (RT-281) |
| F10 | No cost data is held in Backend-Core. | schema grep | 573–589 need a new cost-reference feed |
| F11 | `store_product_overrides` mixes three concerns in one row: price, `is_active` (assortment) and `tax_category` (fiscal). | `store-product-overrides.ts` | 716 split, with RT-281 and RT-294 |

## 2. Planning-gate status

| Gate | Status at 2026-10-15 | Evidence | Backlog response |
|---|---|---|---|
| **G1** ERPNext repricing protection (657) | **Runtime-proven on the sale path.** RT-380 is Done: S1 PASS with an enabled 50% selling Pricing Rule, `ignore_pricing_rule=1`, rate unchanged (BC `28d0249`, Connector `3d03ea0`). RT-376–379 are still "In Review", which is reconciliation lag because their merges are in `3d03ea0`. | RT-380 comments 11590/11594 | **No new item.** Residuals stay where they already are: return and void company/representation need the operator-envelope path (RT-380 gap), and v16 regression is RT-201 V3 |
| **G2** ERPNext below-cost compatibility (660) | **Open; owned by RT-282.** RT-379 only *detects* `validate_selling_price` (warning). No runtime proof exists of what ERPNext does to an authorized below-cost or clearance sale. | RT-283 §"Out of scope" | **PR-G2V** (Verification), then **PR-G2I** (conditional Implementation) |
| **G3** Fiscal gross/net/tax contract (592–601, 681) | **Open; owned by Fiscal.** RT-294 (Fiscal Core contract) is To Do. Pending that contract, RT-283 D4 makes an auto-applied tax row fail closed. | RT-294, RT-283 D4 | **No duplicate.** Pricing items that touch tax wait for RT-294. See the coverage check in §6 |
| **G4** Offline scheduled-price activation (621–629) | **Open.** G4 has two stages. **G4a**, the design ratification (RT-487 / PR-G4), *unlocks* the creation and implementation of the G4-gated items PR-06, PR-11, PR-12 and PR-P1. **G4b**, runtime closure, is the PR-V2 end-to-end proof. Only G4b lets G4 count as closed for go-live. | none | **PR-G4** (Planning, BC + POS) → G4a; PR-V2 → G4b |
| **G5** Measured / catch-weight (641–648) | **Open.** Sales contract rejects fractional qty (F5). RT-380 "rounding gate N/A by contract". | F5, RT-380 11590 | **PR-G5** (Planning, cross-module) |

## 3. Owner decisions needed before Phase 1

Recommendation first.

| ID | Decision | Recommendation | Why it blocks |
|---|---|---|---|
| **OD-1** | Pilot v1 scope cut | v1 includes: one Price Book per tenant/currency (EGP, tax basis declared), an optional Zone layer with an implicit default Zone, Store override, effective-dated timeline, Change Set with publish/schedule/rollback, and inquiry plus "why this price". **Later:** Clearance, Open Price, Price-Point profiles, cost guardrails, compare-at, recommendations, measured pricing. | Sizes PR-01, PR-04 and PR-05 |
| **OD-2** | Sell Unit in the price key (475–476) | v1 uses an implicit single Sell Unit ("each"), with a `sell_unit` column/seam defaulted. Multi-UOM pricing waits for RT-281 Sell Unit modelling. | Changes the primary key of price events |
| **OD-3** | Revision granularity for coherent POS application (628) | A tenant publish creates an immutable **Pricing Revision**. Each Store exposes a monotonic **applied-revision number** derived from it. POS applies whole store revisions. | Shapes the PR-06 contract and the PR-G4 design |
| **OD-4** | Change Set framework shared with Catalog (RT-281) | Use one shared Change Set / Revision primitive with domain-specific validators (Catalog, Pricing). Do not build two parallel lifecycles. | PR-02 vs RT-281 overlap |
| **OD-5** | Legacy `store_product_overrides` split (716) | price → Pricing (Store-scope price event); `is_active` → Assortment (RT-281); `tax_category` → Fiscal (RT-294). Legacy columns become read-only compatibility projections during the transition. | PR-03, PR-16a and PR-16b |
| **OD-6** | POS strict vs lenient response validation for additive read-down / sales fields | Ask POS to confirm, as was done for 033. If strict, each contract bump ships with a POS contract-pin update. | PR-06 and PR-07 rollout order |

## 4. Proposed backlog

Conventions:
- **Repo:** BC = `Kemetra/Backend-Core`, POS = `Kemetra/POS`, CON = `Kemetra/Admin-Console`,
  CNR = `Kemetra/ERPNext-Connector`.
- **[GATED]** means the item touches OpenAPI or SQL migrations and needs explicit owner authorization in the issue.
- Suggested parent is **RT-1** (W1 Catalog) for BC/POS/CON pricing items and **RT-2** for Connector items, matching RT-283's follow-ups. Suggested label: `exec-wave-12-pricing-erp`.

### Phase 0 — Planning and gate work (can start now)

#### PR-01 → **RT-483** — BC — Pricing domain spec, data model, resolution algorithm, and the OD-1–6 decision record
- **Work Mode:** Planning
- **Decisions:** 461–506, 507–521, 563–572, 590–596 (interface only)
- **Gate:** none to start. Must declare the G3 interface (tax-price basis on Price Book) without deciding Fiscal semantics.
- **Depends on:** nothing. The decision record putting OD-1–6 to the owner is part of this item's deliverable. Align with RT-281 (Sell Unit, change sets) and RT-279 (store timezone/business context for 510).
- **AC:**
  1. A spec folder exists with spec, plan and data-model covering Price Book, Price Zone + effective-dated membership, Store override as a scope, price event timeline, Pricing Revision and provenance.
  2. The resolution algorithm is written as a pure function of (Item, Sell Unit, Store, instant, revision) → price + provenance. Store > Zone > Book. Overlaps are invalid. Creation order and priority numbers play no part.
  3. Current, future and historical inquiry and "why this price" are specified, with response shapes drafted (not committed to OpenAPI).
  4. Money rules: exact decimal, minor-unit representability, no FX at scan time (478–482). Price-point rounding applies only at authoring time (563–572).
  5. Every open question is listed for owner ratification. No code, migration or OpenAPI is added.

#### PR-02 → **RT-484** — BC — Price Change Set and publishing lifecycle plan
- **Work Mode:** Planning
- **Decisions:** 522–535, 637–638, 705–707
- **Gate:** none
- **Depends on:** PR-01, OD-4. RT-281 (shared change-set primitive), RT-284 (approval policy: sensitivity, thresholds, emergency path).
- **AC:** The plan defines the states (draft → validated → approved → scheduled/published → superseded/rolled-back), the bulk selectors (Item, Category, Zone, Store), conflict analysis, the Impact Preview payload, optimistic concurrency, immutable revisions, rollback as a new revision, the emergency path with full audit, and Store Manager bounded-override scope (706). It also states which parts are reused from RT-281.

#### PR-03 → **RT-485** — BC — Pricing migration and authority-cutover plan
- **Work Mode:** Planning
- **Planned in:** [`specs/044-pricing-legacy-cutover/plan.md`](../../specs/044-pricing-legacy-cutover/plan.md), aligned with RT-487 (spec 043). That plan amends the PR-11 row below: pricing reaches POS on PR-06's separate pricing stream (spec 043 G4-2). PR-11 adds a catalogue `pricingAuthority` field, and under `pricing` it lists active products without a current price. Cutover requires every active device to be ready (spec 044 §7). The plan also splits PR-16a into PR-16a-1/16a-2 and adds PR-03E (row-count census) and PR-16c (legacy retirement).
- **Decisions:** 709–718
- **Gate:** none
- **Depends on:** PR-01, OD-5
- **AC:**
  1. Confirm the row counts of `price_history`, `tenant_products.default_price` and `store_product_overrides.price` on the pilot and rt9 DBs (F2: no runtime writer exists).
  2. Define the import of initial price events with provenance (`source = legacy_import`).
  3. Define legacy fields as compatibility projections, the single-writable-authority rule, the dual-read equivalence check and its evidence threshold for cutover, and a rollback that never rewrites sale facts.

#### PR-G2V → **RT-486** — CNR — Verify ERPNext behaviour for authorized below-cost / clearance sales on rt9
- **Work Mode:** Verification
- **Decisions:** 587, 660, 538–539 (via Planning Gate 2)
- **Gate:** **G2** (this item produces the G2 evidence)
- **Depends on:** RT-380 lab state (BC `28d0249`+, Connector `3d03ea0`+). No dependency on PR-01.
- **AC:** On rt9, post a synthetic sale whose rate is below the Item's valuation rate and below its last purchase rate, under each combination of Selling Settings `validate_selling_price` on/off, through the real Connector path. Record:
  - BC posting status and category;
  - the ERPNext document (or none);
  - the exact ERPNext error class and text;
  - the Compatibility Profile status.

  Restore all settings. Record the verdict "silently rejected / fails closed / posts exactly" per combination. No code change.

#### PR-G2I — CNR — Compatibility Profile severity for below-cost validators *(conditional)*
- **Work Mode:** Implementation (create only if PR-G2V shows a rejection path)
- **Decisions:** 660, 667, 670, 674
- **Gate:** G2
- **Depends on:** PR-G2V, plus an owner decision on whether `validate_selling_price=1` becomes **critical** (posting pauses) or stays a warning with a documented go-live checklist item.
- **AC:** The profile classifies the setting per the owner decision. Tests cover both severities. The Connector never changes the ERP setting itself (668).

#### PR-G4 → **RT-487** — BC + POS — Offline scheduled-price activation design
- **Work Mode:** Planning. Primary repo is Backend-Core. Planning that touches POS requires explicit owner authorization recorded on the issue (RT operating instructions §8).
- **Decisions:** 510, 528–529, 619–629, 637
- **Gate:** **G4a**. Ratifying this item meets G4a and unlocks the G4-gated implementation items. Runtime closure (G4b) comes in PR-V2.
- **Depends on:** PR-01, OD-3, RT-284 (offline policy modes `allow_cached / deny_if_stale / online_only`), RT-279 (store timezone gate)
- **AC:** A design doc and an owner-ratified decision record defining:
  - (a) **Trusted time** for activation on a device with an untrusted clock. Candidates: server-signed revision activation instant plus a monotonic offset, with skew bounds.
  - (b) **Pre-delivery of future revisions** and atomic whole-revision apply.
  - (c) **Behaviour when a revision fails to apply:** the previous revision stays identifiable.
  - (d) **Configurable max staleness** and the visible stale state.
  - (e) **Critical-correction handling:** short TTL or online-only.
  - (f) **What the sale snapshot records**, consistent with PR-07.

#### PR-G5 → **RT-488** — BC + POS + CNR — Measured / catch-weight sales cross-module plan
- **Work Mode:** Planning. Primary repo is Backend-Core. Planning that touches POS or the Connector requires explicit owner authorization recorded on the issue (§8).
- **Decisions:** 641–648, plus 612–617 for returns of measured lines
- **Gate:** **G5**
- **Depends on:** PR-01. RT-14/RT-87/RT-105 (line pricing and return precision rules), RT-380 carried rounding gate, Connector UOM map (`Nos` is whole-number only).
- **AC:** A plan covering:
  - canonical rate UOM and display unit;
  - fractional quantity precision;
  - the line-amount rounding rule (Pricing vs Fiscal vs Payment ownership);
  - the RT-105 invariant change needed for non-integer qty;
  - pro-rata returns of measured lines;
  - scale / barcode-embedded weight input on POS;
  - the Connector UOM and representation-check tolerance policy.

  It lists the exact contract changes per repo, in contract-first order. Fractional quantity stays rejected until this plan is ratified.

#### PR-14P → **RT-489** — BC + CNR — Cost Reference feed contract plan
- **Work Mode:** Planning. Primary repo is Backend-Core. Planning that touches the Connector requires explicit owner authorization recorded on the issue (§8).
- **Decisions:** 469, 573–582, 589
- **Gate:** none (below-cost *selling* stays behind G2)
- **Depends on:** PR-01
- **AC:** A plan for cost-reference snapshots: amount, currency, UOM, basis, source, `as_of` and freshness. It defines how ERPNext valuation/last-purchase data flows ERPNext → Connector → BC (no live ERP calls at sale time). It defines how margin is estimated, and that a stale margin is never shown as fact. The contract-first order is defined.

### Phase 1 — Contracts and schema (Backend-Core, [GATED]) — *proposed, not created*

#### PR-04 — BC — [GATED OpenAPI] Pricing inquiry and authoring contract
- **Work Mode:** Implementation (contract-only, following the pattern of RT-473 S1)
- **Decisions:** 495–505, 522–532, 696–707
- **Gate:** none. Tax fields are declared as "basis only; Fiscal owns derivation" (G3-safe).
- **Depends on:** PR-01, PR-02
- **AC:** New OpenAPI documents for:
  - Price Book / Zone / membership management;
  - price inquiry at current, future and historical instants;
  - "why this price" with provenance;
  - the Change Set lifecycle, Impact Preview, approve, publish/schedule and rollback.

  The distribution-status and Pricing Health read models are **not** in this item. Their states (ack, failed apply, max staleness, critical correction) are decided by PR-G4, so they move to the G4a-gated PR-06.

  Contract tests are green. No runtime implementation is included. Tenant/store authorization semantics follow Policy (Store Manager limited to bounded store overrides).

#### PR-05 — BC — [GATED migration] Pricing schema (additive)
- **Work Mode:** Implementation
- **Decisions:** 471–477, 483–487, 507–513, 522, 530, 534, 632–633
- **Gate:** none for the core tables; **G4a** for the revision-state migration
- **Depends on:** PR-01, PR-03. The revision-state migration also depends on PR-G4.
- **AC:**
  - **Additive tables:** Price Book, Zone, effective-dated Zone membership, price events, Pricing Revision, Change Set and change-set items, all with RLS per §II.
  - **Per-store and per-device pricing revision receipt/apply state** (last received, last applied, failed apply, timestamps), so the PR-06 acknowledgement endpoint can persist state and PR-12 can compute Pricing Health from it. Its column shape follows the PR-G4 decision record, so this table may ship as a second, G4a-gated migration in this item.
  - **DB constraints:** reject overlapping same-scope events (exclusion constraint or equivalent) and keep revisions immutable.
  - **Legacy columns** are untouched. Migration up/down tests and the RLS matrix pass.

#### PR-06 — BC — [GATED OpenAPI] POS read-down pricing projection v-next (additive)
- **Work Mode:** Implementation (contract-only)
- **Decisions:** 501, 604, 618–630, 632–633, 715
- **Gate:** **G4a** (PR-G4 ratified)
- **Depends on:** PR-G4, PR-07 (the provenance field shapes must match), OD-3, OD-6
- **AC:** Additive fields:
  - store pricing revision id/cursor;
  - **item-level provenance on every priced row and on each future entry.** This is POS's only authoritative source for the PR-07 sale-line fields when it sells offline. It is a **discriminated union shared with PR-07**:
    - `{ origin: "pricing", sourceScope: book|zone|store, priceEventId, priceKind, pricingRevision }`, used after cutover;
    - `{ origin: "legacy", sourceScope: legacy_tenant|legacy_store, catalogCursor }`, which has **no event id or price kind**. This is what the PR-11 legacy path emits before cutover.

    Both variants are contract-valid, so strict validators accept the pre-cutover deployment;
  - pre-delivered future scheduled entries with activation instant;
  - freshness/max-staleness metadata;
  - a device revision-applied acknowledgement endpoint (feeds 632–633; persists to the PR-05 revision-state table);
  - the **distribution-status and Pricing Health read models** (moved here from PR-04), with states as decided by PR-G4.

  Existing consumers stay compatible. A POS contract-pin note is filed if POS validation is strict.

#### PR-07 — BC — [GATED OpenAPI + migration] Sale-line pricing provenance
- **Work Mode:** Implementation
- **Decisions:** 470, 501, 604, 630
- **Gate:** none for the regular price. Do not add tax fields here (G3).
- **Depends on:** PR-01, OD-6
- **AC:** An optional additive sale-line `pricingProvenance` field using the same discriminated union as PR-06:
  - `origin: "pricing"` carries the pricing revision, source scope (book/zone/store), price event id and price kind (regular/clearance/open/manual-override);
  - `origin: "legacy"` carries the legacy source scope and catalog cursor only.

  Capture stores whichever variant arrives, frozen, and never recomputes it. Sales already captured are unaffected. Contract, migration and idempotency-replay tests pass.

### Phase 2 — Backend-Core implementation

| ID | Title | Mode | Decisions | Gate | Depends on | Acceptance criteria (summary) |
|---|---|---|---|---|---|---|
| **PR-08** | Resolution engine + inquiry / "why this price" endpoints | Impl | 489–506, 510 | none | PR-04, PR-05 | The pure resolver is property-tested for determinism and precedence. Store timezone is used for the effective instant. Current, future and historical inquiry and explain endpoints work. Missing price means not sellable (480, 506). |
| **PR-09** | Price event authoring + validation | Impl | 507–521, 478–482, 563–567 | none | PR-08 | Fixed, amount and percent helpers resolve to a concrete price before approval. Prices must be representable at minor-unit precision. Overlaps and past-dated changes are rejected per policy. Corrections are new events and history is never rewritten. |
| **PR-10** | Change Set lifecycle + publish/schedule/rollback | Impl | 522–535, 705–707 | none | PR-09, PR-04, RT-284 impl, shared primitive per OD-4 | Implements the PR-02 state machine: immutable revision on publish, rollback creates a new revision, optimistic concurrency (409 on stale version), emergency path audited, Store Manager scope enforced server-side, audit records before/after, actor, reason, effective time and version. |
| **PR-11** | Read-down PR-06 shape + shadow resolver (legacy keeps serving) | Impl | 618–620, 713–715, 717 | G4a | PR-06, PR-08 | Read-down serves the PR-06 shape, but the **response stays on the legacy `COALESCE` path**. Before cutover it emits the contract-defined **`origin: "legacy"`** provenance variant (`legacy_tenant`/`legacy_store` plus the catalog cursor, with no event id or price kind) and never fakes `pricing`-variant fields. The new resolver runs **shadow-only**: it computes the same projection, compares it, and emits a mismatch metric, but never serves it. Switching the response source is a per-tenant guarded flag owned by PR-16b. |
| **PR-12** | Distribution readiness + Pricing Health | Impl | 631–640, 704 | G4a | PR-05 (revision-state table), PR-06, PR-11 | Per-store and per-device revision receipt/apply state, read from the PR-05 table and written by the PR-06 ack, plus a missed-activation health finding and stale POS revision findings, computed in Backend-Core. The shelf-label worklist is an optional flag, not a blocker (635–636). |
| **PR-13** | Clearance lifecycle | Impl | 538–542 | **G2** | PR-10, PR-G2V/G2I | Clearance markdown is a price event type with an explicit reset to regular. A multi-step plan seam exists. Promotion eligibility on clearance is an explicit flag exposed to the Offer Engine (RT-286). Not enabled for tenants until G2 is closed. |
| **PR-15P** | Open Price capability plan | Planning | 548–556 | none | PR-01, RT-284, RT-114 | Defines the explicit product capability (off by default), min/max, sensitivity-based reason capture, offline bound under cached policy, audit, and sale-capture validation of an entered price. |
| **PR-16a** | Legacy price import (legacy stays authoritative) | Impl | 709–711, 713 | none | PR-03, PR-05, PR-09 | Imports price events from `default_price` and the store override prices, with `source = legacy_import` provenance. It is idempotent and re-runnable, so the new side tracks legacy until cutover. Legacy columns stay the only writable authority (712). This item exists so PR-V1 has populated data to compare. |
| **PR-16b** | Authority cutover | Impl | 712, 714, 716–718 | none | PR-16a, PR-V1, PR-10, PR-11 | Gated on the PR-V1 evidence and run **per tenant as one guarded, atomic switch**. It freezes that tenant's legacy price writes (DB-enforced reject; see F3 for today's writers), runs a final delta import, re-runs the equivalence check over every sellable pair, and only on a zero-mismatch result flips both the writable authority and the read-down response source to Pricing. Any failure aborts the whole switch and legacy stays authoritative, so no write is missed between import and cutover. After the flip the legacy price columns become read-only compatibility projections. Rollback keeps all data and never rewrites sale facts. |
| **PR-17** | Reference / compare-at price facts | Impl | 557–562 | none (display policy may later depend on Fiscal) | PR-05 | Stored separately from the selling price and never used as a fallback. Exposed for display only. An Offer basis only when a campaign declares it (RT-286). |
| **PR-18P** | Price recommendations (cost-based) | Planning | 688–694 | none | PR-14P, PR-10 | A recommendation becomes Change Set, then preview, approval and publish. It is never authoritative and keeps its provenance. Competitor and AI recommendations are explicitly deferred. |

### Phase 3 — Consumers (POS, Admin-Console, Connector)

| ID | Repo | Title | Mode | Decisions | Gate | Depends on | Acceptance criteria (summary) |
|---|---|---|---|---|---|---|---|
| **PR-P1** | POS | Consume the pricing projection v-next | Impl | 618–630 | **G4a** | PR-06, PR-11 | Stores each cached price's item-level provenance verbatim, in whichever union variant it arrives (`pricing` or `legacy`), so it is available offline for PR-P2. Applies whole store revisions atomically. Pre-delivered future prices activate by the PR-G4 trusted-time rule. A failed apply leaves the previous revision active and identifiable. Stale state is visible. Sends the revision-applied ack. |
| **PR-P2** | POS | Cart price lock + provenance on the sale | Impl | 602–604, 611, 630 | none | PR-07, PR-P1 | The regular price is frozen on the CartLine at scan, together with the provenance the device cached in PR-P1. It is sent unchanged as the PR-07 `pricingProvenance` union. A live cart is never silently repriced. Held-cart TTL/revalidation stays in **RT-445** (605–609). |
| **PR-C1** | CON | Simple price surface: Product → Price → Change Price, "why this price", future timeline | Impl | 695–700, 708 | none | PR-04, PR-08, PR-10 | Control surface only. Every write goes through Backend-Core Change Set endpoints and never touches ERPNext. Advanced controls use progressive disclosure. |
| **PR-C2** | CON | Bulk change sets, Impact Preview, approval view, distribution status, Pricing Health | Impl | 701–704 | none (distribution views need G4 items) | PR-10, PR-12 | Renders Backend-computed preview, approval, distribution and health. No pricing logic lives in the Console. |
| **PR-X1** | CNR | Verify tax/total representation after the Fiscal contract | Impl | 601, 681 | **G3** | RT-294 | Extends RT-378 representation verification to tax rows and totals per the Fiscal contract. Until then RT-283 D4 (fail closed) stands. |

### Phase 4 — Verification

| ID | Repo | Title | Mode | Gate | Depends on | Acceptance criteria (summary) |
|---|---|---|---|---|---|---|
| **PR-V1** | BC | Dual-read equivalence evidence for cutover | Verification | none | PR-11, PR-16a | Runs on rt9 and pilot data after the PR-16a import. Resolver output must equal the legacy `COALESCE` for every sellable (store, product) pair over an agreed window, or each difference is explained. The report is attached before PR-16b. |
| **PR-V2** | BC + POS + CNR | End-to-end on rt9: scheduled price change → POS offline activation → sale with provenance → exact ERP posting | Verification | G1 ✔, G4a ✔ (produces **G4b**) | PR-10, PR-P1, PR-P2, PR-11, PR-12, PR-16b (the rt9 lab tenant must be cut over first, so read-down serves Pricing revisions) | Scheduled change published ahead of time, device offline across activation, activation by trusted time, sale frozen with revision, Connector posts the exact rate with `ignore_pricing_rule=1`, and the health view shows the store as applied. Also run the stale-revision and critical-correction scenarios. **This is the runtime proof that closes G4 (G4b).** |

## 5. Dependency order (critical path)

```
OD-1..6 ─┬─> PR-01 ─┬─> PR-02 ─> PR-04 ─┬─> PR-08 ─> PR-09 ─> PR-10 ─┬─> PR-C1
         │          │                   │                            ├─> PR-V2 (publish/schedule prerequisite)
         │          │                   │                            ├─> PR-13 (G2)
         │          ├─> PR-03 ─> PR-05 ─┘                            └─> PR-18P
         │          ├─> PR-07 ─┐
         │          ├─> PR-G4 ─┴─> PR-06 ─> PR-11 ─┬─> PR-12 ─> PR-C2
         │          │                              ├─> PR-P1 ─> PR-P2 ─┐
         │          │                              │                   └─> PR-V2 (closes G4b)
         │          │      PR-09 ─> PR-16a ────────┴─> PR-V1 ─> PR-16b (guarded per-tenant cutover) ─> PR-V2
         │          ├─> PR-G5        (G5; nothing executable until ratified)
         │          ├─> PR-14P       (cost feed)
         │          └─> PR-15P       (open price)
PR-G2V ─> PR-G2I (conditional) ─> unblocks PR-13           (G2)
RT-294 ─> PR-X1                                             (G3)
```

RT-486 (PR-G2V) and RT-483 (PR-01) can start immediately and in parallel.

## 6. Decision coverage matrix (461–718)

| Section | Decisions | Covered by |
|---|---|---|
| A Authority | 461–470 | Invariants. 461–463 and 506 are enforced by PR-08 (no ERP fallback). 464 = G1 (done). 465 → RT-286. 466–467 → RT-114/RT-284 + PR-07 price kind. 468 → RT-294. 469 → PR-14P. 470 → PR-07 |
| B Price Books / currency | 471–482 | PR-01, PR-05, PR-09. 475–476 Sell Unit → OD-2 / RT-281. 478–480 already hold on main (F4) |
| C Zones | 483–494 | PR-01, PR-05, PR-08. 488 (move-store Impact Preview) → PR-10. 493 seam only |
| D Resolution | 495–506 | PR-01, PR-08 |
| E Timeline | 507–521 | PR-01, PR-05, PR-09. 510 → RT-279 timezone gate |
| F Change Sets | 522–535 | PR-02, PR-04, PR-10. 527 → RT-284. 533 canary → later |
| G Regular / clearance / promo / manual | 536–547 | 536 → PR-09. 537/542 → RT-286. 538–541 → PR-13 (G2). 543–546 → RT-114 + RT-284 + PR-07. 547 → G1 (done) |
| H Open Price | 548–556 | 548 holds (F4). Rest → PR-15P |
| I Reference / compare-at | 557–562 | PR-17. 562 → RT-286 |
| J Price points / rounding | 563–572 | PR-01, PR-09 (authoring-time only). 569 → RT-294. 570 → Payment (existing tender rounding). 571–572 invariants |
| K Cost / margin / guardrails | 573–589 | PR-14P. 583–588 guardrail policy → RT-284. 587 below-cost → G2 |
| L Tax / Fiscal | 590–601 | **G3 / RT-294.** Pricing only declares the basis (PR-01/PR-04). 601 → PR-X1 |
| M Cart price lock | 602–611 | PR-P2, PR-07. 605–609 → RT-445. 610 → RT-286 |
| N Returns | 612–617 | Already the rule under RT-14 / RT-87 / RT-271 (original sale facts). PR-G5 covers measured-line returns. No new item |
| O POS / offline | 618–630 | **G4:** PR-G4, PR-06 (including item-level provenance), PR-11, PR-P1, PR-V2. 630 → PR-07 + PR-P2 |
| P Distribution / shelf labels | 631–640 | PR-06, PR-12, PR-C2. 635–636 optional |
| Q Measured / weighted | 641–648 | **G5:** PR-G5. 645 → RT-286. 646 → OD-2 |
| R ERPNext boundary | 649–664 | 650–659 → RT-283 / RT-377 / RT-378 (G1 done). 660 → PR-G2V/G2I. 661 → G3. 662–664 → RT-379 / RT-201 |
| S Compatibility Profile | 665–674 | RT-379 (shipped, verified in RT-380). 671 → RT-201 |
| T Post-posting verification | 675–687 | RT-378 (verified in RT-380). 681 → PR-X1 (G3). Residual return/void and replay gaps are already logged on RT-380 |
| U Recommendations | 688–694 | PR-18P. 689–690 deferred |
| V Admin Console | 695–708 | PR-C1, PR-C2. 696 and 704 are Backend-side (PR-08/10/12). 705–706 enforced in PR-10 |
| W Migration | 709–718 | PR-03, PR-16a (import), PR-V1, PR-16b (cutover). 716 → OD-5 + RT-281 + RT-294 |

**Coverage check for RT-294 (G3):** the Fiscal Core contract should explicitly cover 592–601 (inclusive/exclusive derivation, promotion allocation input, tax-mode change effective-dating, frozen gross/net/tax, Fiscal-owned rounding). If its scope doesn't, add an AC to RT-294 rather than a Pricing item.

## 7. Risks and assumptions

- **F2 is unverified on real data.** If `price_history` turns out to hold rows somewhere, PR-03 grows an import-reconciliation step.
- **POS and Admin-Console were not inspected.** PR-P1, PR-P2, PR-C1 and PR-C2 assume no existing pricing logic there.
- **Shared Change Set primitive (OD-4)** couples the Pricing schedule to RT-281. If the owner prefers independence, PR-02, PR-05 and PR-10 grow.
- **G1 residuals:** return and void invoice representation and the replay path were not exercised in RT-380. They are tracked there, not here.
- **Fiscal (G3)** is on the critical path for any claim of exact tax representation. Regular-price work can proceed without it.
