# Implementation Plan: Inventory & Stock Movement Ledger

**Branch**: `docs/009-inventory-stock-ledger` (spec dir: `009-inventory-stock-ledger`) | **Date**: 2026-05-31 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification at [`spec.md`](./spec.md); five owner decisions resolved in [`spec.md` §Clarifications](./spec.md) (Session 2026-05-31).

**Mode**: Planning-only. This `/speckit-plan` output authorizes **no implementation**. It creates **no** schema, migration, OpenAPI YAML, package file, or code. The `[GATED]` artifacts it designs against (the inventory OpenAPI contract and the `0014+` SQL migration) are each their own approval-gated slice, not authored here (Constitution §IV/§VIII, Standing Rules §3).

---

## Summary

009 establishes **Inventory as a source-of-truth domain** (Constitution §Repository Scope): an **append-only stock movement ledger** keyed by `(tenant, store, product)` plus a **derived (compute-on-read) on-hand balance**. Every stock change is a recorded, auditable, immutable movement; on-hand is the signed SUM of movements and is always explainable by its history.

The defining constraint is **decoupling from the gated 008 live loop**: 009 v1 does NOT subscribe to `sale.captured`. Movements are created via API / manual action / backfill, and MAY reference an 008 sale as **provenance only** — a sale-linked backfill reads the **captured** (immutable) `sales` / `sale_lines` rows directly, never `processed_at`-stamped ones (which stay NULL while the loop is gated). Automatic decrement and automatic restock-on-void are **modeled but deferred** to a future "008-live-loop / 009-sale-consumer" slice, addable without redesigning the ledger.

Five owner decisions are resolved (spec §Clarifications): negative stock = **allow and flag** (emits a **new** negative-balance signal); quantity = **exact-decimal in the product's single stocking unit** (cross-unit rejected, no conversion engine); void/refund → restock = **manual/backfill provenance-linked inbound** (auto deferred); product identity = **Tenant Catalog product, ad-hoc = nullable provenance, no auto-create**; idempotency = **`Idempotency-Key` for manual, `sourceSystem+externalId`/sale-ref for backfill**.

It builds **alongside** the shipped 001/005/008 platform seams (idempotency interceptor, tenant-context/RLS helpers, audit + outbox emitters) — no ingestion primitive is re-invented. The only genuinely new surface is the movement-ledger schema + its OpenAPI contract, both `[GATED]`.

---

## 1. Technical Context

### 1.1 Stack inheritance — no new platform dependencies

009 runs on the existing stack with **zero new platform dependencies**: Node 20 / TypeScript 5 strict, NestJS 11 (api + worker), PostgreSQL 16 + RLS + Drizzle, Redis 7 + BullMQ, OpenAPI 3.1 + Zod, Jest + Supertest + Testcontainers, pino + OpenTelemetry + Prometheus. Quantity is exact-decimal `numeric(p,s)` round-tripped via the same string-backed discipline 008 used for money (gate A.6) — **no big-decimal library, no `[GATED]` `package.json` change** (see §10).

### 1.2 Inputs from the spec

- **Entities** (new): Stock Movement, Stock Count; (derived) On-Hand Balance; (relationship) Transfer linkage; (consumed) Tenant Catalog product, 008 sale/sale_line; (future, gated) Lot/Batch dimension. (spec Key Entities)
- **Behavioral requirements**: FR-001..063 (spec §Requirements).
- **Resolved owner decisions**: the five Session-2026-05-31 clarifications (spec §Clarifications), mirrored into the FRs they resolve (FR-024, FR-022, FR-025, FR-023, FR-031).

### 1.3 NEEDS CLARIFICATION

**One, resolved here by informed default (recorded in §Assumptions / §4.2):** the near-term **API audience + auth** for 009's operator-facing movement endpoints. The dashboard is a deferred feature, and 009's movements (manual inbound/adjustment/count/transfer) are **back-office/operator actions**, not POS-device actions — so they do NOT inherit 008's `/api/pos/v1/` device-token model wholesale. **Default chosen**: operator-facing movement + on-hand endpoints are a **dashboard/back-office (`cookieAuth`) surface**; the **sale-linked backfill** is a separate platform/admin-invoked path (not a public POS route). This is load-bearing for the `[GATED]` contract's `security` section and is recorded as an explicit assumption, not silently defaulted. All other parameters are HOW-level, settled by the constitution + the five clarifications.

### 1.4 Performance goals

- On-hand read (compute-on-read SUM over a single `(tenant, store, product)`): directional p95 ≤ 300 ms at the SaaS boundary; not a hard gate in v1 (report-only, mirroring 005/008's perf posture pending a perf env).
- Movement creation: directional p95 ≤ 400 ms inline.
- Backfill throughput: governed by a documented per-tenant bound (§1.5), not the inline budget.
- **Note**: hard numeric perf assertions are report-only in v1; a dedicated perf env is a documented platform deferral (per 005 SC-008 / 008 SC-010 precedent).

### 1.5 Constraints

- **Append-only ledger** (FR-001); no UPDATE/DELETE of a movement by the app layer.
- **On-hand is derived, compute-on-read** (FR-003); any materialized balance is reconstructible from the ledger (§III) — v1 does **not** materialize (see §10).
- **Quantity exact-decimal in the product's single stocking unit** (FR-022); cross-unit rejected, no conversion engine; floats forbidden.
- **Allow-and-flag negative stock** (FR-024) — never reject outbound for going negative; emit a **new negative-balance signal** (§3.3).
- **Idempotent creation** dual-keyed (FR-031): `Idempotency-Key` (manual) / `sourceSystem+externalId` + sale-ref (backfill); replays + re-run backfills converge to exactly-once.
- **Decoupling** (FR-032/060): no dependency on `sale.captured` delivery; backfill reads **captured** sale rows.
- **Object safety** (FR-052): forbidden mass-assignment fields, strict `.strict()` boundary, safe-404 cross-tenant, default-deny.
- **Per-tenant backfill bound**: a documented batch ceiling for the sale-linked backfill path (initial default **500 movements/request**, layered on the inherited 001/004 rate-limit posture; mirrors 008 gate D.2).

### 1.6 Scale / scope

- Additive only: a **new** `apps/api/src/inventory/` module (controller/service/module triad mirroring `catalog/sales/`), the **new** movement-ledger Drizzle schema + `0014+` migration (`[GATED]`), the **new** inventory OpenAPI contract (`[GATED]`), and new test suites. No change to 003 catalog schema, 005 reconciliation contracts, 008 sale schema (read-only as provenance), or any shipped RLS.

---

## 2. Constitution Check

Anchored to `.specify/memory/constitution.md` v3.0.1. 009 is the **first feature to own the Inventory source-of-truth domain** and the **first to introduce a negative-balance observability signal**.

### 2.1 Initial gate evaluation

| Principle | Verdict | Binding |
|---|---|---|
| I. Reference, not source of truth | PASS | Spec authored from requirements + constitution; nothing lifted from legacy `Data-Pulse`. |
| II. Multi-tenant by default | PASS | FR-050 (NOT NULL `tenant_id`/`store_id`, fail-closed RLS `current_setting('app.current_tenant', true)::uuid`), FR-051 cross-tenant = non-disclosing 404; store access server-side. |
| III. Backend authority & integrity | PASS | FR-001 append-only; FR-003 on-hand **derived (compute-on-read)**, not a mutable stored value — no cache-as-truth, no version column needed (§10); FR-022 quantity exact-decimal, no float. |
| IV. Contract-first POS integration | PASS-with-gate | The inventory OpenAPI contract is a **`[GATED]`** slice (not authored here). No raw DB entities in responses — `toBody()` projection (binds plan/tasks). `security` per §4.2 (cookieAuth operator surface + platform backfill). |
| V. Async work in workers | PASS | The sale-linked **backfill** and any future auto-decrement (FR-060) run off-request in a worker carrying `tenantId`/`storeId`/`correlationId`, tenant context set before DB access. Inline movement creation stays synchronous (validation + single append). |
| VI. Test-first quality | PASS-with-binding | SC-001..009 + the **mandatory RLS-bypass probe** (wrong-tenant GUC ⇒ zero rows) on the new movement table, cross-tenant + cross-store sweep, malicious-override (FR-052), idempotency-replay + backfill re-run (FR-031/033); RED before GREEN. |
| VII. Observable systems | PASS-with-new-signal | **009 introduces ONE new signal: the negative-balance signal** (FR-024) — a per-`(tenant, store, product)` flag on the balance **and** a new OpenTelemetry counter (`meter.createCounter`, exported via the Prometheus exporter) of negative-balance occurrences. Labels follow the existing `api.metrics.ts` allowlist (closed, low-cardinality, PII-free — NOT tenant/store, which the `assertMetricLabels` allowlist forbids). Not in §VII's named list; consciously added (§3.3). All other logging reuses request/correlation-id; no secret/PII in logs. |
| VIII. Reproducible & versioned releases | PASS-with-gate | New schema/migration (`0014+`) is **`[GATED]`** + reversible (paired `*.down.sql`, lock-duration reviewed); none authored here. Quantity value object adds **no dependency** (§10). |
| IX. Source-of-truth model | PASS (exercised) | 009 **owns** Inventory truth (movement ledger). Reads Tenant Catalog product (reference) + 008 sale fact (provenance) **read-only**; never writes either. Cross-layer write forbidden (FR-023 no auto-create of catalog product). |
| X. Retail temporal semantics | PASS | Movements carry `occurredAt` (business event) + `receivedAt` (server clock); backfilled/out-of-order movements accepted (the decoupling premise). Storage UTC `TIMESTAMPTZ`; security clock = server clock. |
| XI. Idempotency & external IDs | PASS | FR-030/031/033 — dual dedup contract (`Idempotency-Key` manual / `sourceSystem+externalId`+sale-ref backfill); reuses 001/005 `Idempotency-Key` primitive unchanged; re-run backfill converges. |
| XII. Authorization & object safety | PASS | FR-052 (mass-assignment forbidden: `tenant_id`/`store_id`/`created_by`/derived balances), strict boundary, FR-051 safe-404, FR-053 object-level authz + default-deny. |
| XIII. Auditability & provenance | PASS | FR-013 canonical audit on **every** stock-changing action; movement carries provenance keys (sale-ref / terminal-event-ref / `sourceSystem+externalId`); audit insert-only, emitter-redacted. |
| XIV. PII & data lifecycle | PASS | Movement ledger = **business-class** (catalog refs, quantities, provenance ids only; **no PII, no payment/tender** in v1). Retention inherits the 001 long-horizon insert-only posture; right-to-erasure tombstones any future PII field. Recorded in the `0014` migration header + a lifecycle guard test. |
| Per-Tenant Resource Isolation | PASS | Documented per-tenant backfill bound (500/req initial default, §1.5) layered on inherited 001/004 posture. Compute-on-read on-hand is a bounded single-key SUM. |
| Concurrency & Optimistic Locking | PASS | Append-only fact ⇒ no `version` column; **allow-and-flag dissolves the read-compute-write race** — concurrent outbounds both append + flag, no TOCTOU, no locking (§10). LWW not applicable (nothing is overwritten). |

**Initial gate: PASS** (one PASS-with-new-signal: the negative-balance signal is consciously introduced, §3.3 — not a violation). No principle requires a Complexity-Tracking justification (§10 records only *avoided* complexity).

> **Superseded (RT-288, Inventory Planning Gate 1, recorded 2026-10-12):** "009 establishes **Inventory as a source-of-truth domain**" (§Summary) and the §IX row's
> "009 **owns** Inventory truth (movement ledger)" now read, as product direction, as follows. Backend-Core owns
> *operational* inventory authority (721). ERPNext Stock Ledger/Bin is the financial/book quantity authority (719).
> 009 evolves into an Inventory Effects Journal plus operational projection (724, 726). Source: the owner-approved Inventory Operations baseline of 2026-10-07, decisions 719–727 (Confluence RETAIL page 22544389).
> Shipped code, data and history are unchanged (727). Whether and how sale effects are activated, and how ERP confirmation avoids double counting, is decided by Jira RT-289 (Gates 2+3).

### 2.2 Post-design re-check

After Phase 1 artifacts (`research.md`, `data-model.md`, `contracts/README.md`, `quickstart.md`) the 14 principles + supporting sections were re-evaluated: no artifact creates backend code, schema, migration, or OpenAPI; the data model keeps on-hand derived (no materialized mutable balance), quantity exact-decimal single-unit, movement append-only with nullable provenance, the negative-balance signal a flag+counter, and the contract design consumption-only with the YAML deferred to a gated slice. **Post-design gate: PASS.**

---

## 3. Architecture Impact Map

Per Constitution Working Agreement ([`.specify/memory/architecture-impact.md`](../../.specify/memory/architecture-impact.md)).

### 3.1 Impact classification

**New additive module + new gated schema + ONE new observability signal.** Touches (when implemented, across gated slices): a **new** `apps/api/src/inventory/` module (controller/service/module triad mirroring `catalog/sales/`), the **new** movement-ledger Drizzle schema + `0014+` migration (`[GATED]`), the **new** inventory OpenAPI contract (`[GATED]`), a worker path for the sale-linked backfill, and new test suites. **Reuses unchanged**: the 001/005 idempotency interceptor (`apps/api/src/idempotency/`), tenant-context + `with-tenant` helpers (`packages/db/src/middleware/tenant-context.ts`, `packages/db/src/helpers/with-tenant.ts`), audit insert (`packages/db/src/helpers/audit-insert.ts`), the outbox producer (`packages/db/src/outbox/producer.ts`). **Reads read-only**: 008 sale schema (`packages/db/src/schema/sales/`) + 003 Tenant Catalog product. **Does not touch**: 003/005/008 schemas, auth module, or any other feature's surface.

### 3.2 Triggered review gates

- **`[GATED]` OpenAPI contract** — the inventory contract under `packages/contracts/openapi/**` requires explicit per-slice approval (§IV/§VIII, Standing Rules §3). Its own slice, before any implementing slice's GREEN. **Not created by this plan.**
- **`[GATED]` SQL migration** — the `0014+` migration creating the movement-ledger table(s) + their fail-closed RLS policies (§VIII). Paired `*.down.sql`, reviewed for lock duration. Its own slice. **Not created by this plan.**
- **Isolation-harness extension** — every new movement / on-hand / transfer / count operation MUST be added to the cross-tenant + cross-store sweep, and a raw-SQL **RLS-bypass probe** added for the new table (§VI).
- **New observability signal registration** — the negative-balance signal (§3.3) must land registered (a new OpenTelemetry `meter.createCounter` in `api.metrics.ts` + the balance flag) with the slice that introduces negative-balance handling; §VII requires it be named, not ad-hoc.
- **Per-tenant resource-isolation posture** — the backfill batch bound (500/req initial default) must land documented with the backfill slice.

### 3.3 New observability signals

**ONE new signal — the negative-balance signal (FR-024).** Unlike 008 (which reused named signals), 009's allow-and-flag policy requires a signal that does **not** exist in the constitution §VII named list (queue lag, failed-job, auth-failure, RLS failures, POS sync lag, duplicate-event, unknown-item, reconciliation-mismatch). It manifests as **both**: (a) a per-`(tenant, store, product)` **negative-balance flag** queryable on the on-hand projection, and (b) a **new OpenTelemetry counter** of negative-balance occurrences (`meter.createCounter` in `api.metrics.ts`, exported via the Prometheus exporter; labels per the existing allowlist — closed, low-cardinality, PII-free — NOT tenant/store). Registered with the negative-balance-handling slice. No other new metric category.

---

## 4. Dependency Readiness (the 009 implementability map)

### 4.1 Seam-by-seam: shipped / reuse / new

| 009 capability | Existing status on `main` | 009 work |
|---|---|---|
| Operator-facing write/read route | **Shipped pattern** — NestJS controller/service/module triad in `catalog/{sales,reconciliation,unknown-items}/` | **New, mirror the pattern**: an `apps/api/src/inventory/` module with movement-create + on-hand-read + movement-list + transfer + count routes |
| Idempotency on writes | **Shipped** — `idempotency.interceptor.ts` + `@Idempotent` decorator; body-fingerprint mismatch ⇒ deterministic conflict | **Reuse unchanged** for manual movements (FR-030/031); 009 adds no new primitive |
| `sourceSystem + externalId` dedup | **Shipped pattern** — natural dedup in 005/008 capture paths | **Reuse the pattern** for backfill / external-origin movements (FR-031) |
| Tenant context + RLS GUC | **Shipped** — `tenant-context.ts` + `with-tenant.ts` set `app.current_tenant` in-transaction | **Reuse unchanged** for the new movement table (FR-050) |
| Audit emission | **Shipped** — `audit-insert.ts` canonical insert | **Reuse** for every stock-changing action (FR-013) |
| Outbox / worker | **Shipped** — `outbox/producer.ts`; `apps/worker/` registered | **Reuse** for the sale-linked backfill (FR-033) + future auto-decrement (FR-060) |
| 008 sale fact (provenance target) | **Shipped** — `sales`/`sale_lines`/void/refund on `main`; composite FK `(sale_id, tenant_id, store_id) → sales(id, tenant_id, store_id)` | **Read-only as provenance**; a sale-linked movement carries `(sale_id, tenant_id, store_id)` (or stays nullable provenance) — 009 never writes the sale fact |
| Movement-ledger schema | **NOT shipped** — highest migration `0013`; no inventory schema anywhere | **New + `[GATED]`** — Drizzle schema + `0014+` migration, its own slice |
| Inventory OpenAPI contract | **NOT shipped** | **New + `[GATED]`** — its own slice; designed in `contracts/README.md`, YAML not authored here |
| Negative-balance signal | **NOT shipped** — not in §VII named list | **New** — OpenTelemetry `meter.createCounter` (in `api.metrics.ts`) + balance flag (§3.3) |

### 4.2 Audience + auth — operator surface, NOT a POS-device route

009's manual inbound/outbound/adjustment/count/transfer are **back-office/operator actions**. They do **not** fit 008's `/api/pos/v1/` POS-device-token model. Since the dashboard is a deferred feature, the near-term default (recorded as an assumption, §1.3): operator movement + on-hand endpoints are a **dashboard/back-office (`cookieAuth`) surface**, object-level-authorized per store; the **sale-linked backfill** is a separate **platform/admin-invoked** worker path (not a public POS route). The `[GATED]` contract's `security` section must honor this split. (If a POS-device inventory surface is later required, it is an additive contract version, not a v1 concern.)

### 4.3 LOAD-BEARING: backfill reads CAPTURED sale rows, not processed ones

The decoupling claim (FR-032/060, SC-002) is concrete because the sale-linked backfill reads the **immutable captured** `sales` / `sale_lines` rows directly. It does **not** read `processed_at`-stamped rows — `processed_at` stays NULL while the 008 live loop is gated. 009 therefore needs nothing from the gated loop to function; auto-decrement (which *would* react to processing) is the deferred follow-up (FR-060).

### 4.4 LOAD-BEARING: a sale-linked movement and an 008 sale_line are DISTINCT records

An outbound movement that references a `sale_line` is **provenance lineage**, not a copy of the line. 009 never mutates the sale fact, never auto-creates a Tenant Catalog product from a movement (FR-023, mirroring 008's ad-hoc-line discipline), and an ad-hoc/unresolved product reference is recorded as **nullable provenance** — the movement still persists and affects on-hand for whatever identity it carries.

### 4.5 TL;DR implementability gate

All ingestion plumbing (idempotency, dedup, tenant-context/RLS, audit, outbox, worker) is **shipped and reused unchanged**. The genuinely new surface is the movement-ledger schema + its OpenAPI contract (both `[GATED]`, each its own slice) and one new observability signal. The five owner decisions are resolved; the single open parameter (API audience/auth) is fixed by informed default in §4.2. No open WHAT-level blockers.

---

## 5. Project Structure

### 5.1 Documentation (this feature)

```text
specs/009-inventory-stock-ledger/
├── spec.md                  # /speckit-specify output (+ Clarifications, Session 2026-05-31)
├── checklists/
│   └── requirements.md      # spec-quality checklist (all pass)
├── plan.md                  # THIS FILE
├── research.md              # Phase 0 — settled decisions + rationale
├── data-model.md            # Phase 1 — entities, fields, nullability (design level, NOT DDL)
├── contracts/
│   └── README.md            # Phase 1 — operation/contract DESIGN; YAML deferred to a [GATED] slice
├── quickstart.md            # Phase 1 — planning/validation workflow (not a runtime runbook)
└── tasks.md                 # /speckit-tasks output (NOT created by this command)
```

### 5.2 Source code (repository root) — ADDITIVE only, created by implementing slices

```text
apps/api/src/inventory/              # NEW module, mirrors catalog/sales/ triad
├── inventory.controller.ts          #   movement-create + on-hand-read + movement-list + transfer + count routes (cookieAuth)
├── inventory.service.ts             #   movement append + on-hand compute-on-read; reuses dedup + tenant-context
└── inventory.module.ts

packages/db/src/schema/inventory/    # NEW movement-ledger Drizzle schema — [GATED]
└── stock-movements.ts               #   append-only movement (+ optional transfer linkage, + stock-count provenance)

packages/db/drizzle/
├── 0014_inventory.sql               # NEW migration — [GATED], paired 0014_inventory.down.sql
└── 0014_inventory.down.sql

packages/contracts/openapi/
└── inventory/                       # NEW OpenAPI inventory contract — [GATED], NOT created here

apps/worker/                          # sale-linked backfill path (reuses outbox); future auto-decrement (deferred)
```

**Structure decision**: a new `apps/api/src/inventory/` module mirroring the shipped `catalog/sales/` triad. The `[GATED]` schema/migration (`0014+`, since `0013_store_timezone` is the current highest) and OpenAPI contract are **flagged, not authored** — each is its own approval-gated slice (§3.2).

---

## 6. Phase 0 — Research

See [`research.md`](./research.md). With the five owner decisions resolved and the API-audience default fixed (§4.2), Phase 0 records the settled decisions (Decision / Rationale / Alternatives) rather than open research — there are no residual NEEDS CLARIFICATION.

## 7. Phase 1 — Design & Contracts

- **Data model**: [`data-model.md`](./data-model.md) — Stock Movement (+ transfer linkage, + stock-count provenance) at field/nullability level, on-hand as a derived read, the pharmacy lot-dimension seam. Design level, not DDL.
- **Quickstart**: [`quickstart.md`](./quickstart.md) — the planning/validation workflow for 009 (implementation is gated).
- **Contracts**: [`contracts/README.md`](./contracts/README.md) — operation DESIGN + inherited wire conventions + the `cookieAuth`/backfill `security` split; explicitly defers the OpenAPI YAML to a `[GATED]` slice (no field shapes copied).
- **Agent context**: the repo root `CLAUDE.md` carries **no `<!-- SPECKIT -->` markers** (it is hand-maintained), so the speckit marker-update step does **not** apply and `CLAUDE.md` is left unmodified.

---

## 8. Implementation Phasing (advisory — `/speckit-tasks` is next)

A likely slice order (the authoritative ordered list is `tasks.md` / `execution-map.yaml`, produced by `/speckit-tasks`):

1. **`[GATED]` inventory OpenAPI contract** — movement-create / on-hand-read / movement-list / transfer / stock-count operations, error categories, `toBody` projections, `cookieAuth`+backfill `security` split.
2. **`[GATED]` `0014` migration + Drizzle schema** — movement ledger (+ transfer linkage, + stock-count provenance) + fail-closed RLS + the paired `*.down.sql`; lifecycle/classification header.
3. **Isolation harness extension** — cross-tenant/cross-store sweep + RLS-bypass probe for the new table (RED).
4. **On-hand read + movement list (US1)** — compute-on-read SUM + stable-order listing (RED→GREEN).
5. **Manual movements + idempotency (US2/US3)** — inbound/outbound/adjustment + `Idempotency-Key` dedup + mass-assignment ban + audit.
6. **Negative-balance signal** — flag + a new OpenTelemetry `meter.createCounter` in `api.metrics.ts` (lands with the first outbound-below-zero path).
7. **Sale-linked outbound via reference + backfill (US4)** — provenance reference, worker backfill, `sourceSystem+externalId`/sale-ref dedup, decoupling test (008 loop unwired).
8. **Transfers (US5)** — linked outbound/inbound movements + cross-tenant safety.
9. **Stock count + variance correction (US6)** — count → correction movement, no history rewrite.
10. **Void/refund → restock (FR-025)** — manual/backfill provenance-linked inbound (automatic deferred).
11. **Lifecycle/PII guard test (§XIV)** — assert no PII/payment-class field persisted in v1.

## 9. Out of Scope (reaffirmed)

Per spec §Requirements / §Assumptions: **automatic** sale-event decrement (FR-060, future 008-live-loop / 009-sale-consumer slice) and **automatic** restock-on-void (FR-025) — v1 ships only their manual/backfill equivalents; pharmacy lot/batch/expiry/FEFO (FR-040..042 — designed-for seam, gated); purchasing/suppliers/receiving (011); payment/tender (010); inventory reporting/analytics/valuation (012); dashboard UI; POS-side behavior; materialized on-hand balance (§10). No `[GATED]` artifact (OpenAPI, migration, `package.json`) created by this plan.

## 10. Complexity Tracking

| Potential complexity | Decision | Why simpler alternative was viable |
|---|---|---|
| Optimistic-concurrency `version` column | **Not added** | Movements are an append-only fact; nothing is overwritten. The **allow-and-flag** negative-stock decision (FR-024) **dissolves the read-compute-write race**: concurrent outbounds both append + flag, so there is no TOCTOU and no row to lock. §III's "LWW must be justified" is satisfied — there is no LWW because there is no write-over. |
| Materialized on-hand balance table | **Not added (v1)** | A materialized balance would be a **new mutable resource**, triggering §III's cache-invalidation-trigger and concurrency obligations. v1 keeps on-hand **compute-on-read (SUM over a bounded single `(tenant, store, product)` key)** — reconstructible by definition, no invalidation surface. FR-003 *permits* materialization later if perf demands; it is not built now. |
| Big-decimal arithmetic library | **Not added** | v1 sums exact-decimal quantities in a **single stocking unit** (no cross-unit conversion, FR-022). The same string-backed value-object discipline 008 used for money (gate A.6) round-trips to `numeric(p,s)` with no float — **no `[GATED]` `package.json` dependency**. |
| Unit-of-measure conversion engine | **Not added** | FR-022 rejects cross-unit movements rather than converting; a conversion engine is out of v1 scope. |

No constitution violations. The four rows above are *avoided* complexity, recorded for provenance.

---

## Appendix — Files inspected during planning

- `.specify/memory/constitution.md` (v3.0.1) — principles + supporting sections.
- `.specify/memory/architecture-impact.md` — Architecture Impact Map rule.
- `specs/009-inventory-stock-ledger/spec.md`, `checklists/requirements.md`.
- `specs/008-sales-transaction-capture/plan.md` — house plan structure mirrored here.
- `apps/api/src/catalog/{sales,reconciliation,unknown-items}/` — the module triad + ingestion seam pattern.
- `apps/api/src/idempotency/{idempotency.interceptor.ts,idempotent.decorator.ts}` — the reused idempotency primitive.
- `packages/db/src/{helpers/with-tenant.ts,helpers/audit-insert.ts,middleware/tenant-context.ts,outbox/producer.ts}` — reused platform helpers.
- `packages/db/src/schema/sales/{sales.ts,sale-lines.ts,sale-terminal-events.ts}` — the 008 provenance targets (read-only).
- `packages/db/drizzle/` — confirmed highest migration `0013_store_timezone`; no inventory schema exists; 008 sale FK shape `(sale_id, tenant_id, store_id)`.
- `packages/contracts/openapi/` — confirmed `catalog/`, `pos-sales/`, `pos-payments/` dirs; no `inventory/` yet.
