# Implementation Plan: Sale Settlement & Receivables Model

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

**Branch**: `main` (working-tree only; uncommitted) | **Date**: 2026-06-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/035-sale-settlement-and-receivables-model/spec.md`

> **Plan posture — GATED, INTENT-ONLY (read first).**
> This is a **design-approach** plan, not a build-ready implementation plan. It
> documents the design intent, dependency order, conceptual model placement, and
> the Constitution Check. It **deliberately does NOT** generate `data-model.md`,
> `contracts/`, `quickstart.md`, or `tasks.md`, and authors **no** OpenAPI YAML and
> **no** migrations. Those artifacts encode the exact field/contract/schema
> decisions the spec defers to **OQ-4** (DP-026 reversal compat), **OQ-7** (Payment
> Entry ownership), and the **G2** contract gate (see spec §11, §13). Producing them
> now would contradict the spec's claim ceiling. They are unblocked only after those
> open questions resolve and a separately-gated contract slice is approved.

## Summary

DP-2 035 is the **parent producer** of the Retail Tower settlement work package. The
primary requirement is to define the settlement-and-receivables **model** (payer
accounts, receivable lifecycle, sale-settlement state machine, payment/cash
application, claim/remittance reconciliation) that POS 020, Console 017/018/019, and
Connector 009 later consume via DP-2's pinned OpenAPI contract.

**Design approach (this plan):** establish the conceptual model and module placement
inside the existing DP-2 backend, layered **over** the immutable sale fact (008/032)
and authorized by the 028-arc operator envelope + Console session boundary — **without**
committing to field shapes, table designs, OpenAPI surfaces, or migrations. The
heavy design artifacts are sequenced behind the open-question gates so the eventual
G2 contract is authored once, against resolved decisions, rather than churned.

## Technical Context

> Values are the **known** DP-2 stack context for *eventual* implementation; items
> the spec defers are marked **DEFERRED (gated)** rather than `NEEDS CLARIFICATION`,
> because they are intentional deferrals with explicit blocking semantics (spec §11),
> not unresolved ambiguities. There are **no** `NEEDS CLARIFICATION` markers.

**Language/Version**: TypeScript 5.x strict · Node.js 20 LTS (per repo stack)

**Primary Dependencies**: NestJS 11 (api + worker), Drizzle ORM, Zod (runtime
validation), BullMQ/Redis (async) — *for the eventual implementation slices, not this plan*

**Storage**: PostgreSQL 16+ with RLS. **New tables/columns: DEFERRED (gated)** — model
impact is conceptual only here (G3; spec §9). No migration authored.

**Testing**: Jest + Supertest + Testcontainers (per repo) — *applies to later slices*

**Target Platform**: Linux server (multi-tenant SaaS backend)

**Project Type**: web-service (backend / source-of-truth); dashboard + POS + connector
are separate repos consuming the contract

**Performance Goals**: domain-standard backend targets; **specific SLOs DEFERRED** to the
implementation slice (no settlement-specific perf claim is made by this plan)

**Constraints**: tenant/store isolation (RLS), idempotent + replay-safe writes,
immutable sale fact, tax-pending (G6/ADR-0003), reversal-reuse (no competing model)

**Scale/Scope**: parent contract producer for a 5-repo work package; this plan covers
the DP-2-side conceptual model only

### Deferred decisions (gated — NOT resolved by this plan)

| Deferred item | Gate / OQ | Why deferred here |
|---------------|-----------|-------------------|
| OpenAPI contract surface (payer/receivable/settlement/claim) | **G2** | Contract is the producer's *eventual* output, approved by owner both-sides sign-off — not authored at plan time (spec §13). |
| Reversal-compatibility field shapes (receivable consuming a DP-026 reversal) | **OQ-4** | DP-026 technical compatibility must be confirmed before finalizing (spec FR-024, NG-5). |
| Payment-entry / cash-application field shapes + ownership | **OQ-7** | Payment Entry ownership (DP-2 vs ERPNext) must be confirmed before finalizing (spec FR-013, NG-5). |
| VAT/tax allocation across payers / co-pays | **OQ-2 / G6** | Tax activation-only under ADR-0003; no allocation rules invented (spec §6, NG-4). |
| Concrete table names, columns, migration files | **G3** | Conceptual model impact only; no schema/migration at SPECIFY/plan (spec §9, FR-025, NG-3). |

## Constitution Check

*GATE: must pass before any later implementation slice. Re-checked post-design below.*

> The constitution's auto-stub for Principles IX–XIV is a recorded-but-unimplemented
> TODO (constitution memory ~line 160), so IX–XIV are checked **manually** here — they
> are the load-bearing principles for a money/receivables feature.

| Principle | Relevance to 035 | Plan posture |
|-----------|------------------|--------------|
| **I. Reference, not source of truth** | ERPNext stays valuation/back-office; DP-2 owns settlement state | PASS — NG-6; settlement authority is DP-2 (spec §1, §3). |
| **II. Multi-tenant by default** | accounts/receivables/claims are tenant data | PASS — FR-022; cross-tenant ⇒ safe 404 (spec §8). |
| **III. Backend authority** | all settlement/receivable writes authorized server-side | PASS — FR-019; POS captures intent only (FR-016). |
| **IV. Contract-first POS integration** | POS/Console/Connector consume a pinned contract | PASS-by-design — the contract is the G2 deferral; this plan does not author it but sequences it correctly. |
| **VII. Observable systems** | settlement/receivable health signals | PASS (intent) — §7; metric names DEFERRED to impl slice. |
| **VIII. Reproducible releases** | any later migration/contract is `[GATED]` | PASS-by-design — no migration/contract authored; later slices carry `[GATED]`. |
| **IX. Source-of-truth model** | settlement layered over immutable sale | PASS — FR-006, FR-008; sale fact never rewritten. |
| **X. Retail temporal semantics** | receivable references the sale's captured facts | PASS — receivable links to sale without mutating past lines (spec §4, FR-006). |
| **XI. Idempotency & external IDs** | capture/payment/remittance writes | PASS — FR-012, FR-020; replay-safe scenarios (spec §4). |
| **XII. Authorization & object safety** | account/receivable lookups | PASS — FR-022; safe-404 cross-tenant (spec §8). |
| **XIII. Auditability & provenance** | every state transition audited | PASS — FR-021; actor/time/before-after/reason (spec §7). |
| **XIV. PII & data lifecycle** | payer accounts may carry PII (customer/insurer) | PASS-with-followup — payer identity is PII; data classification + retention is a constitution TODO and must be honored when payer-account fields are finalized (tie to OQ-7/G2 slice). |

**Result: no unjustified violations.** The only "incomplete" items are intentional,
gated deferrals (G2/G3/OQ-2/OQ-4/OQ-7), not constitution breaches. **No Complexity
Tracking entries required.**

## Project Structure

### Documentation (this feature)

```text
specs/035-sale-settlement-and-receivables-model/
├── spec.md              # SPECIFY output (authored)
├── plan.md              # THIS file — gated intent-only plan
├── research.md          # SKIPPED (gated) — no NEEDS CLARIFICATION; OQ-2/4/7 deferred-by-design
├── data-model.md        # SKIPPED (gated) — field/entity shapes deferred to OQ-4/OQ-7/G2
├── contracts/           # SKIPPED (gated) — OpenAPI surface is the G2 deferral
├── quickstart.md        # SKIPPED (gated) — no runnable surface to demo yet
└── tasks.md             # NOT created (separate /speckit-tasks step; out of scope)
```

> Skips above are **intentional and gated**, not omissions. Each maps to a deferral in
> the spec's Open Questions (§11) / Gate Mapping (§10). Absence of `contracts/` is the
> correct state for a producer spec whose contract is not yet G2-approved.

### Source Code (repository root) — conceptual placement ONLY

> Conceptual module placement to orient later slices. **No concrete file names, table
> names, column shapes, or migration paths are committed** — that is the OQ-4/OQ-7/G2
> line between "design approach" (in scope) and "pre-committing gated decisions"
> (forbidden).

```text
apps/api/                      # NestJS api — would host settlement/receivable modules
  └── (settlement & receivables feature modules)   # placement TBD at impl slice
apps/worker/                   # async reconciliation / cash-application processing
packages/contracts/openapi/    # G2 contract lands HERE later — NOT authored now
packages/db/                   # migrations land HERE later (G3) — NOT authored now
```

**Structure Decision**: Settlement & receivables are **new backend feature modules**
inside the existing `apps/api` (with async reconciliation work in `apps/worker`),
consuming the existing sale (008/032) and 028-arc auth surfaces. The contract
(`packages/contracts/openapi`) and schema (`packages/db`) extensions are **gated** and
authored in later slices, not here. No new repo, app, or top-level structure is
introduced.

## Dependency Order (design sequencing)

> The order later implementation slices must follow; this plan defines the sequence,
> not the slices themselves.

1. **Resolve gates** — OQ-7 (Payment Entry ownership) and OQ-4 (DP-026 reversal compat)
   confirmed; G6 tax remains pending (no VAT work).
2. **G2 contract slice** `[GATED]` — author the OpenAPI surface (payer account,
   receivable, settlement command/outcome, claim/remittance) once OQ-4/OQ-7 resolved.
   This is the gate that unblocks all five children.
3. **G3 schema slice** `[GATED]` — payer-account / receivable / payment-application /
   claim / remittance tables + RLS + idempotency keys + audit, identified conceptually
   in spec §9, authored here.
4. **Service + worker slices** — settlement state machine, cash application,
   reconciliation; idempotent/replay-safe; authorized per §8.
5. **Children consume** (separate repos) — POS 020, Console 017/018, Connector 009;
   **Console 019 last** (also needs **DP-2 032 runtime wiring**).

## Phase Status (this command)

- **Phase 0 (research.md)**: **SKIPPED (gated).** No `NEEDS CLARIFICATION` to resolve;
  the three open questions (OQ-2/OQ-4/OQ-7) are deferrals with blocking semantics, not
  research gaps. Re-running with research would not resolve them — they are owner/cross-
  system decisions, not investigable unknowns.
- **Phase 1 (data-model.md / contracts/ / quickstart.md)**: **SKIPPED (gated).** These
  encode the field/contract decisions deferred to OQ-4/OQ-7/G2.
- **Phase 1 step 3 (agent context / CLAUDE.md update)**: **N/A.** Root `CLAUDE.md` has no
  `<!-- SPECKIT START/END -->` markers; nothing to update and none added.
- **Phase 2 (tasks.md)**: not part of `/speckit-plan`; not created.

## Claim Ceiling / Status Honesty (carried from spec §13)

- This plan defines a **design approach**; it builds and certifies nothing.
- It does **not** mark **G2** satisfied/approved — the contract is later, separately-
  gated work.
- `data-model.md`, `contracts/`, `quickstart.md`, `research.md` are **intentionally
  absent (gated)**, not unfinished.
- No OpenAPI, migration, code, or child spec is authored. Uncommitted; for review.
