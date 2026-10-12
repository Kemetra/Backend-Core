# Feature Specification: Sale Settlement & Receivables Model

> **SUPERSEDED IN PART — 035 NARROWED TO OPTION B (RT-423, recorded 2026-10-12).** 035-DR-SETTLEMENT OQ-7
> (7-C) is superseded by **Amendment A1** in
> [`decisions/settlement-receivables-decision-record.md`](./decisions/settlement-receivables-decision-record.md),
> following the owner-approved Payment, Tender & Receivables baseline of 2026-10-07 (Confluence RETAIL 23560196).
> Per [RT-413](https://rahmaqanater.atlassian.net/browse/RT-413), ERPNext owns customer and third-party A/R
> balances, cash application/allocation, aging, payment terms, credit limits, collections and accounting
> reconciliation. Backend-Core keeps only the per-sale payer responsibility allocation (captured on the sale at
> checkout, RT-413 R-1) and the payer identity facade.
>
> `receivable.outstanding_balance`, `payment_application` / `consoleApplyPayment`, the claim and remittance
> balance logic, `payer_account.credit_terms` and the `settlement-intent` route are being retired through
> separate `[GATED]` follow-ups. Do not build new work on them. The text below is kept unchanged as
> historical record.

**Feature folder (speckit nominal)**: `035-sale-settlement-and-receivables-model`

> **Numbering note.** Dispatch named this feature `035`. At specify time the highest
> existing spec is `specs/034-pos-roster-cashier-user-id/`; `035` is the next free
> slot. No existing artifact is reused, renamed, or overwritten. (Recorded per the
> documented monotonic-numbering convention and the 020/021 + 027→028 collision
> precedent.)

**Created**: 2026-06-15

**Status**: SPECIFY + signed owner decision (**035-DR-SETTLEMENT**, 2026-06-15). This
document produces **no** code, OpenAPI YAML, migrations, DTOs, services, workers,
tests, package/lock, CI, generated clients, or child-repo specs. It defines the
**target** settlement-and-receivables model and the **contract intent** that
downstream POS, Console, and Connector features will later consume. The three carried
open questions (OQ-2/OQ-4/OQ-7) are **RESOLVED** (§11) — the **non-reversal** G2
contract **draft** may proceed; reversal-compatibility fields stay deferred on DP-026.
Gate **G2 is RATIFIED** (2026-06-15, T012): the contract `settlement.yaml` is authored,
merged (PR #574, `cb4a7e5`), and owner-approved — the five children are unblocked. The
non-reversal carve, connector posting, tax, and DP-2 implementation/G3 remain gated
(see §10 Gate Mapping and the 035-DR-SETTLEMENT G2 Ratification addendum).

**Input**: Owner / program dispatch — Retail Tower OS opens a **settlement work
package**. Before any child-repo work begins, Data-Pulse-2 must author the **parent
producer spec** that defines the settlement and receivables model: customer/payer
account relationships, third-party payer / insurer / corporate account concepts,
receivable lifecycle, sale-settlement lifecycle/state machine, settlement commands
and outcomes, payment-entry / cash-application decision points, claim/remittance
reconciliation concepts, idempotency/replay and audit/observability expectations,
tenant/store isolation, and tax-pending placeholders. The feature **must not**
implement code, OpenAPI, migrations, or child specs, and **must not** define a
competing reversal model — reversal/void/refund/insurance-rejection paths reuse the
existing DP-026 + Connector Arc A + POS-014 surfaces.

---

## 0. What this spec IS and IS NOT (read first)

This is a **parent producer / contract-intent spec**, in the same SPECIFY-only
posture as 028 (boundary definition) and the determination posture of 026.
It exists to:

- **Define** the settlement-and-receivables business/product model so a later,
  separately-gated DP-2 slice can author the **G2 contract** (the OpenAPI surface)
  that POS, Console, and Connector consume.
- **Anchor** the model to existing Retail Tower decisions and constitution
  principles, so the eventual contract is a coherent extension, not a fork.
- **Carve** clear responsibilities across the five repos (who captures, who
  manages, who posts) **at product-contract level only**.

This spec **MUST NOT**:

- Author or edit any OpenAPI YAML (`packages/contracts/openapi/**`).
- Author or edit any application/service/DTO/worker/test code.
- Author any migration, package/lock, CI, generated client, secret, or env file.
- Author any **child-repo** spec (POS 020, Console 017 / 018 / 019, Connector 009).
- Define a **competing** reversal / void / refund / insurance-rejection workflow
  (those reuse DP-026 + Connector Arc A + POS-014 — see §3 Non-Goals).
- Invent Egypt-VAT allocation rules (tax is activation-only under ADR-0003 — §6/§9).
- Mark gate **G2 satisfied**. G2 is the owner's contract approval on a later,
  separately-authored OpenAPI slice. This spec defines the *intent*; it does **not**
  certify the contract (§13).

### 0.1 The settlement work package (who depends on whom)

```
        ┌─────────────────────────────────────────────────────────┐
        │  DP-2 035  sale-settlement-and-receivables-model         │
        │  (THIS SPEC — parent producer; later authors G2 contract)│
        └─────────────────────────────────────────────────────────┘
                  │ G2 contract approved  ⇒ unblocks children
                  ▼
   ┌───────────────────┬───────────────────┬──────────────────────┐
   │ POS 020           │ Console 017        │ Connector 009         │
   │ credit & third-   │ customer & payer   │ receivables & third-  │
   │ party tender flow │ accounts           │ party posting adapter │
   ├───────────────────┼───────────────────┴──────────────────────┤
   │ Console 018  receivables & insurance claims                   │
   ├──────────────────────────────────────────────────────────────┤
   │ Console 019  settlement-reconciliation (LAST; also needs       │
   │              DP-2 032 runtime wiring)                          │
   └──────────────────────────────────────────────────────────────┘
```

**All children are BLOCKED until DP-2 035's G2 contract is approved.** This spec
does not author any child; it only defines the producer model and consumer notes
(§12).

---

## 1. Summary

Retail Tower spans five repositories — Data-Pulse-2 (backend / source-of-truth),
the Retail-Tower-ERPNext-Connector, the POS-Pulse terminal, the
Retail-Tower-Console admin SPA, and the Retail-Tower-Orchestrator — integrating
only through Data-Pulse-2's pinned OpenAPI contracts. Today a sale is **captured**
and **synced** as a forward fact (008 capture, 015 posting, 032 sync-status), but
the platform has **no model of how a sale is settled when the payer is not the
person at the counter** — credit customers, corporate accounts, and insurers who
pay later, in part, or via a claim/remittance cycle.

In business terms: a customer buys goods but pays on account; or an insurer covers
70% of a prescription while the patient pays the 30% co-pay at the till; or a
corporate account is invoiced monthly. The sale is real and must be captured now,
but the **money owed** lives on past the transaction as a **receivable** that is
later collected, applied, claimed, remitted, and reconciled. This spec defines the
target model for that lifecycle — **who** owes, **how much**, against **which
sale**, in **what state**, and **how** payments are applied and claims reconciled —
so that POS can capture settlement intent, Console can manage the accounts and
claims, and the Connector can later post the financial movements to ERPNext.

### Core principle (stated once, governs everything below)

> **The sale fact is immutable. Settlement is a separate, evolving lifecycle layered
> over it.** Capturing a sale never waits on settlement; settling a sale never
> rewrites the sale. Backend authorizes and owns settlement state; POS captures
> intent; Console manages accounts and claims; Connector posts the result.

---

## 2. Actors

| Actor | Role in settlement |
|-------|--------------------|
| **Cashier / POS operator** | Captures the sale and the **settlement intent** at the till: tender split, payer reference, co-pay vs covered amount, claim metadata. Captures intent only — never authorizes a receivable or posts money. |
| **Store / branch manager** | Oversees till-level credit decisions within policy; may be required to approve credit settlement at capture (policy knob, plan-phase). |
| **Console accounts administrator** | Manages customer and payer accounts, credit terms, receivable balances, cash application, and claim/remittance lifecycle from the Console. |
| **Insurer / third-party payer (external party)** | Not a system user. Modeled as a **payer account** the receivable is owed by; interacts via claims and remittances managed in Console / posted via Connector. |
| **Corporate / account customer (external party)** | A payer account invoiced and collected on terms. |
| **Connector** | Later consumer. Posts approved settlement / receivable / claim movements to ERPNext (valuation / back-office). Never in the POS auth or capture path. |
| **Data-Pulse-2 backend** | Authority. Owns settlement state, receivable lifecycle, idempotency, audit, tenant/store isolation, and the G2 contract that everyone else consumes. |

---

## 3. Non-Goals (explicit)

- **NG-1 — No parallel/competing reversal model.** This feature does **not** define a
  new void / refund / return / insurance-rejection workflow. Those reuse the
  **existing** surfaces: **DP-026** (returns/reversal contract), **Connector Arc A**
  (forward-feed reversal posting), and **POS-014** (POS-side return flow). Settlement
  references those outcomes; it does not reimplement them.
- **NG-2 — No child-repo specs.** This spec does **not** author POS 020, Console 017,
  Console 018, Console 019, or Connector 009. It produces the parent model + consumer
  notes only (§12).
- **NG-3 — No implementation.** No APIs, DTOs, services, workers, DB schema,
  migrations, tests, OpenAPI YAML, generated clients, or UI are produced here.
- **NG-4 — No Egypt-VAT allocation rules.** Tax is activation-only under **ADR-0003**
  (G6); VAT apportionment across payers / co-pays is **deferred** (OQ-2). This spec
  leaves **tax-pending placeholders** only and invents no allocation math (§9, §11).
- **NG-5 — No final reversal / payment-entry field shapes.** Reversal-compatibility
  fields and payment-entry / cash-application fields are framed conceptually but are
  **not finalized** until OQ-4 (DP-026 technical compatibility) and OQ-7 (Payment
  Entry ownership) are resolved (§11). SPECIFY is not blocked by them.
- **NG-6 — No authority handover.** ERPNext remains valuation / back-office; it is
  never the source of truth for the operational sale or the receivable state.
  Settlement state is owned by DP-2 (Constitution §I, §III, §IX).
- **NG-7 — No new identity provider or auth scheme.** Identity/access reuses the
  028-arc operator-authorization envelope and Console session boundary (G10, §8).

---

## 4. User Scenarios & Testing *(mandatory)*

### User Story 1 — Capture a sale settled against a credit / third-party payer (Priority: P1)

A cashier rings up a sale where the customer does not pay the full amount in cash at
the till — for example a corporate account customer paying on terms, or a partial
co-pay with the balance owed by an account. The cashier captures the **settlement
intent** (who pays, how the tender splits, any payer reference) alongside the sale.
The sale is captured immediately; a **receivable** for the unpaid balance is opened
against the named payer account. The cashier is never blocked waiting on settlement.

**Why this priority**: This is the reason the feature exists — without a settlement
model, a sale that is not fully cash-tendered cannot be represented honestly. P1
delivers the producer's core contract intent: capture-time settlement intent →
receivable open.

**Independent Test**: Reviewable by walking a documented capture-with-credit example
through the model and confirming (a) the sale fact is complete and immutable, (b) a
receivable in an initial open state is associated to the correct payer account, and
(c) the cashier path captures intent only (no authorization / posting). No code is
run; this validates the contract intent and state transitions.

**Acceptance Scenarios**:

1. **Given** a captured sale with a tender split of part-cash + part-account,
   **When** the settlement intent is recorded, **Then** the model defines a
   receivable opened against the named payer account for the unpaid balance, linked
   to the sale, without mutating the sale fact.
2. **Given** the same capture replayed with the same idempotency key,
   **When** it is processed again, **Then** the model requires the same single
   receivable outcome (no duplicate receivable) — replay-safe (G5, §11).
3. **Given** a capture naming a payer account that does not exist in the tenant,
   **When** settlement intent is recorded, **Then** the model defines a deterministic
   safe outcome (rejected / flagged for Console) and never silently posts to the
   wrong account (§4 Edge Cases, Constitution §II/§XII).

---

### User Story 2 — Manage payer accounts and apply payments / cash (Priority: P2)

A Console accounts administrator manages customer and payer accounts (credit
customers, corporate accounts, insurers), sets credit terms, sees outstanding
receivable balances per payer, and **applies** received payments / cash against open
receivables (full or partial cash application). The receivable lifecycle advances as
payments are applied.

**Why this priority**: Receivables that can be opened but never collected or applied
are not a usable model. P2 delivers the collection / cash-application half of the
lifecycle that Console 017 / 018 consume.

**Independent Test**: Reviewable by walking a payer account from creation → open
receivable → partial payment applied → remaining balance → settled, confirming each
state transition and the cash-application decision points are defined and
deterministic.

**Acceptance Scenarios**:

1. **Given** an open receivable against a payer account, **When** a payment is
   applied for less than the balance, **Then** the model defines a partial-applied
   state with a reduced outstanding balance and an audit trail of the application.
2. **Given** an open receivable, **When** a payment is applied that clears the
   balance, **Then** the model defines the receivable transitioning to a settled
   terminal state.
3. **Given** a payment application replayed with the same idempotency key, **When**
   reprocessed, **Then** the balance is not double-reduced (G5 replay-safety).

---

### User Story 3 — Claim and remittance reconciliation for an insurer payer (Priority: P3)

For an insurer payer, the receivable is collected through a **claim → remittance**
cycle: claims are submitted (conceptually, by Console), remittances arrive (in full,
partial, or with rejected lines), and the platform **reconciles** remitted amounts
against the claimed receivables. Rejections route to the existing reversal/return
surfaces (DP-026 + Connector Arc A + POS-014), not to a new workflow here.

**Why this priority**: Insurance / third-party claim reconciliation is the most
complex payer path and the last child (Console 019, which also needs DP-2 032 runtime
wiring). It depends on P1/P2 being modeled first, so it is P3.

**Independent Test**: Reviewable by walking a claimed receivable through full
remittance, partial remittance, and a rejected line — confirming the reconciliation
concepts are defined, and that **rejection reuses the existing reversal surface** (no
competing model authored here).

**Acceptance Scenarios**:

1. **Given** a receivable submitted as a claim, **When** a full remittance is
   reconciled, **Then** the model defines the receivable settled and the variance
   recorded as zero.
2. **Given** a claim with a partial remittance, **When** reconciled, **Then** the
   model defines a remaining outstanding balance and a recorded variance.
3. **Given** a claim line rejected by the insurer, **When** processed, **Then** the
   model **routes the rejection to DP-026 + Connector Arc A + POS-014** (reuse), and
   does **not** define a new rejection workflow (NG-1).

---

### Edge Cases

- **Unknown / cross-tenant payer account at capture** — settlement intent naming a
  payer that does not exist *in the tenant* must yield a deterministic safe outcome
  and must never resolve to another tenant's account (cross-tenant ⇒ safe 404,
  Constitution §II/§XII).
- **Over-application of cash** — a payment applied for more than the outstanding
  balance must have a defined outcome (reject / cap / record-as-credit), not silent
  truncation.
- **Replay / duplicate** — duplicate capture, duplicate payment application, and
  duplicate remittance must each be replay-safe via idempotency keys (G5).
- **Partial / split tender at capture** — cash-now + owed-balance must split cleanly;
  the cash portion is part of the immutable sale, the owed portion opens a receivable.
- **Negative or zero balances** — a receivable that nets to zero or below from
  remittance variance must reach a defined terminal/flagged state, not an
  indeterminate one.
- **Settlement of a reversed sale** — if the underlying sale is later
  voided/returned via DP-026, the receivable's reaction must be defined as
  *consuming* the reversal outcome, never as a new reversal (NG-1; OQ-4).
- **Out-of-order remittance before claim recorded** — a remittance arriving before
  its claim is acknowledged must have a defined holding/parking behavior.
- **Tax-pending** — any field that would carry VAT/tax is a placeholder; no
  allocation across payers is computed until G6 activation (OQ-2).

---

## 5. Requirements *(mandatory)*

### Functional Requirements — Accounts & Payers

- **FR-001**: The model MUST define a **customer / payer account** concept owned by
  Data-Pulse-2, scoped per tenant (and store where applicable), distinguishing the
  **buyer** at the till from the **payer** responsible for settlement.
- **FR-002**: The model MUST define **third-party payer** categories sufficient to
  represent at least **insurer**, **corporate / account customer**, and
  **credit customer** relationships, without hard-coding a single vertical.
- **FR-003**: The model MUST define the relationship between a sale, its buyer, and
  one or more **payers** (including split responsibility, e.g. patient co-pay +
  insurer-covered).
- **FR-004**: Payer accounts MUST carry the attributes needed for settlement intent
  (identity reference, category, credit terms placeholder) **as contract intent**;
  exact field shapes are deferred to the later G2 contract slice.

### Functional Requirements — Receivable Lifecycle

- **FR-005**: The model MUST define a **receivable** representing money owed against a
  specific sale by a specific payer account, with an explicit, finite set of
  lifecycle states (e.g. *open → partially-applied → settled*, plus *claimed*,
  *under-reconciliation*, *flagged*, and terminal states for write-off / reversal-
  consumed) and **deterministic transitions** between them.
- **FR-006**: A receivable MUST be associated to its originating sale **without
  mutating the sale fact** (Constitution §IX/§X; Core Principle, §1).
- **FR-007**: The receivable lifecycle MUST record an **outstanding balance** that
  changes only through defined, audited transitions (capture, cash application,
  remittance reconciliation, reversal-consumed).

### Functional Requirements — Sale Settlement Lifecycle / State Machine

- **FR-008**: The model MUST define a **sale-settlement state** layered over the
  immutable sale (e.g. *unsettled → partially-settled → settled*, with terminal
  *reversal-consumed*), independent of the sale-sync status owned by 032.
- **FR-009**: Settlement state transitions MUST be **commands with explicit
  outcomes** at product-contract level (e.g. *record-settlement-intent*,
  *apply-payment*, *reconcile-remittance*), each producing a defined success / reject
  / no-op outcome.
- **FR-010**: Capturing a sale MUST NOT be blocked by settlement; an unsettled or
  partially-settled sale is a valid, complete sale fact (Core Principle).

### Functional Requirements — Payment Entry / Cash Application

- **FR-011**: The model MUST define **payment-entry / cash-application decision
  points** — when a received payment is applied, against which receivable(s), in what
  order, and how partial application is represented.
- **FR-012**: Cash application MUST be **idempotent and replay-safe** (G5) and MUST
  produce an audit record of each application (G-audit, §7).
- **FR-013**: Payment-entry **ownership** (which system is authoritative for the
  payment-entry record vs ERPNext's) MUST be treated as **OPEN (OQ-7)**; final
  payment-entry field shapes MUST NOT be finalized until OQ-7 is resolved (NG-5).

### Functional Requirements — Claim & Remittance Reconciliation

- **FR-014**: The model MUST define **claim** and **remittance** concepts for
  third-party payers and a **reconciliation** concept that matches remitted amounts
  against claimed receivables, recording variance.
- **FR-015**: Claim rejection / insurance-rejection MUST **route to the existing
  reversal surfaces** (DP-026 + Connector Arc A + POS-014) and MUST NOT define a new
  rejection/reversal workflow (NG-1).

### Functional Requirements — Repo Role Boundaries

- **FR-016**: **POS** MUST capture **settlement intent and payer metadata only**
  (tender split, payer reference, co-pay/covered amounts, claim metadata) — never
  authorize a receivable, apply cash, or post money.
- **FR-017**: **Console** MUST be the surface that **manages payer accounts,
  receivable balances, cash application, and claim/remittance reconciliation**.
- **FR-018**: **Connector** MUST be a **later consumer** that posts approved
  settlement / receivable / claim financial movements to ERPNext; it is never in the
  POS capture or auth path.
- **FR-019**: All settlement / receivable / claim writes MUST be authorized by the
  Data-Pulse-2 backend (Constitution §III), reusing the 028-arc operator-
  authorization envelope (POS) and Console session boundary (humans) — G10, §8.

### Functional Requirements — Idempotency, Audit, Isolation, Tax

- **FR-020**: Every settlement / receivable / cash-application / remittance **write**
  MUST be **idempotent** via an idempotency key and MUST be **replay-safe** (G5;
  Constitution §XI) — duplicate capture, payment, or remittance never double-counts.
- **FR-021**: Every state transition MUST be **auditable** with actor, time, before/
  after state, and reason (Constitution §XIII), and MUST emit **observability**
  signals for settlement/receivable health (G-observability, §7).
- **FR-022**: All accounts, receivables, claims, and remittances MUST be **tenant-
  isolated** (and store-scoped where applicable); cross-tenant access MUST return a
  safe 404 (Constitution §II/§XII).
- **FR-023**: Tax / VAT carriers MUST be **placeholders only** (tax-pending);
  the model MUST NOT compute VAT allocation across payers / co-pays until G6 tax
  activation under ADR-0003 (OQ-2; NG-4).
- **FR-024**: Reversal-compatibility carriers (how a receivable consumes a DP-026
  reversal outcome) MUST be framed conceptually but MUST NOT be finalized until OQ-4
  (DP-026 technical compatibility) is resolved (NG-5).
- **FR-025**: The eventual schema/model impact MUST be identified **conceptually
  only** in planning (G3); this SPECIFY artifact authors **no migration** and no
  schema (NG-3).

### Key Entities *(contract-intent level; field shapes deferred to G2 slice)*

- **Payer Account** — who is responsible for settling a sale balance; category
  (credit customer / corporate / insurer), credit-terms placeholder, tenant scope.
- **Receivable** — money owed against a sale by a payer account; outstanding balance;
  lifecycle state; links to sale and payer; audit trail.
- **Settlement Intent** — captured at the till by POS; tender split, payer reference,
  co-pay vs covered amounts, claim metadata; input that opens receivables.
- **Payment / Cash Application** — a received payment applied (full/partial) against
  one or more receivables; idempotent; audited.
- **Claim** — a receivable (or set) submitted to a third-party payer for collection.
- **Remittance** — amounts paid by a third-party payer against claims; reconciled,
  producing variance.
- **Reconciliation Result** — matched/variance outcome of remittance vs claim;
  feeds settlement state; rejections route to DP-026 reuse.

---

## 6. Tax-Pending Posture (G6 / ADR-0003)

Per **ADR-0003**, tax/fiscal is **activation-only**: the model proceeds **tax-
pending**. Receivables, co-pays, and remittances may carry **tax placeholders**, but
this spec defines **no VAT allocation rules** across payers or co-pay splits, and
makes no Egypt-VAT determination (deferred — **OQ-2**). When G6 tax is activated, a
later separately-gated slice defines allocation; nothing here pre-commits it.

---

## 7. Audit & Observability Expectations

- **Auditability (Constitution §XIII)**: every receivable / settlement / cash-
  application / claim / remittance transition records actor, timestamp, before/after
  state, idempotency key, and reason. Account and balance changes are reconstructable
  from the audit trail.
- **Observability (Constitution §VII)**: the model anticipates settlement/receivable
  health signals (e.g. open-receivable counts/age, cash-application throughput,
  reconciliation variance rate, replay/duplicate-suppression counts). Exact metric
  names are defined in the later contract/implementation slices, not here.

---

## 8. Identity / Access Implications (G10)

- POS settlement-intent capture is authorized by the **028-arc operator-authorization
  envelope** (provider-neutral operator token); device-token-only is insufficient
  for settlement writes (consistent with the 028 boundary).
- Console account/receivable/claim management is authorized by the **Console human
  session boundary** (cookie/session), not a POS or connector credential.
- Connector posting is authorized by the connector boundary (018), out-of-band of the
  POS path.
- Cross-tenant access to any account/receivable returns a **safe 404** (Constitution
  §II/§XII). No new identity provider or scheme is introduced (NG-7).

---

## 9. Conceptual Model / Schema Impact (G3 — conceptual ONLY)

The eventual model is expected to introduce **payer-account**, **receivable**,
**payment-application**, **claim**, and **remittance/reconciliation** concepts, plus
a **settlement-state** projection over the existing sale. **This spec authors no
migration, no table, and no schema.** G3 requires that the model impact be
*identified* conceptually at planning time; it is **not** built here (NG-3, FR-025).
Tax columns, if any, are placeholders only (§6).

---

## 10. Gate Mapping

> Gate letters below are the **settlement work-package's own** gate vocabulary as
> supplied in the dispatch. They are **not** the same as the like-lettered gates in
> 028 or other features; they are defined here for this work package.

| Gate | Meaning (this work package) | Status in this SPECIFY artifact |
|------|------------------------------|---------------------------------|
| **G2** | DP-2 035 **produces the contract** that children consume. | **RATIFIED 2026-06-15 (T012).** Contract `settlement.yaml` authored + merged (PR #574, `cb4a7e5`) and owner-approved — see 035-DR-SETTLEMENT G2 Ratification addendum. The five children are UNBLOCKED. (Non-reversal surface only; reversal carve, connector posting, tax, and DP-2 impl/G3 remain gated.) |
| **G3** | Migration / model impact identified **conceptually only**; no migrations written. | **Addressed at SPECIFY level**: model impact framed in §9; no migration authored (NG-3, FR-025). |
| **G5** | Idempotency / replay safety specified. | **Addressed at SPECIFY level**: FR-012, FR-020; replay acceptance scenarios in §4. |
| **G6** | Tax/fiscal is **activation-only** under ADR-0003; proceed **tax-pending**. | **Addressed at SPECIFY level**: §6, FR-023, NG-4; no VAT rules invented; OQ-2 deferred. |
| **G10** | Identity / access implications specified. | **Addressed at SPECIFY level**: §8, FR-019; reuses 028-arc envelope + Console session; safe-404 isolation. |

---

## 11. Open Questions

> **RESOLVED 2026-06-15** by signed owner ruling — see
> [`decisions/settlement-receivables-decision-record.md`](./decisions/settlement-receivables-decision-record.md)
> (035-DR-SETTLEMENT). The non-reversal G2 contract draft may proceed; reversal-
> compatibility fields remain genuinely deferred (see OQ-4 below). Resolution does
> **not** flip gate G2 and does **not** lift the connector posting gate.

- **OQ-2 — Egypt VAT allocation → RESOLVED: tax-deactivated v1.** Proceed tax-pending
  under G6 / ADR-0003: **no** VAT allocation, fiscal-receipt behavior, co-pay VAT
  split, or tax activation in v1. Tax carriers stay **placeholders only** (NG-4, §6).
  **G6 reopens later** with real users + SME review. (035-DR-SETTLEMENT §OQ-2.)
- **OQ-4 — DP-026 returns/reversal technical compatibility → RESOLVED: CARVE
  (sequencing, NOT a compat answer).** The **non-reversal happy path**
  (open/apply/settle/claim/remittance/reconciliation) proceeds in the G2 contract
  now. **Reversal-compatibility fields (FR-024) remain BLOCKED pending DP-026's
  close** and land as a later additive contract bump; **no parallel reversal model**
  — void/refund/insurance-rejection reuse DP-026 + Connector Arc A + POS-014 (NG-1).
  (035-DR-SETTLEMENT §OQ-4.)
- **OQ-7 — Payment Entry ownership → RESOLVED: 7-C.** DP-2 owns the operational
  receivable + cash-application truth; ERPNext owns the accounting Payment Entry as a
  reconciled valuation projection referenced by external refs; POS/Console never call
  ERPNext directly (connector is the only adapter). This shapes 035 *fields* but does
  **not** authorize connector posting — ERPNext Payment-Entry posting stays gated
  behind 011-DR-POSTING-R1. (035-DR-SETTLEMENT §OQ-7.)

---

## 12. Dependency Mapping & Downstream Consumer Notes

### Upstream / sibling dependencies (this spec relies on)

- **008** (sale capture) and **032** (sale sync-status + idempotency) — the immutable
  sale fact + sync layer this settlement model sits over. **Console 019**
  (reconciliation) additionally needs **DP-2 032 runtime wiring**.
- **028 arc** (029 identity link / 030 auth cleanup / 031 operator-authorization
  envelope) — the provider-neutral authorization the POS settlement path reuses (G10).
- **026** (returns/reversal contract), **Connector Arc A** (forward-feed reversal
  posting), **POS-014** (POS return flow) — the reuse anchors for reversal /
  rejection (NG-1, FR-015, FR-024).
- **018** (connector boundary) — the connector authorization boundary the later
  posting consumer (Connector 009) sits behind.
- **ADR-0003** — tax activation-only posture (G6, §6).

### Downstream consumers (BLOCKED until DP-2 035 G2 contract approved)

> Consumer notes only — **no child spec is authored here** (NG-2).

- **POS 020 — pos-credit-and-third-party-tender-flow**: consumes the settlement-
  intent / payer-metadata contract; captures intent only (FR-016).
- **Console 017 — customer-and-payer-accounts**: consumes the payer-account model
  (FR-001..FR-004, FR-017).
- **Console 018 — receivables-and-insurance-claims**: consumes receivable lifecycle +
  claim/remittance concepts (FR-005..FR-007, FR-014, FR-017).
- **Connector 009 — receivables-and-third-party-posting-adapter**: consumes approved
  posting commands; later consumer (FR-018).
- **Console 019 — settlement-reconciliation** (LAST): consumes reconciliation
  concepts; **also needs DP-2 032 runtime wiring** before it can run end-to-end.

---

## 13. Claim Ceiling / Status Honesty

- This is a **SPECIFY-only** artifact. It defines **contract intent and the target
  model**. It produces **no** code, OpenAPI, migration, or child spec.
- **It does NOT mark G2 satisfied or approved.** "DP-2 035 produces the G2 contract"
  is the *work package's eventual output* — the OpenAPI contract and the owner's
  both-sides G2 approval are **later, separately-gated** DP-2 work (mirrors 026's
  posture: this spec frames intent; it does not certify the contract).
- Reversal-compatibility (OQ-4) and payment-entry (OQ-7) field families are **not
  finalized**; VAT allocation (OQ-2) is **deferred**. Any reader treating those as
  settled is reading more than this artifact claims.
- No claim of end-to-end settlement is made; nothing here has been built or run.

---

## 14. Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reviewer can trace each of the 15 dispatch scope items (customer/payer
  accounts; third-party/insurer/corporate; receivable lifecycle; settlement
  lifecycle; settlement commands/outcomes; payment-entry/cash-application; claim/
  remittance reconciliation; POS role; Console role; Connector role; idempotency/
  replay; audit/observability; tenant/store isolation; tax-pending; non-goals/parked)
  to an explicit section or requirement in this spec — **100% coverage**.
- **SC-002**: All five downstream children (POS 020, Console 017/018/019, Connector
  009) have an explicit consumer note and a stated blocking dependency on the G2
  contract — **5/5**.
- **SC-003**: All five work-package gates (G2/G3/G5/G6/G10) are mapped with a status,
  and all three open questions (OQ-2/OQ-4/OQ-7) are captured with blocking semantics —
  **5/5 gates, 3/3 OQs**.
- **SC-004**: The reversal non-goal is unambiguous — a reviewer can confirm in under
  2 minutes that no competing reversal/refund/rejection workflow is defined and that
  DP-026 + Connector Arc A + POS-014 are named as the reuse anchors.
- **SC-005**: A reviewer can confirm the spec invents **zero** VAT allocation rules
  and authors **zero** OpenAPI/migration/code, consistent with the SPECIFY-only claim
  ceiling (§13).

---

## 15. Assumptions

- The immutable sale fact (008/032) and the 028-arc authorization envelope exist and
  are reused; this spec does not redefine them.
- DP-026 + Connector Arc A + POS-014 are the canonical reversal/return/rejection
  surfaces and remain so; settlement consumes their outcomes (pending OQ-4
  technical-compatibility confirmation).
- ERPNext stays valuation / back-office; DP-2 owns operational settlement state
  (Constitution §I/§III/§IX).
- Tax remains deactivated (tax-pending) until G6 activation under ADR-0003.
- Exact contract field shapes, metric names, and table designs are intentionally left
  to the later G2 contract slice and the plan phase; this spec is product/contract
  intent only.
