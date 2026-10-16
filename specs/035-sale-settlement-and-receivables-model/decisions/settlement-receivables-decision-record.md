# Decision Record: Sale Settlement & Receivables Model

**Decision ID**: 035-DR-SETTLEMENT
**Feature**: 035-sale-settlement-and-receivables-model
**Status**: **SIGNED**
**Gates**: unblocks `tasks.md` T001 (OQ-4), T002 (OQ-7), T003 (OQ-2/G6); enables the
G2 **contract draft** (T010a). Does **not** flip gate **G2** (still needs the
authored OpenAPI contract + owner both-sides approval), and does **not** lift
011-DR-POSTING-R1's ERPNext posting gate.
**Owner / signer**: Ahmed Shaaban
**Created**: 2026-06-15
**Signed**: 2026-06-15

> **SIGNED.** The three carried open questions in [`spec.md`](../spec.md) §11
> (OQ-2, OQ-4, OQ-7) are resolved as below, per the owner ruling. The G2 contract
> **draft** may proceed consistent with this decision. Any deviation is a
> STOP-and-raise condition, not a silent override. This record does **not** authorize
> code, OpenAPI YAML, migrations, or connector posting activation — it resolves the
> field/sequence questions that were blocking the contract draft.

---

## OQ-7 — Payment Entry ownership → **7-C (SIGNED)**

> **SUPERSEDED 2026-10-12** by Amendment A1 (end of this record). The 7-C text below is kept
> unchanged as historical record.

**Question:** Which system is authoritative for the payment-entry record — DP-2,
ERPNext (via connector), or split?

**Decision: 7-C — operational/accounting split.**

- **DP-2 owns the operational receivable and cash-application truth.** Cash
  application (full/partial), receivable balance, settlement state, and reconciliation
  outcomes are authoritative in Data-Pulse-2.
- **ERPNext owns the accounting Payment Entry** as a **valuation / accounting
  projection**, reconciled back to DP-2 by **external references** (not by ERPNext
  becoming the operational source of truth).
- **POS and Console MUST NOT call ERPNext directly.** The **Connector remains the
  only ERPNext/Frappe adapter.** (Constitution §I trust boundary; spec §8.)

**Load-bearing caveats (carry verbatim):**
- This decision **shapes DP-2 035 fields**, but **does NOT by itself authorize
  Connector posting activation**. Connector posting of the ERPNext Payment Entry
  stays gated behind **011-DR-POSTING-R1** (which deferred Payment Entry and does not
  ratify deriving it). OQ-7 finalizes 035 *fields*; R1 still gates ERPNext *posting*.

**Consistency basis:** aligns with 011-DR-POSTING's signed target ("Sales Invoice +
associated Payment Entry" in ERPNext) **and** Constitution §I/§IX (DP-2 = operational
truth, ERPNext = valuation).

---

## OQ-4 — DP-026 reversal technical compatibility → **CARVE (SIGNED)**

**Question:** May the 035 G2 contract proceed before DP-026's reversal determination
closes?

**Decision: CARVE — author the non-reversal happy-path now; defer reversal fields.**

- Author the DP-2 035 G2 contract **now** for the **non-reversal happy path**:
  **open / apply / settle / claim / remittance / reconciliation**.
- **Do NOT block the entire 035 contract on DP-026.**
- **Defer reversal-specific fields** (FR-024 reversal-compatibility carriers) to a
  **later additive contract bump after DP-026 closes.**
- **Do NOT create a parallel reversal model.** Void / refund / insurance-rejection
  paths **MUST reuse DP-026 + Connector Arc A + POS-014** (spec NG-1).

> **Precise framing (do not misread):** This is a **sequencing** decision, **not** a
> technical-compatibility answer. Reversal-compatibility (FR-024) remains **genuinely
> blocked pending DP-026's close**. "OQ-4 resolved" means *the non-reversal surface
> may proceed*; it does **not** mean reversal compat is now defined.

**Follow-on flag:** the receivable-correlation need adds weight to resolving the
DP-026 §3.x sale-`externalId` vs per-reversal-`source_ref_id` anchor mismatch —
surface on DP-026's CHECKPOINT-2 (informational; not a 035 task).

---

## OQ-2 — Egypt VAT allocation → **TAX-DEACTIVATED v1 (SIGNED)**

**Question:** How does VAT apportion across payers / co-pays?

**Decision: proceed tax-pending; tax-deactivated for v1.**

- **Do NOT invent VAT allocation rules.** No Egypt VAT allocation, no fiscal-receipt
  behavior, no co-pay VAT split, no tax activation in this v1.
- Tax carriers remain **placeholders only** (spec FR-023, NG-4).
- **G6 remains activation / rollout-only under ADR-0003** and **must be reopened
  later** with real users + SME review.

---

## What this record unblocks vs what stays gated

| Item | State after this record |
|------|-------------------------|
| `tasks.md` T001 (OQ-4) | **RESOLVED — CARVE** (non-reversal proceeds; reversal fields stay blocked on DP-026) |
| `tasks.md` T002 (OQ-7) | ~~**RESOLVED — 7-C**~~ **SUPERSEDED 2026-10-12** — see Amendment A1 below (RT-415) |
| `tasks.md` T003 (OQ-2/G6) | **RESOLVED — tax-deactivated v1** |
| G2 contract **draft** (design input, markdown) | **AUTHORABLE NOW** (T010a) |
| G2 contract **OpenAPI YAML** (`packages/contracts/openapi/**`) | **AUTHORED + MERGED** (T010b) — `settlement.yaml` on main (PR #574, `cb4a7e5`) |
| Gate **G2** | **RATIFIED 2026-06-15** — see the G2 Ratification addendum below (T012) |
| Connector ERPNext Payment-Entry posting | **STILL GATED** behind 011-DR-POSTING-R1 |
| G3 schema / migration | **STILL GATED** — conceptual only |

---

## G2 Ratification (T012) — **SIGNED 2026-06-15**

**Owner / signer:** Ahmed Shaaban. **Decision:** the authored G2 contract
`packages/contracts/openapi/settlement/settlement.yaml` (merged to main via PR #574,
`cb4a7e5`) is **APPROVED**. Gate **G2 is RATIFIED.**

This is the both-sides owner approval the contract draft (§13 claim ceiling) was
waiting on. The contract is no longer a pre-approval `1.0.0-draft` design input — it
is the **approved settlement contract of record** the downstream children consume.

**What G2 ratification unblocks:** the five children may now consume the contract and
proceed through their own spec chains —
- **POS 020** — pos-credit-and-third-party-tender-flow
- **Console 017** — customer-and-payer-accounts
- **Console 018** — receivables-and-insurance-claims
- **Connector 009** — receivables-and-third-party-posting-adapter
- **Console 019** — settlement-reconciliation (LAST; also needs DP-2 032 runtime wiring)

**What G2 ratification does NOT do (unchanged):**
- Does **not** lift the **reversal carve** — reversal-compatibility fields stay
  deferred until DP-026 closes (§OQ-4); the approved surface is non-reversal only.
- Does **not** authorize **connector ERPNext Payment-Entry posting** — still gated
  behind **011-DR-POSTING-R1** (§OQ-7).
- Does **not** activate **tax** — tax-pending under G6/ADR-0003 (§OQ-2).
- Does **not** author **DP-2 implementation** — controller/DTO/service + the **G3**
  schema/migration remain separate gated slices.

---

## Amendment A1 — OQ-7 superseded (2026-10-12)
Status: SIGNED by the owner (RT-277 comment 11662).

OQ-7 = 7-C is SUPERSEDED by the Retail Tower Payment, Tender & Receivables
Product Architecture baseline (Confluence RETAIL 23560196, owner-approved
2026-10-07). ERPNext owns customer and third-party A/R balances, cash
application/allocation, aging, payment terms, credit limits, collections and
accounting reconciliation. Backend-Core owns only the per-sale payer
responsibility allocation and the payer identity facade.

035 is narrowed (Option B) per RT-413. receivable.outstanding_balance,
payment_application, consoleApplyPayment, claim and remittance balance logic,
and payer_account.credit_terms are retired through gated forward migrations;
0027.down is never applied to live data.

OQ-4 (CARVE) and OQ-2 (tax-deactivated) remain in force for whatever survives.

---

## Amendment A2 — RT-417 contracts for R-1 (2026-10-16)
Status: PROPOSED — `[GATED]` contract PR, owner ratifies at review (RT-417
comment 11671 authorized the YAML; coordinator decisions below need ratifying).
Deciders: owner (R-1, RT-413 comment 11669); coordinator under the owner's
delegation (items marked *coordinator*); the RT-417 session (items marked
*in remit*).

### Context
R-1 puts the payer responsibility allocation on the sale at capture. Three
contracts carry it: the sale (`pos-sales/sales.yaml`), the Connector feed
(`erpnext-connector/posting-feed.yaml`) and the payer facade
(`settlement/settlement.yaml`). POS capture is deferred: finalize writes a local
outbox row and a background drain sends `captureSale` later, with cashier sales
on the RT-224 device path. So any capture refusal arrives after the goods left.

### Decision
- `sales.yaml` 1.10.0-draft (additive): optional
  `responsibilities[{payerRef, amount > 0, sequence}]`, hashed into the payload
  (an absent list leaves old hashes unchanged). Coverage
  `sum(tenders) + sum(responsibilities) = posTotal` exactly, else 422
  `sale_responsibility_mismatch`; with responsibilities present it replaces the
  RT-76 tender-only rule and an absent `tenders` counts as zero (*in remit*).
  Order: coverage, then line pricing, then payers; a replay answers first
  (*in remit*). One non-disclosing 422 `sale_responsibility_payer_invalid` for an
  unknown, cross-tenant, other-store, suspended or unlinked (`externalRef` null)
  payer (*coordinator*). `payerRef` and `sequence` unique per sale; at most 16
  entries (*in remit*). Reversal of such a sale is undefined (OQ-4 carve)
  (*coordinator*).
- `posting-feed.yaml` 1.8.0-draft (additive):
  `Sale.responsibilities[{payerExternalRef, amount, sequence}]`;
  `payerExternalRef` is frozen with the RT-332 resolution and is not in
  `payloadHash` (*in remit*). Unmapped payer → `permanently_rejected` /
  `validation`, never the store Customer. Responsibility-bearing `sale_post`
  items are held until the Connector supports them (RT-419); their reversals are
  held until a later issue defines them (*coordinator*).
- `settlement.yaml` 2.0.0 (BREAKING): only `consoleCreatePayerAccount` /
  `consoleListPayerAccounts` remain (contract-only until RT-418); six operations
  retired (`x-retired-operations`, runtime removed in RT-422); `creditTerms`
  removed; `externalRef` is the ERPNext Customer link.
- Offline credit (owner decision 2026-10-16, option A): `responsibilities` are
  accepted only on the `operatorAuthorization` path; on the RT-224 `device`
  path they are 422 `sale_responsibility_offline_refused`. The POS captures a
  responsibility-bearing sale synchronously, online, before finalize, and never
  queues it for the background drain, so every refusal reaches the till before
  finalize. On the POS only manager/admin sessions hold an envelope, so credit
  is manager/admin-only. This departs from POS spec 020 FR-5.

### Alternatives considered
- **R-2, keep `settlement-intent` with posting held** — rejected by the owner
  (RT-413 §1): two writes for one fact plus a hold state machine.
- **Keep the six settlement routes as `deprecated`** — rejected: the issue
  removes them, and a deprecated route still invites new consumers. The runtime
  keeps serving them until RT-422, which conformance permits.
- **Offline credit B: no server-side offline refusal, till-side gate only** —
  rejected by the owner (2026-10-16) in favour of A: it leaves deferred capture
  in place, so every capture refusal would land after the goods left.
- **Offline credit C: server staleness proxy (`receivedAt − settledAt > N`)** —
  rejected: it still refuses after finalize, and the drain backoff (up to
  5 min) makes N fragile.
- **Capture-time `externalRef` not checked; let the Connector reject** —
  rejected (*coordinator*): with no payer-update route a null link would
  dead-letter terminally.

### Consequences — breaking changes and affected consumers
| Change | Consumer | Follow-up |
| --- | --- | --- |
| 6 settlement operations removed | Admin-Console 018/019 screens + client wrappers | RT-421 removes them |
| `PayerAccountCreate.creditTerms` removed (400 if sent) | Admin-Console 017 create form | RT-421 drops the field, labels `externalRef` as the ERPNext Customer link |
| Payer routes still `contract-only` | Admin-Console 017 (404 today) | RT-418 ships them |
| `posRecordSettlementIntent` removed | POS spec 020 (draft, unimplemented) | RT-420 sends `responsibilities` on capture |
| `CaptureSaleRequest.responsibilities` (strict DTO rejects until RT-418) | POS capture | RT-420, after RT-418 deploys |
| `Sale.responsibilities` on reads (`additionalProperties: false`) | POS strict response validation | re-pin before RT-418 deploys |
| `Sale.responsibilities` on the feed | Connector (strict feed parsers re-pin) | RT-419 posts to the payer's Customer |
| Credit only on the envelope path, synchronous before finalize | POS capture (new capture mode, departs from spec 020 FR-5) | RT-420 (or a new issue): synchronous pre-finalize capture, no outbox queuing |

Gaps left open: a POS-facing payer lookup (the till has no way to obtain
`payerRef`s); a payer-update route to repair a missing `externalRef`; reversal
semantics for responsibility-bearing sales.
