# Feature Specification: Branch Inventory Reconciliation & Warehouse Mapping

**Feature ID**: 014
**Short name**: branch-inventory-reconciliation-and-warehouse-mapping
**Status**: Draft — planning / docs-only (no implementation)
**Created**: 2026-06-04
**Owner**: Ahmed Shaaban
**Constitution version**: 3.0.1

---

## 0. What this spec is (and is not)

This is the **planning spec** for 014 — the fourth step of the ERPNext
integration arc after **011** (foundation + signed decisions), **012**
(connector contracts + posting-feed OpenAPI), and **013** (product-master
mapping, CLOSED on `main`). It is **docs/planning only**: no application code,
no DB schema, no migration, no OpenAPI YAML, no `package.json`/lockfile, no CI,
no connector code. No runtime behavior changes.

Like 011/012/013, this spec has **no `execution-map.yaml` and no dispatchable
code slices**. It establishes purpose, boundaries, the warehouse-mapping concept,
the operational-vs-accounting authority split (already **signed**), the
014↔017 reconciliation boundary, and the open questions. **Implementation stays
blocked** until this spec runs its own Spec-Kit chain (`plan.md` → Constitution
Check → `[GATED]` contract/schema, if any → `tasks.md` → `execution-map.yaml`)
and the Agent OS gates clear.

---

## Clarifications

### Session 2026-06-04

- Q: Should DP2 store a snapshot/mirror of ERPNext Bin/Warehouse quantities, or
  leave the fetch-and-compare to 017? (OQ-1 + OQ-5, collapsed) → A: **No mirror.**
  014 stores only the store↔warehouse mapping + the mismatch vocabulary; the
  fetch-ERPNext-Bin-and-compare is 017's machinery (per the §8 carve). A standing
  DP2 table of ERPNext stock quantities is exactly the read-down look-alike the
  signed decision rejects.
- Q: Cardinality of store ↔ ERPNext Warehouse — strict 1:1 or multi-warehouse?
  (OQ-2) → A: **1:1 for v1, designed forward-compatible to warehouse-by-purpose.**
  Owner forward intent: a future second warehouse per store for expired product
  returned to the producer. v1 writes one sellable/stock mapping per store; the
  schema grain (`purpose` discriminator, partial-unique
  `(tenant_id, store_id, purpose)`) must not preclude the later returns/expired
  warehouse (see [plan.md](./plan.md) OQ-2 forward-compat note).
- Q: How is a store↔warehouse mapping established? (OQ-3) → A: **Manual
  admin-set** via a `[GATED]` Console→DP2 contract. NOT 013's suggest-then-confirm
  — warehouses are few per store and need no candidate matching, so a
  suggestion engine would over-build.

> OQ-4 (mismatch class vocabulary + tolerance) remains open, deferred to the
> data-model / recon-def slice. The authority/direction question is closed by the
> signed stock-impact decision (§5), not a clarification here.

---

## 1. Background & Why

The signed **stock-impact decision**
([011-DR-STOCK-IMPACT](../011-erpnext-pos-reference-and-integration-foundation/decisions/stock-impact-decision-record.md))
imposes a direct, named obligation on 014:

> **014** (branch inventory): maps ERPNext Warehouse ↔ DP2 store/branch (for
> valuation) + the reconciliation; does **not** make ERPNext the on-hand source.

DP2 already owns an append-only operational stock ledger — **009**
(`stock_movements`, compute-on-read on-hand as a signed SUM, CLOSED on `main`).
ERPNext, as the accounting backbone, owns **stock valuation, COGS, GL impact**,
and tracks quantities per **Bin** within a **Warehouse**. For ERPNext to *value*
the same physical stock a DP2 store holds — and for a future sale posting (015)
to land in the right ERPNext Warehouse — there must be an agreed
**Warehouse ↔ store/branch** relationship and a way to **reconcile** the two
ledgers without ever merging or summing them.

[integration-boundaries §6](../011-erpnext-pos-reference-and-integration-foundation/integration-boundaries.md)
explicitly defers the **branch/warehouse inventory direction** to this spec
(gated by the stock-impact decision). The stock-impact decision has **already
decided that direction** (§5 below); 014's job is to specify the mapping and the
reconciliation **consistent with** that signed decision, then run its own
planning chain.

---

## 2. Purpose

Define, at the planning level:

- **What ERPNext owns** in the branch-inventory domain (Warehouse/Bin
  quantities, valuation) and **what Data-Pulse-2 keeps owning** (the 009
  operational stock ledger and operational on-hand / available-to-sell — the
  authority that drives POS-Pulse and Retail-Tower-Console sellability).
- The **mapping link** between a DP2 store/branch and an ERPNext Warehouse
  (the signed default is **1:1**), and the provenance that rides on it.
- The **reconciliation** between DP2 operational on-hand (009) and ERPNext
  Bin/Warehouse quantity — specifically **what 014 owns** (the mapping + the
  *definition* of what is compared and what a "mismatch" *is*) vs **what 017
  owns** (the operational jobs, scheduling, mismatch reports, repair API).
- The **boundaries** inherited from 011 + the signed stock-impact decision that
  014 must not violate (above all: **no ERPNext stock read-down replacing DP2
  operational availability**).
- The **open questions** whose answers must be locked before implementation.

---

## 3. Non-Goals

- No application code, NestJS modules, services, controllers, or workers.
- No `plan.md`, `tasks.md`, `data-model.md`, or contract/OpenAPI YAML in this PR.
- No DB schema, Drizzle schema, or SQL migrations.
- **No ERPNext stock read-down that replaces DP2 operational availability.**
  POS/Console sellability stays driven by DP2 operational stock (009); ERPNext
  Bin/Warehouse quantities may be mirrored **for reconciliation only**
  (stock-impact decision §4 owner scope note). Making ERPNext the on-hand master
  is **rejected** and is a STOP-and-raise condition (§5.4).
- No **sale posting** / Stock Entry / "Update Stock" wiring — that is **015**
  (the posting decision + stock-impact §3 own the no-double-decrement model).
- No **reconciliation jobs, scheduling, mismatch reports, retry/DLQ, or repair
  API** — those are **017** (stock-impact decision §5). 014 defines *what* is
  compared and *what counts as* a mismatch; 017 *runs* it.
- No edit to `docs/outbox/event-types.md`; no new outbox event registration in
  this PR (any event 014 eventually needs is its own `[GATED]` slice).
- No `package.json`, lockfile, CI, generated files, or app source changes.
- No connector-repo code (separate `Retail-Tower-ERP-Next-Connector` repo,
  gated by ADR 0008).
- No POS-Pulse or Retail-Tower-Console changes.
- No purchasing / restock flow (a future ERPNext-backed spec; stock-impact +
  follow-up-spec-map keep it out of 014's mapping/reconciliation scope).
- No rewrite of the 009 ledger; 009 stays append-only, history never rewritten.
- No ERPNext fork or core copy-paste (Constitution §I).

---

## 4. Actors

| Actor | Role in 014's domain |
|---|---|
| **Tenant Admin** | Owns the tenant's stores (001) and the 009 stock ledger. In 014, establishes/repairs the store ↔ ERPNext Warehouse mapping; reviews reconciliation mismatches. |
| **Tenant Owner** | Highest tenant authority; same mapping authority across all stores/warehouses. |
| **Platform Admin** | Operates platform infrastructure. **Not** an authority over a tenant's store↔warehouse mappings. |
| **Retail-Tower-ERP-Next-Connector** *(future, separate repo)* | The **only** component that speaks Frappe. Reads ERPNext Warehouse/Bin quantities for reconciliation; holds ERPNext credentials. Reaches DP2 only via the 012 contract. |
| **Data-Pulse-2 (backend)** | Orchestration + contract boundary. Owns the mapping records, the 009 operational ledger, and the reconciliation *definition*; exposes ERP-backed data only as DP2 API shapes. |
| **POS Device / POS Operator** | **Unaware of ERPNext.** Continues to read the resolved DP2 store catalog (003/010) and DP2 operational availability (009). Never a participant in warehouse mapping or reconciliation. |
| **Anonymous / unauthenticated** | No access. |

---

## 5. Source-of-truth — the operational-vs-accounting split (SIGNED, not open)

> This section is the constitutional backbone of 014. **Unlike 013 (whose
> authority question was open at spec time and locked later in plan.md), 014's
> authority question is ALREADY DECIDED** by the **signed**
> [stock-impact decision](../011-erpnext-pos-reference-and-integration-foundation/decisions/stock-impact-decision-record.md)
> (011-DR-STOCK-IMPACT, SIGNED 2026-06-03). 014 specifies the mapping +
> reconciliation **consistent with** that decision; it does **not** re-open it.
> Any deviation is a STOP-and-raise condition, not a silent override (§5.4).

### 5.1 The signed split

> **Authority wording clarified (RT-288, Inventory Planning Gate 1, recorded 2026-10-12).** In this feature, "Data-Pulse-2 remains the operational stock authority. It owns the append-only `stock_movements` ledger (009)", "DP2's per-store/branch 009 movements stay the operational truth", the authority-table row "DP2 009 ledger (signed SUM, compute-on-read)", the §IX row, and the same wording in this feature's `plan.md` and `data-model.md`, read as follows under the owner-approved Inventory Operations baseline of 2026-10-07, decisions 719–727 (Confluence RETAIL page 22544389):
>
> - Backend-Core owns *operational* inventory authority and Available To Sell (721, 722).
> - ERPNext Stock Ledger/Bin is the *financial/book* quantity authority, and ERPNext also owns valuation, COGS and
>   GL (719, 720).
> - 009 evolves into an Inventory Effects Journal plus operational projection (724, 726).
> - ERP Bin snapshots are evidence/book state, never an overwrite master (729, 782, 783).
>
> Shipped code, data and history are unchanged (727). Whether and how sale effects are activated, and how ERP confirmation avoids double counting, is decided by Jira RT-289 (Gates 2+3).

- **Data-Pulse-2 remains the operational stock authority.** It owns the
  append-only `stock_movements` ledger (009) and computes the **operational
  on-hand / available-to-sell** quantities used by POS-Pulse, Retail-Tower-Console,
  and Retail Tower APIs. (stock-impact §"Core principle" + §1.)
- **ERPNext remains the accounting inventory authority.** It owns submitted ERP
  inventory documents, **stock valuation, COGS, GL ledger impact, and financial
  inventory reporting**, tracked per **Bin** within a **Warehouse**.
  (stock-impact §"Core principle" + §2.)
- **The two ledgers must NOT be merged or summed.** They answer distinct
  questions and are **reconciled** by correlation ID + mismatch reports + repair
  workflows — never added together, never one silently overwriting the other.
  (stock-impact §"Core principle" + §5.)

### 5.2 Direction — DP2 operational, ERPNext mapped for valuation (SIGNED §4)

- DP2's per-store/branch 009 movements stay the **operational truth**.
- ERPNext **Warehouses are mapped (default 1:1) to DP2 stores/branches** purely
  so ERPNext can **value** the same physical stock.
- **014 maps the warehouse ↔ store relationship and defines the reconciliation.
  It does NOT make ERPNext the operational on-hand source.**
- **Read-down of branch inventory *from* ERPNext as the on-hand master is
  REJECTED** — it contradicts the operational-authority split (stock-impact §4).
- ERPNext Bin/Warehouse quantities **MAY** be mirrored **for reconciliation and
  mismatch detection only**; **POS/Console sellability remains driven by DP2
  operational stock** (stock-impact §4 owner scope note). Whether to mirror at
  all (store a snapshot) or fetch on-demand is **OQ-1** — *how* to reconcile is
  open; *which side is authoritative* is closed.

### 5.3 What this means concretely

| Fact | Authoritative source (unchanged by 014) |
|---|---|
| Operational on-hand / available-to-sell per store | **DP2 009 ledger** (signed SUM, compute-on-read) — operational |
| What POS-Pulse / Console can sell | **DP2** operational stock (009) — never ERPNext Bin |
| Stock **valuation**, COGS, GL inventory impact | **ERPNext** (Bin/Warehouse) — accounting |
| The store/branch ↔ ERPNext Warehouse relationship | **DP2 mapping record (014, new)** |
| Whether DP2 on-hand and ERPNext Bin agree | a **reconciliation result** (compared, never summed) |

### 5.4 STOP-and-raise condition

If the owner intends ERPNext branch inventory to become the **operational
on-hand master** (read-down replacing DP2 operational availability, POS/Console
sellability driven by ERPNext Bin), that **contradicts the signed stock-impact
decision** (§4 + owner scope note). Per
[integration-boundaries §5](../011-erpnext-pos-reference-and-integration-foundation/integration-boundaries.md)
and the decision's own "deviation = STOP-and-raise" clause, that is a
**STOP-and-raise** condition requiring the stock-impact decision to be re-opened
and re-signed (or a superseding ADR) — it MUST NOT be baked into 014 silently.

---

## 6. Boundaries inherited from 011 (non-negotiable)

014 inherits every prohibition from
[integration-boundaries §3](../011-erpnext-pos-reference-and-integration-foundation/integration-boundaries.md):

- **No direct POS-to-Frappe path.** POS-Pulse never calls ERPNext/Frappe; it
  stays on `/api/pos/v1/…` (002) and reads DP2 operational stock (009) + the
  resolved DP2 store catalog (003/010). No Frappe/Bin shape leaks to POS.
- **No ERPNext fork or core copy-paste** (Constitution §I). Bespoke ERPNext
  needs live in the connector's thin custom Frappe app, never as forked core here.
- **The connector remains the only ERPNext adapter.** It is the only component
  holding ERPNext credentials and speaking Frappe. Exactly **one path** to
  ERPNext: DP2 → connector → ERPNext.
- **Data-Pulse-2 remains the contract/orchestration boundary.** Every ERP
  interaction is orchestrated here; DP2 owns the OpenAPI contracts POS-Pulse and
  Retail-Tower-Console consume.
- **Retail-Tower-Console** consumes DP2-generated clients only; unaware of
  Frappe. Any ERP-derived screen is unblocked only once the matching `[GATED]`
  DP2 OpenAPI contract is merged (§IV).

---

## 7. Required concepts

These are the concepts 014 must model when it reaches implementation. **Named
and bounded here; not schema'd.** Each is defined as an extension over the
existing 001 stores + 009 ledger, not a replacement.

### 7.1 ERPNext Warehouse reference
The ERPNext **Warehouse** doctype (the accounting stock location whose **Bin**
rows carry per-item valued quantity). 014 stores a **reference** to it (e.g. the
ERPNext Warehouse name) on the DP2 side, linked to a `stores` row. DP2 speaks in
DP2 terms; the connector maps the DP2-facing reference to the live ERPNext
doctype (version-independence, 012 O-6). The mapping table is provisionally
named **`erpnext_warehouse_map`** (analogous to 013's `erpnext_item_map`); its
shape is a future `[GATED]` `data-model.md` + schema slice, not decided here.

### 7.2 Store / branch ↔ Warehouse cardinality
The signed default is **1:1** (`stores` row ↔ ERPNext Warehouse). ERPNext
deployments commonly model **multiple** warehouses per physical location (main /
returns / in-transit / damaged). Whether 014 must support a store mapping to
**more than one** ERPNext Warehouse (e.g. a primary sellable warehouse plus
satellites) — or stays strictly 1:1 for v1 — is **OQ-2**. The 1:1 default holds
unless the owner widens it.

### 7.3 Reconciliation comparison (the two sides)
Reconciliation compares, per `(tenant, store/branch, item)`:
- the **DP2 operational on-hand** (009 compute-on-read signed SUM), against
- the **ERPNext Bin quantity** for the mapped Warehouse + the mapped ERPNext
  Item (013's `erpnext_item_map` supplies the item correspondence).

014 defines **what is compared** and **what a "mismatch" is** (e.g. quantity
delta beyond a tolerance, an item present in one ledger but absent in the other,
a store with no warehouse mapping). 014 does **not** run the comparison on a
schedule or repair it — that is 017 (§8).

### 7.4 Mismatch definition & classes
The classification a reconciliation result can take, defined by 014 so 017 has a
stable vocabulary to report and repair against. Candidate classes (to be
finalized in plan.md): `quantity_divergence` (delta beyond tolerance),
`unmapped_store` (store has no warehouse mapping), `unmapped_item` (item has no
013 mapping, so it cannot be reconciled), `erpnext_only` / `dp2_only` (present in
one ledger, absent in the other). The **negative-balance interaction** is a
named case: 009 allows-and-flags negative on-hand; ERPNext may reject negative
stock — this is an **expected** mismatch class, not an error to silently erase
(stock-impact §6). The set + tolerance semantics are **OQ-4**.

### 7.5 Mapping lifecycle & provenance
How a store↔warehouse mapping is established and kept current (manual
Tenant-Admin action; suggest-then-confirm like 013; admin-set-only), and the
provenance every mapping carries per §XIII: the **tenant** scope (RLS-isolated,
§II), the **store** it maps, the ERPNext Warehouse reference, and **when/by whom**
it was established or last reconciled. Lifecycle is **OQ-3**.

### 7.6 No double-count guarantee (inherited)
014 must not introduce any path that **sums** the two ledgers. The 009 ledger
and ERPNext Bin are correlated by ID and **compared**, never added. (stock-impact
"Invariants preserved".) 014 carries this guarantee into the reconciliation
*definition*; 015 carries it into the posting path (Sales Invoice "Update Stock"
ON is ERPNext's own accounting ledger, not a second operational count).

---

## 8. The 014 ↔ 017 reconciliation boundary (the carve)

The signed stock-impact decision assigns "reconciliation" language to **both**
014 (§4: "maps the warehouse↔store relationship **and the reconciliation**") and
017 (§5: "017 **owns the reconciliation jobs, mismatch reports, and repair
workflows**"). To prevent duplication or a gap, 014 draws the line explicitly:

| Concern | Owner | Rationale |
|---|---|---|
| Store/branch ↔ ERPNext Warehouse **mapping** records (CRUD, lifecycle, RLS) | **014** | The static relationship is 014's core deliverable. |
| **Definition** of what reconciliation compares (the two sides, §7.3) | **014** | The comparison is meaningless without the mapping; defining it belongs with the mapping. |
| **Definition** of mismatch classes + tolerance vocabulary (§7.4) | **014** | 017 needs a stable vocabulary to report/repair against. |
| **Running** reconciliation jobs (scheduling, cadence, on-demand triggers) | **017** | Operational orchestration of the whole arc. |
| **Mismatch reports** (persisted results, surfaces, alerting) | **017** | Operability deliverable; spans the whole arc, not just stock. |
| **Repair workflows / repair API** (re-post, re-map, re-sync, DLQ drain) | **017** | stock-impact §5 explicitly assigns repair to 017. |
| Retry / DLQ posture for failed reconciliation | **017** | Consistent with the posting decision's failure posture. |

Working rule: **014 = the mapping + the *meaning* of reconciliation (what &
what-counts-as-mismatch). 017 = the *machinery* of reconciliation (when, report,
repair).** Whether a thin on-demand "compare now for this store" read belongs to
014 (as a mapping-adjacent diagnostic) or strictly to 017 is **OQ-5**.

---

## 9. Dependencies & gates

- **depends_on**:
  - **012-erpnext-connector-contracts** — **MERGED** (#476 / ADR 0008 #479 /
    `[GATED]` 012-CONTRACT #481 / closeout #482). The connector transport 014's
    reconciliation would ride exists on `main`.
  - **013-product-master-from-erpnext** — **CLOSED on `main`** (PR #489, merge
    `2d9de86`). Reconciliation per item needs the `erpnext_item_map` item
    correspondence (§7.3); a store's stock can only be reconciled against ERPNext
    for items that are mapped.
  - **009-inventory-stock-ledger** — **CLOSED on `main`**. The DP2 side of the
    comparison (operational on-hand) is the 009 compute-on-read ledger.
- **gated_by**: the signed **stock-impact decision**
  (011-DR-STOCK-IMPACT, **SIGNED** 2026-06-03 — gates 014/015/017). The gate is
  **SATISFIED**; 014's direction/authority is fixed by it (§5).
- **Sequenced before 015**: sale posting (015) needs the operational-vs-accounting
  split and the warehouse mapping settled first
  ([follow-up-spec-map §014/§015](../011-erpnext-pos-reference-and-integration-foundation/follow-up-spec-map.md)).
- **Feeds 017**: 014's mapping + reconciliation *definition* is what 017's jobs +
  repair API operate over.
- **Implementation remains blocked** until 014 has its own `plan.md` /
  `tasks.md` / `execution-map.yaml` and the Agent OS gates clear. Any DB schema,
  migration, or OpenAPI contract that 014 eventually needs is a separate
  `[GATED]` slice (§VIII / standing rules §3).

---

## 10. Explicit assumptions

### A-1 — ERPNext major version is UNCONFIRMED by staging validation
Per the signed **version-pin decision**
([011-DR-VERSION-PIN](../011-erpnext-pos-reference-and-integration-foundation/decisions/version-pin-upgrade-policy.md) §1):
the reference-lab baseline **may** be ERPNext/Frappe **v15**, but the final
supported major + exact point releases are confirmed in 012 after staging-install
validation (still pending).

> **014 MUST NOT assume v15 as implementation truth.** Any concept in §7 that is
> version-sensitive (the ERPNext Warehouse doctype shape, the Bin model, how Bin
> quantity is read) MUST be treated as **version-independent at the DP2 contract
> boundary** (012 O-6): the connector absorbs ERPNext version differences; the
> DP2-facing mapping + reconciliation definition speak in DP2 terms.

### A-2 — DP2 ↔ connector contract is version-independent
014's concepts are expressed in DP2/Retail-Tower terms, not ERPNext doctype
field names (012 O-6). An ERPNext upgrade changes the connector's internal
mapping, never 014's DP2-facing model.

### A-3 — No new external dependency is implied
014 does **not** authorize an ERPNext/Frappe client dependency in any DP2
package. Such a dependency is a separate `[GATED]` `package.json` decision
(version-pin §6; standing rules §3) — and lives in the connector repo, not DP2.

### A-4 — 009 is the DP2 operational on-hand, unchanged
014 reads 009's compute-on-read on-hand for the comparison; it does **not**
modify the 009 ledger, its RLS, or its append-only invariant.

---

## 11. Open questions (must be locked before implementation)

> **Status (updated 2026-06-04 — locked in [plan.md](./plan.md) via owner
> decision):** **OQ-1 + OQ-5** (collapsed) = **no ERPNext-quantity mirror; 017
> owns the fetch-compare** (014 = mapping + mismatch vocabulary only). **OQ-2** =
> **1:1 for v1, designed forward-compatible to warehouse-by-purpose** (owner: a
> future second warehouse for expired/returns product). **OQ-3** = **manual
> admin-set** (a `[GATED]` Console→DP2 contract; not 013's suggest-then-confirm —
> warehouses are few and need no matching). **OQ-4** (mismatch vocabulary &
> tolerance) stays open for the data-model / recon-def slice. The table below is
> the original planning enumeration; see [plan.md](./plan.md) for the locked
> decisions + the OQ-2 forward-compat rule.
>
> Per the repo cadence (011/012/013), these were **enumerated here and locked in
> `plan.md`** (owner answered at plan time). The **direction/authority** question
> is **NOT** here — it is **closed** by the signed stock-impact decision (§5).

| ID | Question | Why it blocks |
|---|---|---|
| **OQ-1** | **Mirror vs on-demand**: does DP2 store a snapshot of ERPNext Bin/Warehouse quantity (a new column/table) for reconciliation, or fetch it on-demand from the connector at reconcile time? (Decision permits mirroring "**MAY** … for reconciliation only" — permitted, not mandated.) | Drives whether 014 needs a mirror table + a refresh path, or is purely a mapping + a live-compare definition. Schema consequence. |
| **OQ-2** | **Cardinality**: strict **1:1** store↔Warehouse (signed default), or must a store map to **multiple** ERPNext Warehouses (main / returns / transit)? | Determines the mapping grain + uniqueness constraints; 1:1 is the signed default, multi-warehouse is a real ERPNext pattern that would widen it. |
| **OQ-3** | **Mapping lifecycle**: manual Tenant-Admin set, suggest-then-confirm (013 pattern), or admin-set-only; how kept current when ERPNext warehouses change? | Drives whether 014 needs an import/suggest path, an outbox event, and a review surface. |
| **OQ-4** | **Mismatch vocabulary & tolerance**: the exact mismatch classes (§7.4) and the quantity-delta tolerance semantics (exact match vs ± tolerance; how negative-balance flags are classed). | 017 reports/repairs against this vocabulary; it must be stable + exact (§III). |
| **OQ-5** | **014/017 line for on-demand compare**: does a thin "compare now for this store" diagnostic read belong to 014 (mapping-adjacent) or strictly to 017 (all reconciliation machinery)? | Fixes the §8 carve precisely so 014 and 017 neither duplicate nor leave a gap. |

---

## 12. Constitution Check (planning-level)

This spec is docs-only, so the check is at the **design-intent** level; a full
per-task Constitution Check lands in 014's future `plan.md`.

| Principle | How 014 (as specified) complies |
|---|---|
| **§I Reference, not source of truth** | No ERPNext fork / core copy-paste (§3, §6). Bespoke ERPNext lives in the connector's custom Frappe app, not this repo. |
| **§II Multi-tenant RLS** | Every mapping + reconciliation record is tenant-scoped (§7.5); cross-tenant non-disclosure (404) holds on any future read/write. Concrete RLS is a future gated slice. |
| **§III Backend authority & integrity** | Quantity exactness preserved; the comparison never silently rounds or reconciles away a divergence (§7.4, OQ-4). DP2 operational on-hand is authoritative; ERPNext valuation is the accounting counterpart. |
| **§IV Contract-first** | The connector is the only ERPNext edge; any ERP-backed DP2 endpoint ships as a `[GATED]` OpenAPI contract first (§6). DP2 owns the contracts. |
| **§IX Source-of-truth model** | DP2 stays operational stock authority; ERPNext owns valuation; the two are reconciled, never merged (§5 — **signed**). Read-down replacing DP2 availability is a STOP-and-raise (§5.4). |
| **§XI Idempotency & external IDs** | Reconciliation matches on correlation IDs (stock-impact §5); mapping establishment must be idempotent (future slice). |
| **§XIII Auditability & provenance** | Mapping records carry tenant/store/warehouse-ref/when/by-whom provenance (§7.5); mismatches are traceable for 017 repair (§7.4, §8). |
| **§VIII Reproducible releases** | No `package.json`/lockfile/schema/migration change in this PR; ERPNext version pin is an explicit unconfirmed assumption (§10 A-1), not a silent lock. |

The principle that **constrains the design** most is **§IX** — but unlike 013 it
is already **resolved by a signed decision** (§5), so 014's job is fidelity to
it, not re-deciding it.

---

## 13. Follow-up slices (proposals only — NOT executable yet)

> **Status (updated 2026-06-04):** the planning chain is now **complete** —
> `plan.md` + `data-model.md` + `tasks.md` + `execution-map.yaml` are authored
> (`014-PLAN` and the data-model that this section originally called
> `014-WAREHOUSE-MODEL` are **done**). The authoritative slice IDs + statuses live
> in [execution-map.yaml](./execution-map.yaml); the list below is aligned to
> those IDs. The two `[GATED]` slices remain `proposed` (owner approval per slice).

The execution-map's dispatchable slices (each requires Agent OS gates; the two
`[GATED]` ones require explicit per-slice owner approval before any code):

- **014-SIGNOFF / 014-SETUP** — record the read-down-rejected + no-mirror +
  no-run decisions (docs); scaffold the empty `apps/api` warehouse-map module.
  (`ready`.)
- **014-SCHEMA** `[GATED]` — the Drizzle schema `erpnext_warehouse_map` +
  migration (`0018` indicative, paired `*.down.sql`, RLS, `purpose`-grain
  partial-unique, **no Bin mirror**). Designed in [data-model.md](./data-model.md);
  authored in its own approval slice. (`proposed`.)
- **014-CONTRACT** `[GATED]` — the manual set/list/retire review OpenAPI
  (`cookieAuth`, §IV). (`proposed`.)
- **014-ISOLATION-HARNESS → 014-CRUD 🎯 → 014-RECON-DEF → 014-POLISH** — the
  capability slices (`blocked` on their predecessors). `014-RECON-DEF` ships the
  reconciliation *definition* (comparison + the OQ-4 mismatch-class vocabulary)
  that **017's** jobs consume — sequenced with 017's planning.
- **014-RECON-RUN** — the reconciliation *run* + reports + repair belongs to
  **017** (no spec yet); listed `proposed`, **not dispatchable** from this map.

Numbering and scope are advisory in this section; [execution-map.yaml](./execution-map.yaml)
is the authoritative dispatch source.

---

## 14. Acceptance criteria (for this planning spec)

- [ ] Purpose, boundaries, and the operational-vs-accounting split are stated and
      **match the signed stock-impact decision** (DP2 operational on-hand
      authority; ERPNext valuation; no read-down) — §5.
- [ ] The required concepts (§7) are each named and bounded over 001 stores +
      009 ledger, without rewriting 009.
- [ ] The **014↔017 reconciliation boundary** is carved explicitly (§8) so the
      two specs neither duplicate nor leave a gap.
- [ ] The direction/authority question is presented as **closed** (signed), not
      as an open OQ; the open questions (§11) are the genuinely-undecided ones
      (mirror-vs-on-demand, cardinality, lifecycle, mismatch vocabulary, the
      on-demand-compare line).
- [ ] The ERPNext-version-unconfirmed assumption is explicit (§10 A-1); v15 is
      not assumed as implementation truth.
- [ ] Dependencies/gates are accurate (012 merged, 013 + 009 closed, stock-impact
      SIGNED) and implementation is stated as blocked pending 014's own
      plan/tasks/map (§9).
- [ ] Follow-up slices are proposals only (§13).
- [ ] No runtime/OpenAPI/DB/package/lockfile/CI/connector/POS/Console file is
      touched; changed files are only under
      `specs/014-branch-inventory-reconciliation-and-warehouse-mapping/`.
