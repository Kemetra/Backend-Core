# Feature Specification: Inventory & Stock Movement Ledger

**Feature Branch**: `009-inventory-stock-ledger`

**Created**: 2026-05-31

**Status**: Draft

**Input**: User description: "009 inventory — a decoupled, append-only stock movement ledger with derived on-hand balance. v1 must NOT depend on the gated 008 live capture→process loop. Generic-retail core with a pharmacy-ready extension seam (lot/batch/expiry/FEFO as a future decision gate, not implemented in v1). Comprehensive Inventory & Stock Movements domain boundary, phased execution. Purchasing/receiving (011), payments (010), reporting (012) out of scope."

> **Authority wording superseded (RT-288, Inventory Planning Gate 1, recorded 2026-10-12).** As product direction, the inventory-authority wording of this
> feature is superseded by the owner-approved Inventory Operations baseline of 2026-10-07, decisions 719–727 (Confluence RETAIL page 22544389). This covers "Data-Pulse-2 owns **Inventory as a source-of-truth domain**"
> (§Overview), FR-003's rule that on-hand "always equals the signed sum of its movements", and the same wording in
> this feature's `plan.md` (§Summary, §IX row) and `data-model.md` ("The single source-of-truth row for every stock
> change"). Under that baseline:
>
> - ERPNext Stock Ledger/Bin is the financial/book stock quantity authority (719, 720).
> - Backend-Core owns operational inventory authority and Available To Sell (721, 722), without a competing
>   financial stock ledger (723).
> - 009 evolves conceptually from a Stock Ledger into an **Inventory Effects Journal plus operational
>   projection** (724).
> - `SUM(stock_movements)` is not the universal definition of inventory truth (726).
>
> Shipped code, data and history are unchanged (727). The shipped 009 implementation on `main` (append-only `stock_movements`, compute-on-read on-hand,
> idempotent dedup) stays as it is, and its foundations are preserved where useful (725). Whether and how
> sale-linked effects become active (US4 backfill, FR-025, FR-032, FR-060) is decided by Jira RT-289 (Gates 2+3),
> not by this spec.

## Overview

Data-Pulse-2 owns **Inventory as a source-of-truth domain** (Constitution §Repository Scope). This feature establishes that foundation: an **append-only stock movement ledger** per `(tenant, store, product)` and a **derived on-hand balance** computed from the movement history. Every change to stock is a recorded, auditable movement — never an in-place edit of a quantity. On-hand is always *explainable* by listing the movements behind it.

**Critical decoupling.** 008 captured the immutable sale fact (`sales` + `sale_lines`), but its **live capture→process loop is deferred/gated**: `sale.captured` is not yet an outbox event type, the producer binding is unbuilt, and `SaleWorker.start()` is not wired, so a captured sale emits nothing a worker can subscribe to. **009 v1 therefore does NOT subscribe to sale events.** Stock movements are created via API / manual action / backfill, and MAY reference an 008 `sale_id` / `sale_line_id` as **provenance**, but the ledger never *requires* live sale-event delivery. Automatic decrement on `sale.captured` is modeled as an explicit **future follow-up** that must be addable without redesigning the ledger.

**Domain shape.** v1 is **generic-retail**: stock is a quantity per `(tenant, store, product)`, no batch/lot/expiry on the base movement. A **pharmacy-ready extension seam** is designed (optional lot/batch dimension, expiry, FEFO, recall) and treated as a **required decision gate** for a later gated slice — but v1 MUST NOT force every product to carry expiry fields, and MUST NOT bake batch/expiry into the base movement in a way that would require rewriting the ledger to add them later.

## Clarifications

### Session 2026-05-31

- Q: When an outbound / transfer-out / sale-linked outbound movement would drive on-hand below zero, what should v1 do? → A: Allow and flag — accept the movement, permit negative on-hand, and emit/mark a negative-balance signal. Append-only and backfill-safe; never reject legitimate out-of-order or sale-linked outbound movements.
- Q: Quantity representation and unit-of-measure policy for v1? → A: Decimal quantity expressed in the product's single stocking unit. Cross-unit movements are rejected (no silent coercion); no unit-conversion engine in v1.
- Q: Does v1 include void/refund/return → restock? → A: Yes, as a manual/backfill restock (inbound) movement that references the 008 void/refund terminal event as provenance and is idempotent on that provenance. Automatic restock-on-void is deferred to the same future follow-up as auto-decrement.
- Q: Product identity for a movement, and how are ad-hoc/unresolved product references handled? → A: The product reference resolves to a Tenant Catalog product; an unresolved/ad-hoc reference is recorded as nullable provenance only. 009 MUST NOT auto-create a catalog product from a movement (mirrors 008 ad-hoc line discipline).
- Q: What is the idempotency dedup key for manual (non-provenance) movements? → A: `Idempotency-Key` header is the dedup contract for client-originated manual movements; `sourceSystem + externalId` (or the sale-reference pair) is the dedup contract for backfill / external-origin movements. Both converge to exactly-once.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Explain on-hand from the movement ledger (Priority: P1)

An authorized operator can view the current on-hand quantity for a product at a store **and** see the list of stock movements that produced it. On-hand is not a stored mutable number — it is derived from the append-only ledger, so it always reconciles to its history.

**Why this priority**: This is the irreducible core of the domain. Without a durable, explainable ledger and a correct on-hand derivation, no other inventory capability (transfers, counts, sale-linked outbound) has a foundation to stand on. It is the MVP: it delivers value (knowing and trusting stock levels) on its own.

**Independent Test**: Create a sequence of inbound and outbound movements via the API for one product at one store; query on-hand; assert it equals the signed sum of movements; query the movement list and assert it explains that balance.

**Acceptance Scenarios**:

1. **Given** no movements for a product at a store, **When** on-hand is queried, **Then** it returns zero (or "no stock record") deterministically, not an error.
2. **Given** an inbound movement of +10 then an outbound movement of −3 for the same `(tenant, store, product)`, **When** on-hand is queried, **Then** it returns 7.
3. **Given** a series of movements, **When** the movement list is queried, **Then** every movement is returned in a stable order with its type, signed quantity, timestamp, actor, and reason, and the listed movements sum to the reported on-hand.
4. **Given** movements exist for a product at store A, **When** on-hand is queried for the same product at store B, **Then** store B's balance is independent of store A's.

---

### User Story 2 - Record manual stock movements (inbound / outbound / adjustment) (Priority: P1)

An authorized operator can create stock movements directly: inbound (stock arriving outside of a purchasing flow), outbound (stock leaving outside of a sale), and adjustment (a correction in either direction with a reason). Each movement is append-only and auditable.

**Why this priority**: Manual movements are how stock first enters the system before any automated source exists, and how operators correct reality. Combined with US1, this is a usable inventory system on day one without depending on sales, purchasing, or any gated loop.

**Independent Test**: POST an inbound movement, then an adjustment, then an outbound movement for one product/store; assert each is persisted append-only, carries the acting principal, and writes an audit event; assert no prior movement was mutated.

**Acceptance Scenarios**:

1. **Given** an authorized operator, **When** they create an inbound movement with a positive quantity and a reason, **Then** the movement is appended, on-hand increases by that quantity, and an audit event is recorded.
2. **Given** an authorized operator, **When** they create an outbound movement, **Then** on-hand decreases (subject to the negative-stock policy in FR-024) and an audit event is recorded.
3. **Given** an authorized operator, **When** they create an adjustment movement with a reason, **Then** the signed correction is appended as a new movement — the system MUST NOT edit or delete any historical movement.
4. **Given** a movement-creation request carrying a forbidden field (`tenant_id`, `store_id`, `created_by`, a server-derived balance), **When** it is submitted, **Then** the forbidden field is ignored/rejected and tenancy/actor resolve from server-side context.

---

### User Story 3 - Idempotent / replay-safe movement creation (Priority: P1)

A movement-creation request that is retried (same idempotency key, or same `sourceSystem + externalId` provenance) MUST NOT apply the movement twice. On-hand converges to the single-application result regardless of how many times the request is replayed.

**Why this priority**: Inventory math that double-applies on retry is corrupt inventory. At-least-once delivery is the norm for any API/worker; exactly-once stock effect is a property this ledger must manufacture from day one — retrofitting it after movements exist is far harder.

**Independent Test**: Submit the same movement-creation request twice with an identical idempotency key; assert exactly one movement is appended and on-hand reflects a single application; assert the replay returns the prior result without a new side effect.

**Acceptance Scenarios**:

1. **Given** a movement created with idempotency key K, **When** the same request with key K is replayed, **Then** no second movement is appended and on-hand is unchanged from the first application.
2. **Given** a movement created from a provenance pair `(sourceSystem, externalId)`, **When** a second movement with the same pair is submitted, **Then** it is detected as a duplicate and not double-applied.
3. **Given** a replay of an idempotency key with a *different* body, **When** it is submitted, **Then** the system rejects it as a conflict rather than silently applying a divergent movement.

---

### User Story 4 - Sale-linked outbound movements via reference / backfill (Priority: P2)

An authorized operator (or a backfill process) can create an **outbound** movement that references an 008 `sale_id` / `sale_line_id` as provenance — *without* requiring any live sale-event subscription. This records that stock left because of a sale, traceably, even while the 008 live loop remains gated.

**Why this priority**: This is the bridge to sales reality that does NOT depend on the gated 008 loop. It proves the provenance seam works and lets a tenant reconcile stock against captured sales by explicit action or batch backfill today, while the automatic path is deferred.

**Independent Test**: With an 008 sale fact present, create an outbound movement referencing its `sale_id`/`sale_line_id`; assert the movement carries the provenance reference, decrements on-hand, is idempotent on the provenance pair, and required no event subscription to occur.

**Acceptance Scenarios**:

1. **Given** a captured sale and an authorized actor, **When** an outbound movement referencing that `sale_id`/`sale_line_id` is created, **Then** the movement records the reference as provenance and on-hand decreases accordingly.
2. **Given** a backfill that processes many captured sale lines, **When** it creates the corresponding outbound movements, **Then** re-running the backfill does not double-apply (idempotent on provenance — FR-031).
3. **Given** a sale-linked outbound movement, **When** the movement list is queried, **Then** the sale provenance reference is visible on the movement.
4. **Given** the 008 live capture→process loop is NOT wired, **When** any US1–US4 flow is exercised, **Then** it succeeds — no flow depends on `sale.captured` delivery.

---

### User Story 5 - Stock transfers between stores (Priority: P2)

An authorized operator can transfer stock from one store to another within the same tenant. A transfer is represented as **linked movements** (an outbound at the source, an inbound at the destination) that are traceable to each other as one logical transfer.

**Why this priority**: Multi-store tenants move stock between branches routinely. Modeling it as linked ledger movements (not a special mutable transfer object) keeps the "on-hand is always explainable by movements" invariant intact across stores.

**Independent Test**: Transfer N units of a product from store A to store B; assert store A on-hand decreased by N, store B increased by N, both movements share a transfer linkage, and the two movements are queryable as a pair.

**Acceptance Scenarios**:

1. **Given** stock at store A, **When** a transfer of N units to store B is created, **Then** an outbound movement at A and an inbound movement at B are appended and linked.
2. **Given** a completed transfer, **When** the movement list is queried at either store, **Then** the transfer linkage identifies the counterpart movement.
3. **Given** a transfer attempt to a store in a different tenant, **When** it is submitted, **Then** it is rejected with the canonical non-leaking response (cross-tenant safety).
4. **Given** the allow-and-flag negative-stock policy (FR-024), **When** a transfer-out would drive source on-hand below zero, **Then** the transfer is still recorded as linked movements, source on-hand may go negative, and a negative-balance signal is emitted — never a silent corrupt state, never a rejection.

---

### User Story 6 - Stock count variance produces correction movements (Priority: P2)

An authorized operator can record a physical stock count for a product at a store. Where the counted quantity differs from the derived on-hand, the system records a **correction movement** for the variance — it does **not** rewrite or delete the movement history to "make the number match."

**Why this priority**: Reconciling system stock to physical reality is a core inventory operation. Doing it as an append-only correction (rather than a history rewrite) preserves the audit trail and the "explainable on-hand" invariant — which is the whole point of a ledger.

**Independent Test**: With a known derived on-hand, submit a stock count of a different quantity; assert a correction movement equal to the signed variance is appended, on-hand now equals the counted quantity, and no prior movement was altered.

**Acceptance Scenarios**:

1. **Given** derived on-hand of 7, **When** a physical count of 5 is recorded, **Then** a correction movement of −2 is appended and on-hand becomes 5.
2. **Given** a count equal to derived on-hand, **When** it is recorded, **Then** either no correction movement or a zero-variance record is created (deterministic, documented), and history is unchanged.
3. **Given** a recorded count, **When** the movement list is queried, **Then** the correction movement is identifiable as count-variance-sourced with its reason/context.

---

### Edge Cases

- **Empty / never-stocked product**: on-hand query for a product/store with zero movements returns zero / "no record" deterministically, not a 404-as-error or a crash.
- **Outbound below zero**: allowed and flagged (FR-024) — the movement is appended, on-hand may go negative, and a negative-balance signal is emitted; never rejected, never silently corrupted.
- **Replay with divergent body**: same idempotency key, different movement payload → conflict, not silent divergence (FR-030).
- **Cross-tenant / cross-store reference**: a movement referencing a `sale_id`, product, or destination store belonging to another tenant → canonical non-leaking response (Principle II/XII).
- **Quantity / unit-of-measure mismatch**: a movement quantity in a unit inconsistent with the product's stocking unit → handled per the unit-of-measure policy (FR-022), not silently coerced.
- **Transfer to the same store** or zero-quantity movement → rejected as a validation error.
- **Fractional quantity** (e.g., weight-based or dispensed products) → governed by the quantity-representation policy (FR-022); the policy must state whether non-integer quantities are permitted.
- **Future lot/expiry data arriving on a generic v1 movement** → the extension seam must accept it later without a ledger rewrite (FR-040); in v1 such fields are absent, not silently dropped in a way that loses data.

## Requirements *(mandatory)*

### Functional Requirements

**Ledger & on-hand (core)**

- **FR-001**: System MUST persist stock changes as an **append-only** stock movement ledger; a recorded movement MUST NOT be edited or deleted by the application layer.
- **FR-002**: Each stock movement MUST be scoped to a `(tenant_id, store_id, product)` and carry a **signed quantity** (or an explicit direction + magnitude) and a movement **type** (at minimum: inbound, outbound, adjustment, transfer-out, transfer-in, count-correction). **Write-off** (damaged / expired / shrinkage removal) is modeled as a **reason-coded outbound** movement (not a separate base type) — the write-off reason distinguishes it from a sale-linked or manual outbound; v1 does not add a dedicated `write_off` enum member, but the domain boundary explicitly locates write-off here.
- **FR-003**: System MUST derive **on-hand** for a `(tenant, store, product)` from the movement ledger such that on-hand always equals the signed sum of its movements; on-hand MUST NOT be a separately mutable stored value that can drift from the ledger. *(An optional cached/materialized balance is permitted only if it is reconstructible from the ledger per Constitution §III — TTL-only caching of authoritative stock is forbidden.)*
- **FR-004**: Users MUST be able to list the movements behind an on-hand balance, in a stable order, each showing type, signed quantity, timestamp(s), acting principal, reason/context, and any provenance/linkage references. **Ad-hoc (NULL-product) movements** are still listable as auditable ledger entries — the movement list MUST support retrieving them (e.g., scoped to `(tenant, store)` without a product filter) so no recorded movement is unreachable; they simply do not roll up to any product's on-hand (see SC-001 and data-model Entity 2).
- **FR-005**: On-hand for a product/store with no movements MUST return a deterministic zero / "no record" result, never an error.

**Manual movement creation**

- **FR-010**: Authorized operators MUST be able to create **inbound** movements (positive quantity, with a reason).
- **FR-011**: Authorized operators MUST be able to create **outbound** movements (negative effect), subject to FR-024.
- **FR-012**: Authorized operators MUST be able to create **adjustment** movements (signed correction with a mandatory reason) recorded as new movements, never as edits to history.
- **FR-013**: Every stock-changing action MUST write an audit event (actor, tenant, store, operation, target, timestamp, correlationId, outcome) per Constitution §XIII.

**Idempotency & provenance**

- **FR-030**: Movement creation MUST be idempotent: a replay of the same `Idempotency-Key` with the same body MUST return the prior result and apply no second movement; a replay with a *different* body MUST be a conflict.
- **FR-031**: Movement creation MUST dedup by origin: **client-originated manual movements** use the `Idempotency-Key` header as the dedup contract (per the 001/005 idempotency primitive); **backfill / external-origin movements** use `sourceSystem + externalId` (or the sale-reference / terminal-event-reference pair) as the dedup contract. Either way, retries and re-run backfills MUST converge to exactly one application (no double-apply).
- **FR-032**: A movement MAY reference an 008 `sale_id` and/or `sale_line_id` as **provenance only**. The reference MUST NOT be required for a movement to exist, and the ledger MUST NOT depend on live `sale.captured` event delivery to function (decoupling requirement).
- **FR-033**: Re-running a sale-linked **backfill** MUST converge to the same ledger state as a single run (idempotent on the sale-reference provenance).

**Transfers, counts, policy**

- **FR-020**: System MUST represent an intra-tenant **transfer** as linked movements (outbound at source store, inbound at destination store) that are traceable to one another as a single logical transfer.
- **FR-021**: System MUST record a **stock count** such that any variance from derived on-hand is captured as an append-only **correction movement**, never a history rewrite; after a count, derived on-hand MUST equal the counted quantity.
- **FR-022**: **Quantity representation = exact-decimal; unit-of-measure = the product's single stocking unit.** A movement's quantity MUST be an exact-decimal value (no float; consistent with 008 `numeric` discipline) expressed in the referenced product's stocking unit. A movement whose unit is inconsistent with the product's stocking unit MUST be **rejected** — v1 MUST NOT silently coerce quantities across units and provides **no unit-conversion engine**.
- **FR-023**: **Product identity resolves to a Tenant Catalog product** (Tenant Product per Constitution §IX); the Global Catalog is reference-only. An **ad-hoc / unresolved product reference** (e.g., a sale-linked outbound for an 008 ad-hoc line with no resolvable tenant product) MUST be recordable as **nullable provenance only** — the movement still persists and affects on-hand for whatever identity it carries. 009 MUST NOT auto-create a Tenant Catalog product from a movement (mirrors 008's ad-hoc line discipline).
- **FR-024**: **Negative-stock policy = allow and flag.** Outbound, transfer-out, and sale-linked outbound movements MUST NOT be rejected for driving on-hand below zero; the movement is appended, on-hand MAY go negative, and the system MUST emit/mark a **negative-balance signal** for that `(tenant, store, product)`. This applies consistently across all outbound movement types. Rationale: a decoupled, backfill-friendly ledger routinely receives out-of-order or sale-linked outbound movements before the matching inbound; rejecting them would force fabricated inbound movements and break "on-hand is always explainable by movements." Hard non-negative enforcement is explicitly **not** chosen for v1.
- **FR-025**: **Void/refund/return → restock = manual/backfill inbound movement, provenance-linked, idempotent.** v1 represents a restock as an **inbound** movement that references the originating 008 void/refund terminal event (or a customer return) as **provenance**, deduped idempotently on that provenance (per FR-031). **Automatic** restock-on-void is explicitly **deferred** to the same future follow-up as automatic decrement (FR-060) and MUST NOT be required by v1.

**Tenant isolation & object safety**

- **FR-050**: All movement and on-hand operations MUST enforce tenant isolation at the database layer via RLS (fail-closed `current_setting('app.current_tenant', true)`), and MUST enforce store access server-side per Constitution §II.
- **FR-051**: Cross-tenant access to a movement, on-hand balance, product, sale reference, or destination store MUST return the canonical non-leaking response (404-semantics), never reveal existence (Principle II/XII).
- **FR-052**: Movement-creation request bodies MUST NOT be trusted for `tenant_id`, `store_id`, `created_by`, derived balances, or any server-owned field (mass-assignment ban, strict-schema boundary per Principle XII).
- **FR-053**: Unauthorized actors MUST NOT be able to mutate inventory; every protected read/write MUST carry explicit object-level authorization and fail closed by default.

**Pharmacy-ready extension seam (designed in v1, NOT implemented in v1)**

- **FR-040**: The v1 schema and API MUST be designed so an **optional lot/batch dimension** (batch/lot number, expiry date) can be added later **without rewriting the existing ledger** — i.e., generic-retail movements remain valid and lot becomes an optional sub-dimension of a movement, not a mandatory base-movement field.
- **FR-041**: v1 MUST NOT require generic-retail products to carry expiry/batch fields, and MUST NOT bake batch/expiry into the base stock movement in a way that forces a later migration to rewrite history.
- **FR-042**: The spec MUST treat the following as a **required future decision gate** (documented, not implemented in v1 unless explicitly approved in a later gated slice): lot/batch identity, **serial identity**, expiry date, **FEFO** picking, lot-level stock counts, lot-preserving transfers, recall/withdrawal support, and returned-stock-tied-to-a-known-lot. **Serial tracking is a distinct dimension from lot/batch** — lot/batch *groups* units sharing an expiry; a serial *identifies an individual unit* — so the gate MUST treat serial as its own optional dimension, not a field of the lot/batch dimension. The gate MUST record the chosen extension shape (how movements reference an optional lot/batch dimension and an optional serial dimension) before any pharmacy/serialized slice ships.

**Explicitly deferred / out of scope (modeled, not built)**

- **FR-060**: **Automatic decrement from `sale.captured`** MUST be modeled as a later follow-up (a "008-live-loop" or "009-sale-consumer" slice) that depends on the producer binding, `sale.captured` outbox event registration, and worker-start wiring. It MUST NOT block or be required by the v1 stock ledger, and MUST be addable without redesigning the ledger.
- **FR-061**: Purchasing / suppliers / receiving workflows are **out of scope** (belong to a future 011 feature). v1 inbound movements are generic, not purchase-order-driven.
- **FR-062**: Payment / tender handling is **out of scope** (010).
- **FR-063**: Reporting / analytics over inventory is **out of scope** (012). v1 exposes the movement list and on-hand read API only.

### Key Entities *(include if feature involves data)*

- **Stock Movement** *(NEW)*: an append-only record of a single stock change. Scoped to `(tenant_id, store_id, product reference)`. Carries type, signed quantity, reason/context, acting principal, timestamps, idempotency/provenance keys, optional sale-reference provenance (`sale_id`/`sale_line_id`), and optional transfer linkage. Immutable after insert. Designed to later carry an *optional* lot/batch sub-dimension reference (FR-040).
- **On-Hand Balance** *(DERIVED)*: the current quantity for a `(tenant, store, product)`, computed from the movement ledger. Not an independently mutable entity; any materialized form is reconstructible from the ledger.
- **Transfer linkage** *(NEW, relationship)*: the association binding a transfer-out movement to its transfer-in counterpart as one logical transfer.
- **Stock Count** *(NEW)*: a recorded physical count for a `(tenant, store, product)` that yields a correction movement for any variance (the count itself is provenance for the correction; it does not mutate prior movements).
- **Product reference** *(consumed, not owned)*: resolves to the Tenant Catalog product (003, Constitution §IX). Read-only for 009.
- **008 sale / sale_line** *(consumed as provenance, not modified)*: referenced by sale-linked outbound and restock movements; 009 reads, never mutates, the sale fact.
- **Lot / Batch dimension** *(FUTURE, gated)*: optional sub-dimension for pharmacy-grade tracking (batch/lot number, expiry). Designed-for in v1, implemented only in a later gated slice (FR-042).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can explain any current on-hand quantity by listing the movements behind it. For movements with a **resolved `tenant_product_ref`**, the listed movements sum exactly to the reported product on-hand in 100% of cases (no unexplained drift). **Ad-hoc (NULL-product) movements are listed as auditable ledger entries but are excluded from any product's on-hand computation** (you cannot track stock of a thing you cannot identify) — they never silently distort a product balance.
- **SC-002**: A stock movement can reference a sale / sale line as provenance and be created with **zero** dependency on live sale-event subscription — verified by exercising every v1 flow with the 008 live loop unwired.
- **SC-003**: Replaying a movement-creation request (same idempotency key or same provenance pair) applies the movement exactly once in 100% of replay attempts; no replay produces a second stock effect.
- **SC-004**: Every transfer is traceable end-to-end: from either store, the linked counterpart movement is discoverable in 100% of completed transfers.
- **SC-005**: Recording a physical count makes derived on-hand equal the counted quantity via an appended correction movement, with prior movement history unchanged in 100% of counts (no history rewrites).
- **SC-006**: 100% of cross-tenant and cross-store access attempts against movements, on-hand, transfers, and sale references return the canonical non-leaking response; an RLS bypass probe with the wrong tenant returns zero rows.
- **SC-007**: 100% of inventory-mutating actions are rejected for unauthorized actors and recorded as audit events for authorized ones.
- **SC-008**: The future automatic sale-event decrement can be introduced as a follow-up slice that adds a movement source **without** altering the v1 movement/on-hand schema or ledger semantics (verified at design-review of the extension seam).
- **SC-009**: The pharmacy lot/batch/expiry/FEFO extension can be introduced later without rewriting existing generic-retail movements (verified at design-review of the lot-dimension seam).

## Assumptions

- **008 sale fact exists; its live loop does not.** 008 (`sales` + `sale_lines` + void/refund terminal events) is CLOSED on `main`, but its live capture→process loop is gated (`processed_at` stays NULL; `sale.captured` is not an outbox event type; `SaleWorker.start()` is not wired). 009 v1 explicitly does **not** rely on that loop. *(Dependency the planning phase MUST sequence: automatic decrement (FR-060) depends on a future 008-live-loop / 009-sale-consumer slice landing first.)*
- **Reuses existing platform primitives.** Tenant-context/RLS, the idempotency mechanism, the audit pipeline, and the outbox are consumed as-is (001/005) — no new primitive is invented for them.
- **Product identity resolves to the Tenant Catalog** (003, Constitution §IX); the Global Catalog is reference-only. Ad-hoc / unresolved product references follow 008's allowance for ad-hoc lines.
- **Single-region, single-currency posture** consistent with the rest of the platform; inventory carries no monetary value in v1 (valuation/costing is reporting/analytics, out of scope per FR-063).
- **Generic-retail v1, pharmacy-ready seam.** v1 tracks quantity per `(tenant, store, product)` with no mandatory batch/expiry; the lot/batch/expiry/FEFO extension is a designed-for, gated future decision (FR-040–FR-042), not implemented in v1 unless explicitly approved in a later gated slice.
- **Phased execution.** The spec defines the full Inventory & Stock Movements domain boundary, but v1 implementation is the foundational ledger + on-hand + manual/sale-referenced/transfer/count movements (US1–US6). Auto-decrement (FR-060), restock-on-void automation (FR-025), pharmacy FEFO (FR-042), purchasing (011), payments (010), and reporting (012) are out of v1 implementation scope.
- **Schema, migration, dependency, and OpenAPI-contract changes are `[GATED]`** per Constitution §VIII and the repo working agreement; the concrete Drizzle schema, the SQL migration, and the `packages/contracts/openapi/**` surface are authored in approved gated slices during planning/implementation, not in this spec.
