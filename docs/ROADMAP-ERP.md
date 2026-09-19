# Roadmap: Path to a Meaningful Retail ERP — Backend-Core

> **Planning / roadmap document. Advisory only.** This is a durable sequencing artifact, not an approval to implement. No slice here is green-lit. Each spec listed below must still go through its own Spec-Kit planning chain (`spec.md` -> `plan.md` -> Constitution Check -> `[GATED]` OpenAPI contract -> `tasks.md` -> `execution-map.yaml`) and the standing Agent OS gates before any code is written. Numbers `008`-`012` are proposed identifiers, not reserved.

> **Erratum (2026-06-03) — numbering superseded for `011`+.** The 008→012 chain below is partly stale: the repo actually shipped **008=Sales**, **009=Inventory-Stock-Ledger**, **010=POS-Catalogue-Read-Down**. The identifiers **011–017 are now claimed for the ERPNext integration arc** — see [`specs/011-erpnext-pos-reference-and-integration-foundation/`](../specs/011-erpnext-pos-reference-and-integration-foundation/spec.md). The retail-loop capabilities named here (Payments, Purchasing, Reporting) are re-homed onto the ERPNext backbone or take free numbers after 017 in their own future specs. This document is retained as the pre-ERPNext reasoning record.

Product: **Retail Tower OS** — backend = this repo (`Kemetra/Backend-Core`), admin UI = `Kemetra/Admin-Console` (separate repo), POS = `Kemetra/POS` (separate repo).

"**Meaningful ERP**" here means the **retail operations loop** only: *sell -> record money -> move stock -> restock -> see the numbers.* It explicitly does **not** mean generic ERP — no manufacturing, HR, payroll, or a full general ledger.

---

## 1. Current state (what is actually shipped)

Verified by reading the schema tree under [`packages/db/src/schema/`](../packages/db/src/schema/) and the migrations under [`packages/db/drizzle/`](../packages/db/drizzle/). Highest migration on `main` is **`0011_catalog_store_carveout_sentinel`**.

| Spec | Domain | State | What it gives us |
| --- | --- | --- | --- |
| [`001-foundation-auth-tenant-store`](../specs/001-foundation-auth-tenant-store/) | Auth / tenant / store / identity | Shipped | `tenants`, `stores`, `users`, `memberships`, `roles`, `permissions`, `sessions`, `auth_tokens`, `invitations`, `audit_events`, `idempotency_keys`, `outbox_events`, `devices` |
| [`003-catalog-foundation`](../specs/003-catalog-foundation/) | Tenant/global catalog | Shipped (22 slices, migrations `0007`–`0011`) | `global_products`, `tenant_products`, `store_product_overrides`, `price_history`, `product_aliases`, `tenant_product_categories`, `unknown_items` |
| [`005-pos-catalog-sync-reconciliation`](../specs/005-pos-catalog-sync-reconciliation/) | POS -> catalog reconciliation | Shipped (fully closed) | POS capture of *unknown items*, link / create-product / conflict audit + metrics; the live POS ingestion seam |
| [`007-unknown-items-review-queue-api`](../specs/007-unknown-items-review-queue-api/) | Review-queue dashboard API | Wave 1 (P1 MVP) merged | Review-safe list / inspect / dismiss / reconcile over `unknown_items`; later waves (reopen, bulk-dismiss, guards) still proposed |

### Explicit schema gaps (the reason this roadmap exists)

The schema tree has **23 schema files** and **none** of the following. These are the load-bearing absences for a retail ops loop:

- **No sales / orders / invoices / sale-line tables.** No `pgTable` named `sale`, `order`, `invoice`, or `sale_line` anywhere in the schema tree. (The only `sale*` token in the codebase is `sale_context`, a `jsonb` advisory column on `unknown_items` — opaque, non-interpreted, not a modeled sale.)
- **No inventory / stock-movement tables.** No `inventory` or `stock_movement` file or `pgTable`.
- **No payments tables.** Payments exists **only** as an OpenAPI contract stub: [`packages/contracts/openapi/pos-payments/vouchers.yaml`](../packages/contracts/openapi/pos-payments/vouchers.yaml) (Voucher Authority, `posValidateVoucher` / `posRedeemVoucher` / `posReverseVoucher`). That contract notes `payment_tender_lines` and `PaymentAttempt` are POS-Pulse-side, not backend DB tables.
- **No purchasing / supplier tables.** The only `supplier` token is `supplier_code`, an alias `identifier_type` CHECK value in [`packages/db/src/schema/catalog/product-aliases.ts`](../packages/db/src/schema/catalog/product-aliases.ts) — an alias type, not a supplier or purchasing table.

What **is** already pinned and reusable: **catalog-pricing money**. `tenant_products`, `store_product_overrides`, `price_history`, and `global_products` all store money as `numeric(19,4)` + a `char(3)` ISO-4217 currency code, each guarded by a paired-currency CHECK (`(price IS NULL AND currency IS NULL) OR (price IS NOT NULL AND currency IS NOT NULL)`). This is the precedent transaction money must follow — but it does **not** by itself satisfy the transaction-money decision (see the gate in §3).

---

## 2. Backend sequence: 008 -> 012

The retail loop is built in this order. **008 is the keystone** — everything downstream records *against* a sale. After 008, **009 and 010 form a parallel tier**: each depends only on 008, **not on each other**.

| Spec (proposed) | Domain | Depends on | Why this, before that | Hard gate in front of it |
| --- | --- | --- | --- | --- |
| **008 Sales / Transaction Capture** | Sale facts: invoice + sale-line snapshots, totals, provenance, temporal catalog | 003 (catalog refs), 005 (POS ingestion seam) | The keystone. There is no money to reconcile, no stock to decrement, and nothing to report until a sale is a first-class fact. 009/010/011/012 all read or attach to sale facts. | **Money + temporal decision slice** (see §3) — a required prerequisite |
| **009 Inventory & Stock Movements** | `stock_movement` ledger, on-hand derivation | **008 only** | A sale must decrement stock; a stock ledger needs a sale event to hang the "sold" movement on. Independent of payments. | Standard planning + `[GATED]` contract |
| **010 Payments & Tender Reconciliation** | Tender lines, change, payment vs invoice reconciliation | **008 only** | Recording *how* a sale was paid (and reconciling tender to invoice total) needs the invoice/total from 008. Independent of inventory. Greenfield on the backend — only the POS-side voucher contract stub exists today. | Standard planning + `[GATED]` contract |
| **011 Purchasing & Suppliers** | Suppliers, purchase orders, receiving -> stock-in | 008, **009** | "Restock" closes the loop: purchasing feeds stock-in movements, so it builds on the 009 stock ledger. | Standard planning + `[GATED]` contract |
| **012 Reporting / Analytics read-models** | Read-only aggregates over sales / inventory / payments / purchasing | 008, 009, 010, 011 | "See the numbers" is last — read-models aggregate the facts the prior specs produce. | Standard planning + `[GATED]` contract |

### Parallel track (not in the 008 -> 012 chain)

- **Catalog-Management API** (unnumbered) — write/curate endpoints over the already-shipped 003 catalog schema. **Independent of 008.** It unblocks the console catalog-management screens (console RF-3, currently *blocked, verified-absent*). It can proceed on its own planning track at any time; it does not wait on the sales keystone.

---

## 3. The 008 hard gate: money + temporal decision slice

Before **any** sales slice ships, a thin **decision slice** must pin two things the constitution leaves open. These are the constitution's *own* open Follow-up TODOs, and §III / §X make them blocking prerequisites for sales. Source: [`.specify/memory/constitution.md`](../.specify/memory/constitution.md) (v3.0.1).

**Already pinned (do not re-litigate):** catalog-pricing money — `numeric(19,4)` + ISO-4217 currency, as shipped in 003.

**Not yet pinned — the gate must decide and record these:**

1. **Transaction money.** §III: *"Money representation MUST be defined explicitly before any sales / catalog pricing implementation. Floating-point money is forbidden."* The Money/Tax/Rounding section: *"The exact money library / representation MUST be chosen and recorded before any sale or catalog-pricing slice ships."* Catalog-pricing money is settled, but **transaction money is not**: line-level tax, invoice-vs-line **rounding policy**, tender/change, and multi-tax composition are unmodeled. Plus the Follow-up TODO: *"Define exact-decimal money representation (numeric(p,s) precision + chosen money library) before any sale/catalog pricing slice."*
2. **Per-entity timestamp catalog.** §X enumerates `occurredAt` / `receivedAt` / `processedAt` / `businessDate` / `sourceClockAt` / `voidedAt` / `refundedAt`, mandates *"security clocks are server clocks,"* and that *"offline POS sync and delayed events are expected ... MUST NOT be silently rewritten or rejected."* The Follow-up TODO: *"Define the timestamp catalog schema for sale facts (which timestamps are required vs optional per entity)."* §X defers the exact required-vs-optional set to the entity's spec — so **008 must decide it**.
3. **Payload-hash algorithm.** Follow-up TODO: *"Decide payload-hash algorithm for POS provenance (sha256 of canonical JSON?)."* Ties to §IX/§XIII provenance requirements.

Other 008 constitutional invariants to satisfy (no decision needed, but binding):

- **§IX SaleLine snapshot is truth.** Price/name/tax/unit at moment of sale are historical truth; subsequent catalog changes MUST NOT mutate past sale lines.
- **§IX provenance.** Each ingested event carries `sourceSystem`, `externalId`, ingestion timestamp, and a payload hash so the SaaS view reconciles to the original payload.
- **§III POS totals preserved as received.** SaaS MAY reconcile and flag mismatches but MUST NOT silently rewrite historical POS totals.
- **§XI dedup.** POS ingestion uses `sourceSystem + externalId` (or an idempotency key, or both); the same pair resolves to the same record across retries. (Already implemented in the 005 seam — see §5.)
- **§XII mass-assignment forbidden.** `tenant_id`, `store_id`, `status`, etc. not assignable from request bodies; strict DTOs reject unknown keys.
- **§III concurrency.** New mutable resources SHOULD use optimistic concurrency (`version` + `If-Match`); last-write-wins MUST be justified.

---

## 4. Cross-cutting: per-tenant resource isolation (rate limits)

§ "Per-Tenant Resource Isolation": *"The first POS sync feature MUST land with a documented per-tenant resource isolation posture, even if values are initial defaults."* Per-endpoint rate limits are SHOULD-level for ingestion-heavy / bulk-write endpoints, but the **documented posture is a hard MUST**. Because **008 is an ingestion-heavy POS-facing feature**, 008's planning chain must carry an explicit per-tenant isolation posture (Follow-up TODO: *"Decide per-tenant request quota policy and noisy-neighbor strategy before the first POS sync feature lands."*). 009–011 bulk-write endpoints (stock adjustments, purchase imports) should inherit/extend that posture.

---

## 5. The 005 ingestion seam (what 008 builds alongside)

005 today ingests **only** catalog reconciliation — a POS submission captures an *unknown item* into `unknown_items`. It models **no** sale: the capture payload ([`apps/api/src/catalog/unknown-items/dto/capture-request.dto.ts`](../apps/api/src/catalog/unknown-items/dto/capture-request.dto.ts), `PosCaptureItemRequestSchema`, `.strict()`) carries exactly four fields — `identifier_type`, `identifier_value`, `source_system`, `sale_context` — with no line-items, totals, or payment fields.

The POS-facing route is the seam an 008 Sales ingestion mounts **alongside**:

- Controller: [`apps/api/src/catalog/unknown-items/unknown-items.controller.ts`](../apps/api/src/catalog/unknown-items/unknown-items.controller.ts) — `posCaptureItem`, route `POST /api/pos/v1/catalog/unknown-items`.
- Service: [`apps/api/src/catalog/unknown-items/unknown-items.service.ts`](../apps/api/src/catalog/unknown-items/unknown-items.service.ts) — `UnknownItemsService.captureItem`.
- Module: [`apps/api/src/catalog/unknown-items/unknown-items.module.ts`](../apps/api/src/catalog/unknown-items/unknown-items.module.ts) — `UnknownItemsModule`.

This is the only `/api/pos/v1/...` (POS-device-token) route in catalog; dashboard routes use `/api/v1/...`. 008's POS-facing sales ingestion would be a sibling here. The §XI dedup contract is already proven in this seam: natural dedup on `(tenant_id, store_id, identifier_type, value, source_system)` **plus** the `Idempotency-Key` interceptor ([`apps/api/src/idempotency/idempotency.interceptor.ts`](../apps/api/src/idempotency/idempotency.interceptor.ts)), with mismatch failing closed (409, no side-effects).

---

## 6. POS-Pulse emission caveat

`POS-Pulse` currently emits only a **closed catalogue** — audit events (e.g. `shift.open`) and unknown-item captures — **not** sale transactions. So 008 can be **built and tested independently** (contract-first, per Principle IV), but the **live end-to-end sales loop** additionally requires POS-Pulse to emit sales against 008's published contract. This is a one-line downstream dependency, not a blocker on building 008.

---

## 7. Contract-first coupling to the console

Principle IV (contract-first) makes the two repos **one ordered list**: a `Retail-Tower-Console` screen can only be built once the matching `[GATED]` OpenAPI contract is merged here. The mapping of backend spec/contract -> the console RF family it unblocks:

| Backend spec / contract | Unblocks console RF family |
| --- | --- |
| Catalog-Management API (parallel track) | **RF-3** catalog management (today *blocked, verified-absent*) |
| **008** Sales / Transaction Capture | Future sales/transaction console views (no RF family defined yet) |
| **009** Inventory & Stock Movements | Future inventory console views |
| **010** Payments & Tender Reconciliation | Future payments/tender console views |
| **012** Reporting / Analytics read-models | Future reporting/dashboard console views |

The shipped 005 + 007 review-queue/reconciliation contracts already unblock console **RF-4a** (list / dismiss / inspect) and **RF-4b** (reconciliation). Console RF-7 (settings) has **no backend spec yet**.

See the console mirror doc (`Retail-Tower-Console/docs/ROADMAP-CONSOLE-MIRROR.md`) for the shadow sequence and per-RF readiness detail.
