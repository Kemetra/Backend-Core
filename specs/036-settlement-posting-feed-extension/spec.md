# Feature Specification: DP-012 Posting-Feed Settlement Extension

> **SUPERSEDED (RT-415, recorded 2026-10-12). Do not implement this spec.** RT-78 settles the sale on the
> ERPNext Sales Invoice itself, with immediate tenders as SI `payments` rows and **no separate Payment Entry**,
> so the settlement Payment-Entry work-item kind this spec proposes is no longer needed. A/R allocation, cash
> application and later collections are **ERPNext-native** per [RT-413](https://rahmaqanater.atlassian.net/browse/RT-413)
> (035 narrowed to Option B; 035-DR-SETTLEMENT OQ-7 superseded by Amendment A1). The text below, `plan.md` and
> `tasks.md` are kept unchanged as historical record; the tasks remain unchecked and are not to be executed.

**Feature Branch**: `036-settlement-posting-feed-extension`

**Created**: 2026-06-17

**Status**: Draft

**Input**: User description: "DP-012 posting-feed settlement extension: a versioned, backward-compatible work-item kind so the connector can post settlement Payment Entries, consuming the 035 settlement model"

> **Boundary note (read first).** This spec is authored under the Retail Tower Orchestrator decision **AD-SALE-SETTLEMENT-3 (RATIFIED Option A, 2026-06-17)**, which authorizes **the spec only — not the OpenAPI contract surface and not implementation.** Accordingly this document states *requirements* for the extension (what data the new work-item must carry, what invariants hold, what gates apply) and deliberately **does NOT** author the `posting-feed.yaml` schema, the new enum value's YAML, or any DTO/migration/runtime. Producing the actual contract surface is a separate, gated step requiring its own owner approval. There is intentionally **no `g2-contract-draft.md`** in this feature.

---

## Context & Dependencies

This feature **extends** the existing, shipped **DP-012 posting-feed contract** (`packages/contracts/openapi/erpnext-connector/posting-feed.yaml`) — it does not replace it and does not fork a new transport. Background, verified against `origin/main` @ `cb44d4f` (2026-06-17):

- The current `PostingWorkItem.kind` enum is **`[sale_post, reversal]`** only (`posting-feed.yaml:335`). There is no settlement / Payment-Entry / receivable-payment work-item.
- The 012 contract already **anticipates** this extension. Its Payment-Entry deferral note (`posting-feed.yaml:46-52`) states the Payment Entry is deferred under gate A.5 (008 has no tender) *"until a DP2 payments model lands, at which point the work-item payload + this contract gain the tender fields (a versioned, backward-compatible extension)."* This feature is that named extension — now that the **035 settlement model** has landed as the candidate payments model.
- **035 settlement runtime** is merged on `origin/main` (`apps/api/src/settlement/` controller+services, `SettlementModule` @ `app.module.ts:222`, migration `0027`). It owns the receivable/settlement state and the `consoleApplyPayment` decision — the business event whose *approved* outcome this extension carries to the connector for ERPNext posting.
- **011-DR-POSTING-R1** is a **SIGNED** rider gating Payment-Entry posting behind **four** prerequisites; this extension **is gate #2** of that list. R1 remains **UNLIFTED** — see "Gating & Out-of-Scope".

**This feature is a prerequisite for, not a part of, Connector-009.** Connector-009 (separate repo) consumes the extended feed once this lands AND R1 is lifted. This spec produces no connector code.

---

## User Scenarios & Testing *(mandatory)*

> "Users" here are **machine consumers** (the connector) and the **DP-2 projection logic**, plus the human operator whose `consoleApplyPayment` initiates the chain. The feed is a machine contract; "testing independently" means contract-conformance + projection tests, not a UI flow.

### User Story 1 - Connector pulls a settlement Payment-Entry work-item (Priority: P1)

After an operator's settlement payment is **approved** in the 035 model, DP-2 must be able to offer the connector a posting work-item that represents *"post the settlement Payment Entry for this receivable,"* distinct from the existing sale post. The connector pulls it through the **same** `connectorPullPostings` feed it already uses, recognizes the new kind, and (in a later, R1-gated step) posts the corresponding ERPNext Payment Entry.

**Why this priority**: This is the entire point of the extension — without a settlement work-item the connector has no contract-legal way to be told "post this payment." It is gate #2 of R1.

**Independent Test**: A conformance test asserts the feed can emit a settlement work-item carrying the required settlement fields, and that an existing-kind (`sale_post`/`reversal`) consumer that ignores the new kind is unaffected (backward compatibility). No ERPNext, no connector code required.

**Acceptance Scenarios**:

1. **Given** an approved 035 settlement payment with an associated receivable, **When** the work-item projection runs, **Then** a settlement work-item is offered on the feed carrying {payer/debtor reference, settlement amount + currency, business date, the originating-sale / receivable provenance, the ERP Sales-Invoice reference it pays against, an idempotency anchor}.
2. **Given** a connector built only against the pre-extension contract, **When** it pulls a feed page containing a settlement work-item, **Then** its handling of `sale_post`/`reversal` items is unchanged and it is not required to understand the new kind (additive, backward-compatible).
3. **Given** the same approved settlement is projected twice, **When** the connector pulls, **Then** the idempotency anchor identifies it as the same posting (exactly-one Payment Entry per settlement — the connector-side guarantee, R1 gate #3, enforced downstream).

---

### User Story 2 - Settlement work-item is fail-closed and self-sufficient (Priority: P2)

A settlement work-item that cannot be fully resolved at projection time (e.g. the ERP Sales-Invoice reference it must pay against is not yet posted/known, or the payer/debtor cannot be resolved) must **fail-to-DLQ in DP-2 before being offered** to the connector — mirroring the R2 discipline already established for sale posts (*"a sale line that cannot resolve… fails-to-DLQ in DP2 before being offered"*). The connector never guesses settlement identity and never reaches back into DP-2.

**Why this priority**: Preserves the §IX boundary + AD-1 §D6 ("connector posts only approved commands, owns no business decision"). A half-resolved settlement posting is a finance defect.

**Independent Test**: Projection test — an approved settlement whose target invoice reference is absent produces a DLQ entry, not a feed work-item.

**Acceptance Scenarios**:

1. **Given** an approved settlement whose ERP Sales-Invoice target is not resolvable, **When** projection runs, **Then** the item fails-to-DLQ and is NOT offered on the feed.
2. **Given** a settlement work-item on the feed, **When** the connector inspects it, **Then** it contains every field needed to post the Payment Entry without a second DP-2 call (self-sufficiency, mirroring O-1).

---

### User Story 3 - Versioned, backward-compatible evolution (Priority: P3)

The extension must be introduced as a **versioned, additive** change so existing 012 consumers continue to work unmodified, per the contract's own deferral promise and R1's wording ("versioned, backward-compatible").

**Why this priority**: A breaking change to a shipped, pilot-relied-upon feed is a stop-condition. Additivity is the contract's stated evolution model.

**Independent Test**: Contract-version + conformance test asserting old consumers pass against the new contract.

**Acceptance Scenarios**:

1. **Given** the extended contract, **When** the conformance suite runs the pre-extension consumer expectations, **Then** they all still pass.

---

### Edge Cases

- **Partial settlement**: 035 supports `partially_settled`. Each approved partial payment is its own settlement event → its own work-item with its own idempotency anchor. The spec must define whether N partial payments produce N Payment-Entry work-items (expected) and how each correlates to the same receivable/invoice.
- **Settlement before its sale is posted**: if a receivable's underlying Sales Invoice is not yet posted to ERPNext, the settlement work-item has no invoice to pay against → fail-to-DLQ (US2), retried when the invoice exists.
- **Reversal of a settled payment** (refund of a third-party/insurer payment): out of scope here — reversals reuse DP-026 + Connector Arc A (NG-1 in the 035 contract); this extension adds no reversal/void path.
- **Currency / rounding** of the settlement amount vs the invoice outstanding: the work-item carries the settlement amount as the operational truth (7-C); ERPNext `outstanding_amount` is read for reconciliation, never overwritten (AD-1 §D7).
- **Tax/VAT on settlement**: 035 is TAX-PENDING (035-DR-SETTLEMENT §OQ-2; no VAT allocation across payers). The settlement work-item carries no VAT allocation; G6 stays deferred (ADR-0003).

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The DP-012 posting-feed MUST gain a **new, additive `PostingWorkItem` kind** representing an approved settlement Payment-Entry posting, distinct from `sale_post` and `reversal`. *(Requirement only — the enum value's name and YAML are NOT authored here; that is the gated contract step.)*
- **FR-002**: A settlement work-item MUST carry every field the connector needs to post the ERPNext Payment Entry **without reaching back into DP-2** (self-sufficiency, O-1): at minimum the payer/debtor reference, the settlement amount + currency, the business date, the originating receivable/sale provenance, the ERP Sales-Invoice reference being paid, and an idempotency anchor.
- **FR-003**: The extension MUST be **versioned and backward-compatible** — existing `sale_post`/`reversal` consumers MUST continue to function unmodified.
- **FR-004**: Settlement work-items MUST be **projected only from 035 settlement events whose state is approved/settled** (never from a `captured`/unapproved receivable), per AD-1 §D8 ("ERP posting only after the required gate and approval state").
- **FR-005**: A settlement work-item that cannot be fully resolved at projection time MUST **fail-to-DLQ in DP-2 before being offered** to the connector (no half-resolved postings; mirrors R2).
- **FR-006**: The work-item MUST be **idempotent at the wire** — re-projection of the same settlement event MUST be identifiable as the same posting so the connector creates exactly one Payment Entry (R1 gate #3 is the connector-side enforcement; this contract MUST supply the anchor).
- **FR-007**: The settlement work-item MUST carry **no credentials and no `tenant_id`** (implicit in the authenticated connector scope), consistent with the existing work-item posture.
- **FR-008**: The extension MUST NOT add any reversal/void/refund/insurance-rejection operation — those reuse DP-026 + Connector Arc A + POS-014 (NG-1).
- **FR-009 [R1 gate #1 scoping]**: This feature MUST record whether the **035 settlement model satisfies R1 gate #1** ("a DP2 tender/payment fact model") *as written*, OR identify the residual gap. R1 was authored in the at-sale (015) context; 035 is the *settlement-side* payments model. **This is a scoping requirement, not a lift** — the determination feeds the owner's R1-lift decision; it does not itself lift R1. [NEEDS CLARIFICATION: owner to confirm 035's fitness as the R1 gate-#1 model, or name the residual.]
- **FR-010 [R1 gate #4 scoping]**: This feature MUST scope the **payment repair/reconciliation semantics** (R1 gate #4 — "the 017 boundary extended to cover payment outcomes"): what happens when a settlement Payment-Entry posting fails, how it is re-driven, and how it reconciles against ERPNext. The scope MAY be deferred to a dedicated follow-up feature, but MUST be named here as a known R1-lift prerequisite. [NEEDS CLARIFICATION: own here vs. dedicated 017-extension feature.]
- **FR-011**: This feature MUST NOT lift or amend **011-DR-POSTING-R1**, MUST NOT author the `posting-feed.yaml` schema, and MUST NOT produce any DTO, migration, or runtime. Those are separate, gated, separately-approved steps.

### Key Entities *(include if feature involves data)*

- **Settlement work-item**: the new feed item representing an approved settlement Payment-Entry to post. Relates a 035 settlement/receivable to the ERPNext Sales Invoice it pays. *(Attributes described at requirement level in FR-002; schema not authored here.)*
- **035 settlement / receivable** *(existing, DP-2-owned)*: the upstream business state; the approved settlement event is the projection trigger.
- **ERP Sales-Invoice reference** *(existing)*: the document the Payment Entry settles; read for correlation, never overwritten (AD-1 §D7).
- **Idempotency anchor** *(existing posture, new application)*: the wire dedup key guaranteeing exactly-one Payment Entry per settlement.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A connector built only against the pre-extension 012 contract passes 100% of its existing conformance expectations against the extended contract (backward compatibility proven, not asserted).
- **SC-002**: For every approved 035 settlement event with a resolvable invoice target, exactly one settlement work-item is offered on the feed; for every unresolvable one, exactly one DLQ entry and zero feed items.
- **SC-003**: Re-projecting the same settlement event N times yields work-items that the idempotency anchor collapses to one logical posting (zero duplicate Payment Entries downstream).
- **SC-004**: The R1 four-gate status is unambiguously recorded — gate #2 (this extension) moves from "absent" to "spec'd"; gates #1, #3, #4 each have a named owner + status — so the owner can make the R1-lift decision from a complete picture.

## Gating & Out-of-Scope

- **011-DR-POSTING-R1 stays SIGNED and UNLIFTED.** This feature satisfies (specs) gate #2 of R1; it does not lift R1. Lifting requires a separate owner-signed rider amendment confirming all four gates (AD-SALE-SETTLEMENT-3).
- **No OpenAPI authored.** The `posting-feed.yaml` schema for the new kind is a separate gated step (FR-011).
- **No implementation.** No DTO, migration, projection runtime, or test code — spec/plan/tasks only; stop before `implement`.
- **Connector-009 out of scope** (separate repo; downstream consumer; blocked until this merges + R1 lifts).
- **Reversals/refunds out of scope** (NG-1; reuse DP-026 + Arc A).
- **At-sale Payment Entry (gate A.5) out of scope** — separately deferred; this is the settlement-side Payment Entry only.

## Assumptions

- **035 settlement is the candidate payments model** for the settlement-side Payment Entry (subject to FR-009 owner confirmation). The at-sale "+ Payment Entry" (gate A.5) remains separately deferred and is out of scope here.
- The **transport is the existing 012 pull/feed** (`connectorPullPostings` + `connectorAckOutcome`, `connectorBearer` machine auth, `/api/connector/v1/erpnext` namespace) — no new transport, consistent with 023's "reuse 012 vocabulary" precedent.
- **Connector-009 is the downstream consumer** and is out of scope (separate repo, blocked until this merges + R1 lifts).
- The actual `posting-feed.yaml` schema authoring is a **separate gated step** — this feature stops at spec/plan/tasks.
