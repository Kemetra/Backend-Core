# RT-571 — Reversal (void / return) semantics for responsibility-bearing (credit) sales: decision record and slice plan

> **Status:** decision record + slice plan (Work Mode: **Planning**). **Jira holds the live status.** This file
> records the 2026-10-18 planning pass. It is not a status tracker.
>
> It makes no production code, OpenAPI, migration, Connector, package or CI change. Each change below is applied only
> by the follow-up slice named in §8, under that slice's own `[GATED]` approval.
>
> **Sources:**
>
> * Jira: RT-571 (this item, including comment 12138, "voided before posted"), RT-577 (the owner's V1 decision and
>   rulings D6/D7/D8, comments 12180–12313), RT-417, RT-418, RT-419, RT-420.
> * Decision records: 035-DR-SETTLEMENT (§OQ-4 carve, Amendments A1/A2).
> * Backend-Core `origin/main` **`046b7f7c`**, inspected read-only.
> * ERPNext-Connector `origin/main` **`274589a`**, inspected read-only.
> * POS was **not inspected**. No runtime, ERPNext bench or database was exercised. Every ERPNext-behaviour statement
>   marked **NOT VERIFIED** needs bench evidence in the slice that relies on it.

**Goal:** define how a void or return of a sale with payer responsibilities reaches ERPNext, so that the RT-418
posting-feed hold on those reversals (035 OQ-4 carve) can be lifted safely.

**Architecture:** RT-577 already records the till side: who may reverse, how much cash goes back, and how much is a
receivable adjustment. RT-571 carries that recorded split to the Connector. A credit reversal becomes **one credit
note against the original Sales Invoice, on the payer's Customer**: negative payment rows for the cash actually
refunded, and the receivable adjustment left as a negative outstanding that reduces what the payer owes. Lifting the
hold needs four things: an additive feed contract bump, a Backend-Core projection change, the Connector support, and a
joint release procedure.

**Tech stack:** NestJS + Postgres (Backend-Core API/worker); OpenAPI 3.1 contracts in `packages/contracts/openapi/**`;
Frappe/ERPNext v15 Connector (Python).

---

## 1. Current behaviour on `main`

### 1.1 The POS-side block (RT-577, merged): the till side is decided

| Fact | Evidence |
| --- | --- |
| `recordVoid`, `recordReturn` and `recordRefund` refuse every sale with `sales.responsibility_count > 0` with 403 `credit_sale_reversal_restricted`, for every role, and write nothing. | `pos-sales/sales.yaml` 1.12.0-draft l.267-304; PR #806 |
| `recordCreditSaleReversal` (`POST /api/pos/v1/sales/{saleRef}/credit-reversals`) is the only reversal path. It is Manager/Admin only and goes through the `PosOperatorEnvelopeSaleGuard`. It writes the ordinary `sale_voids` / `sale_returns` row and adds a `sale_credit_reversals` row (`reversal_total = refundable_amount + adjustment_amount`, CHECK-enforced, plus `payer_id` and `adjustment_ref`) and `sale_credit_reversal_tenders`. | `credit-sale-reversals.controller.ts`; `credit-sale-reversal.store.ts`; migration `0054_sale_credit_reversals.sql` |
| D7: `refundable = floor_m(C×X1/P) − floor_m(C×X0/P)` in exact integer minor units, where C is the collected tender total, P is `posTotal`, and X0/X1 are the cumulative reversed totals before and after. A void therefore refunds all of C, and its adjustment is the payer's share. | `credit-sale-reversal.checks.ts` l.181-241 |
| D8: a credit void refunds by mirroring the collected tenders (card to card, cash to cash). A credit return refunds in cash only. A return with `refundable = 0` writes **no** `sale_return_tenders` row. | `credit-sale-reversal.store.ts` l.258-270 (`insertReturnTenders` returns early) |
| Allocation fails closed (422 `credit_reversal_allocation_unavailable`) when the sale already has an ordinary return or refund, when `mismatch_flag` is not false, or when `posTotal <= 0`. | `credit-sale-reversal.checks.ts` l.136-170 |
| "Payer settlement" (D12) only checks that the payer still exists in this tenant and store. It does **not** know whether the payer has paid the invoice in ERPNext, and cannot: since Amendment A1, ERPNext owns A/R balances. | `credit-sale-reversal.checks.ts` l.245-259; 035-DR A1 |
| The reversal emits `ERPNEXT_POSTING_REQUESTED` in the same transaction, so its `reversal` posting intent is created. | `credit-sale-reversal.store.ts` l.121-122 |

### 1.2 The ERP-side hold (RT-418): what RT-571 must lift

`ErpnextPostingService.pullPostings` (`erpnext-posting.service.ts` l.212-275) withholds a pending row of a sale with
`responsibility_count > 0` when any of the following holds:

* **(H1)** it is a `reversal`: always held, whatever the gate;
* **(H2)** it is a `sale_post` and `ERPNEXT_FEED_RESPONSIBILITIES_ENABLED` is off;
* **(H3)** it is a `sale_post` and any void, refund or return of the sale exists (comment 12138, "voided before
  posted");
* **(H4)** the visible responsibility rows differ from the count, or the payer link is blank: fail closed.

The contract states the same thing: `posting-feed.yaml` 1.8.0-draft l.225-236 and `sales.yaml` l.262-265, l.1056-1064,
l.2365-2378 (`ReceivableAdjustment` is "held until RT-571 / RT-419 define its shape").

The hold traces back to the **signed** 035 OQ-4 carve. That carve made reversal compatibility conditional on DP-026's
close, and `specs/026-returns-reversal-contract/wave-status.md` still reads "DETERMINATION — OPEN" (last updated
2026-06-09). Since then the reversal surface has shipped and been extended in practice:

* `reversalKind: return`, `lineRef` and the reversal's own time (RT-72/RT-73);
* the per-reversal anchor, where the Connector keys a credit note on `workItemRef`, not on the sale's `externalId`
  (Connector #28). That answers DP-026's Question A in practice.

This plan **reuses** that DP-026 reversal work item and adds no parallel reversal model, which satisfies 035 NG-1.
Formally closing the carve for credit sales is still an owner act (OD-571-9).

### 1.3 Four defects that make "just flip the hold" unsafe

| # | Finding | Evidence | Consequence if the hold were lifted as-is |
| --- | --- | --- | --- |
| F1 | `loadRefundTenders` **throws** `ReturnTendersNotVisibleError` when a return has zero tender rows. A full-credit return (refundable = 0) has zero rows by design. | `posting-work-item.projection.ts` l.519-530 | One zero-payout credit return fails **the whole tenant's feed pull** on every poll. All posting stalls, not just that item. |
| F2 | The feed cannot carry a credit return. `reversalOf.refundTenders` has `minItems: 1`, the INVARIANT says every return carries refund tenders summing to the returned total, and there is no field for the adjustment. | `posting-feed.yaml` l.95-111, l.653-662 | A partial-cash return would be read as an under-refund. A zero-cash return cannot be expressed at all. |
| F3 | The Connector rejects both kinds of credit return. `return_builder._return_ref` raises `MissingRefundTenders` on empty tenders, and the forward money path requires the settled total to equal the requested total (RT-16, commit `285e142`). | Connector `return_builder.py` l.130-138; `builder.py` | `permanently_rejected` / `validation` for every credit return: a dead letter, not a credit note. |
| F4 | The Connector's **void** leg does not mirror the original invoice's `customer`. `link_void_to_original` mirrors stock, rounding, lines and payments only. The customer comes from `customer_for(store_id)`, the **store** Customer. The return leg does mirror it (`link_return_to_original`, `original_customer`). | Connector `stock_policy.py` l.100-133 vs l.211-239; `frappe_glue.py` l.1118-1136; `builder.py` l.89 | A credit void would credit the store Customer while `return_against` names the payer's invoice. Either ERPNext refuses it (**NOT VERIFIED**) or the payer's receivable is never reduced. |

A fifth gap is procedural. The RT-418 re-head script (`docs/operations/sql/sale-responsibilities-feed-rehead.sql`)
deliberately **skips** sales with any void, refund or return. The pre-post void case therefore has no release path
today.

## 2. Accounting facts per case

Notation: P = `posTotal`, C = collected tenders (cash + card), R = the payer's responsibility, with P = C + R (the
RT-417 coverage rule). X = the reversal total.

RT-419 has not decided its document shape yet. This record **assumes** the shape the feed already implies: one
`documentRef` per work item and `maxItems: 1` payer. That is one Sales Invoice with `customer` = the payer's Customer,
`is_pos = 1` with one payment row per collected tender, and R left outstanding (OD-571-5). If RT-419 picks a
different shape, this section is re-derived before S4.

| Case | Backend-Core (recorded by RT-577) | Till cash | ERPNext (target) |
| --- | --- | --- | --- |
| **A. Full void, sale posted, payer has not paid** | `sale_voids` + `sale_credit_reversals(kind=void, refundable=C, adjustment=R)` | C refunded, mirrored per tender (D8) | One credit note, `return_against` = original SI, customer = the original SI's customer (the payer). Lines −P, payment rows −C (mirrored from the original), outstanding −R. That −R reduces the original invoice's outstanding to 0 (**NOT VERIFIED**: depends on v15 `update_outstanding_for_self`; bench evidence in S4). |
| **B. Full void, payer has already paid R** (Payment Entry in ERPNext) | Same as A. Backend-Core cannot tell A from B. | C | Same credit note. The original SI is already settled, so −R becomes a **credit balance on the payer's Customer** (**NOT VERIFIED**). Returning it to the payer is an ERPNext finance action (OD-571-6), never the till. |
| **C. Full void of a full-credit sale** (C = 0) | `refundable = 0`, `adjustment = P`, no refund tenders | none | The original SI is not `is_pos`, so `_mirror_settlement` carries no payments (already supported). An outstanding credit note of −P against the payer. |
| **D. Partial return, mixed sale** | `sale_returns` + lines; `sale_credit_reversals(kind=return, refundable = D7 share, adjustment = X − refundable)`; cash `sale_return_tenders` rows sum to `refundable`. D6 second approval when refundable > 0. | refundable, in cash | One credit note, `return_against` = original SI, customer mirrored, lines −X, one cash payment row −refundable, outstanding −adjustment. Coverage: Σ refund tenders + adjustment = X exactly, otherwise `validation` (OD-571-2). |
| **E. Partial return, full-credit sale** (C = 0) | refundable = 0, adjustment = X, **no** `sale_return_tenders` | none | An outstanding credit note of −X against the payer, with no payment rows (OD-571-3). Today this is F1 + F3. |
| **F. Successive partial returns** | One reversal row and one posting intent per return. D7 is cumulative, so the refundable shares sum to at most C and to exactly C once everything has been returned. | per return | One credit note per return. ERPNext's per-line over-return cap applies via `sales_invoice_item` (RT-16). |
| **G. Reversal recorded before the sale posted** (comment 12138) | `sale_post` held by H3, reversal held by H1 | as A–E | Both are released together, `sale_post` first, so the credit note always finds its original (OD-571-1). |
| **H. Ordinary-route reversal of a credit sale recorded before the RT-577 runtime was deployed** | `sale_voids` / `sale_returns` / `sale_refunds` with **no** `sale_credit_reversals` row. The full return total may have been paid out in cash. | possibly all of X (the exact problem RT-577 fixed) | **Never auto-released.** Detected by query (§6) and resolved manually (OD-571-7). |

**Refund to payer vs refund to customer.** The customer at the till only ever receives the collected share, as recorded
in `refundTenders`. The payer only ever receives a reduction of what it owes: the credit note's negative outstanding.
No flow pays the payer in cash from the till, and no flow pays the customer the payer's share. When a credit balance
must be paid back to the payer (case B), finance does it inside ERPNext (Payment Entry or allocation against a later
invoice). Backend-Core, the POS and the feed are not involved.

**Tax.** Tax stays deactivated (035 OQ-2). A taxed credit return keeps RT-16's behaviour: rejected as `validation`.

## 3. What each system must record or post

| System | Must do | Must not do |
| --- | --- | --- |
| **Backend-Core** | Keep recording exactly what RT-577 records; nothing new at capture. Project each credit reversal onto the feed with its split (`refundTenders`, possibly empty, plus `receivableAdjustment`). Fix F1. Split the H1 hold by a new gate. Release a pre-post pair in order. | Compute or store a payer balance. Decide whether the payer is settled. Re-resolve the payer: a reversal **copies** the original resolution's `payer_external_ref` (RT-418 decision (b)). |
| **Feed contract** (`posting-feed.yaml`) | Additive `reversalOf.receivableAdjustment {adjustmentRef, amount}`. `refundTenders` may be empty only when an adjustment is present and covers the whole return. A coverage rule for credit reversals. A rollout order and a new gate. | Carry `tenant_id`, credentials or the Backend-Core payer id (the RT-417 rule). |
| **Connector** | Post a credit note against the original SI on the original SI's customer, for **void and return** (fixes F4). Accept an empty `refundTenders` under the coverage rule (fixes F3). Fail closed if `sale.responsibilities[0].payerExternalRef` differs from the original SI's customer (OD-571-5c). | Fall back to the store Customer. Create a Payment Entry to the payer. Adjust an amount to force a match. |
| **ERPNext** | Holds the resulting A/R. Finance handles any payer credit balance. | — |
| **POS** (the RT-577 POS follow-up, already unblocked) | Offer the credit reversal only through the synchronous Manager/Admin envelope route. Show the 403 on the ordinary routes as terminal. | Queue a credit reversal in `sale_sync_outbox`. Pay out cash before the server has answered. |

## 4. Idempotency and ordering with posting intents

* **One intent per reversal row.** The credit reversal reuses the ordinary `sale_voids` / `sale_returns` row, so the
  existing `reversal` intent (keyed by `source_ref_id`) and its `workItemRef` stay the exactly-once key. The Connector
  writes `workItemRef` to `rt_external_id` (`unique_rt_si_provenance`, Connector #28). No new key and no new
  work-item kind are needed.
* **`adjustmentRef` is for correlation only.** It is carried on the wire for audit and reconciliation. It is not part
  of `payloadHash` and does not key anything (OD-571-2b).
* **Byte-identical re-pulls.** The projection reads only immutable rows (`sale_credit_reversals`,
  `sale_return_tenders`, `sale_credit_reversal_tenders`), in a fixed order.
* **Order inside a pair.** Sequences are drawn from one counter, and a reversal offered before its original posts gets
  `failed_transient` from the Connector (RT-172), bounded by `POSTING_RETRY_BUDGET = 5`
  (`erpnext-posting.service.ts` l.48). So the release must give the held `sale_post` a **lower** sequence than its
  reversals. Re-heading reversals first, or in one unordered `UPDATE … SET sequence = DEFAULT`, can spend the budget
  and dead-letter the reversal. The release procedure re-heads in an explicit order (§8 S2) under the tenant's
  `erpnext-posting-feed` advisory lock, in one transaction.
* **The void mirror cross-check.** For a credit void the feed keeps mirroring `sale.tenders` (RT-10 D6). Backend-Core
  must assert that `sale_credit_reversal_tenders` for the void equals `sale.tenders` by method and amount. If it does
  not, the item is held, never offered with a different refund (the Connector already cross-checks against the
  original SI's payments, `_mirror_settlement`).

## 5. Offline POS

* Credit **sales** are online only (RT-417 option A: the device path gets 422 `sale_responsibility_offline_refused`).
  The till therefore always knows that a sale it captured is a credit sale.
* Credit **reversals** are online only as well. `recordCreditSaleReversal` sits behind the operator-envelope guard and
  is synchronous. The POS must not offer it offline and must not queue it.
* A reversal queued offline on an ordinary route against a credit sale is refused with a terminal 403 when it drains.
  If cash already left the drawer, the result is a drawer variance. The POS follow-up must block void and return
  locally for any sale whose local record carries responsibilities, online or offline. RT-571 adds no new offline
  rule. It records that the server refusal stays the control (the RT-530 order).

## 6. Data migration: none expected, one read-only check

The facts the feed needs are already stored by 0051 and 0054, so no schema change is expected. Before S5 the owner runs
this read-only query per tenant, under the tenant GUC:

```sql
-- Case H: reversals of credit sales recorded WITHOUT a credit-reversal row (ordinary routes, pre-RT-577 runtime).
SELECT s.id AS sale_id, 'void' AS kind, v.id AS reversal_id FROM sales s
  JOIN sale_voids v ON v.sale_id = s.id
 WHERE s.responsibility_count > 0 AND NOT EXISTS (SELECT 1 FROM sale_credit_reversals c WHERE c.void_id = v.id)
UNION ALL
SELECT s.id, 'return', r.id FROM sales s
  JOIN sale_returns r ON r.sale_id = s.id
 WHERE s.responsibility_count > 0 AND NOT EXISTS (SELECT 1 FROM sale_credit_reversals c WHERE c.return_id = r.id)
UNION ALL
SELECT s.id, 'refund', f.id FROM sales s
  JOIN sale_refunds f ON f.sale_id = s.id
 WHERE s.responsibility_count > 0;
```

An empty result means no data migration is needed. A non-empty result goes to OD-571-7. The new hold predicate (S2)
keeps such rows held permanently, whatever the gates say.

## 7. Owner decisions

Each decision lists the options, the **recommended** one first, and why. None is selected by this document.

### OD-571-1 — Releasing a credit sale that was reversed before it posted (case G)

| Option | For | Against |
| --- | --- | --- |
| **A. Release the pair: narrow H3 (S2), then re-head `sale_post` first and its reversals in creation order (Recommended)** | Full audit trail in ERPNext (invoice + credit note). Stock nets to zero through the normal path. Uses existing Connector behaviour (RT-172) without spending the retry budget. | Two documents for a sale that never stood. |
| B. Suppress both (mark locally as not posted) | No ERPNext noise. | A new terminal state in `erpnext_posting_status`, a migration, and a gap between Backend-Core sales and ERPNext that reconciliation (spec 017) would flag forever. |
| C. Post the reversal only | — | There is no original to `return_against`. RT-172 dead-letters it. |

### OD-571-2 — How the feed carries the split

| Option | For | Against |
| --- | --- | --- |
| **A. Explicit `reversalOf.receivableAdjustment {adjustmentRef, amount}` plus a coverage rule `Σ refundTenders + adjustment = reversal total`, otherwise `validation` (Recommended)** | Mirrors the RT-417 coverage rule on `sale_post`. The Connector posts verbatim amounts and never derives money. Backend-Core's D7 result is the single source. | One more optional field (additive). |
| B. The Connector derives the adjustment as `total − Σ refundTenders` | No contract field. | A missing tender row silently becomes payer credit: the F1 failure, moved into ERPNext. |

**OD-571-2b:** `adjustmentRef` is carried for correlation only. It is outside `payloadHash`, and the Connector writes it
to the credit note's remarks, with no new custom field (**Recommended**). The alternative is a new `rt_adjustment_ref`
custom field, which is a gated fixture change.

### OD-571-3 — A credit return that refunds nothing (case E)

**Recommended:** `refundTenders` may be **empty or absent** on a `return` only when `receivableAdjustment` is present
and its amount equals the returned total. Every other return keeps `minItems: 1` and the RT-86 INVARIANT. The
alternative, emitting a `{cash, 0}` row, contradicts RT-577's "zero refund takes an empty refundTenders" hardening and
would post a zero payment row.

### OD-571-4 — Rollout gate

| Option | For | Against |
| --- | --- | --- |
| **A. A new `ERPNEXT_FEED_CREDIT_REVERSALS_ENABLED`, default off, which may be on only while `ERPNEXT_FEED_RESPONSIBILITIES_ENABLED` is on (Recommended)** | Credit `sale_post` (RT-419) can go live and be bench-proven before reversals. Rolling back reversals does not stop sales posting. | One more flag to map into the API container. |
| B. Reuse `ERPNEXT_FEED_RESPONSIBILITIES_ENABLED` | One flag. | It couples two Connector capabilities that ship in different slices. |

### OD-571-5 — ERPNext document shape for a credit reversal

**Recommended:** **one credit note per reversal** (`is_return = 1`, `return_against` = the original SI), with:

* (a) `customer` mirrored from the original SI for **void and return** (fixes F4);
* (b) negative payment rows for the refunded tenders only, with the rest left as negative outstanding;
* (c) a fail-closed `validation` when the frozen `payerExternalRef` on the reversal differs from the original SI's
  customer. That can happen when RT-572 re-pointed the payer link after posting. Such a case goes to reconciliation;
  the document is never moved.

The alternative is two documents per reversal (a credit note for the cash share and a separate Journal Entry against
the payer for the adjustment). It needs a new ack shape (two `documentRef`s) and breaks the 1:1 work item → document
rule. This decision depends on RT-419's forward shape. If RT-419 posts something other than one `is_pos` SI per
sale, OD-571-5 is re-opened before S4.

### OD-571-6 — Reversal after the payer has paid (case B)

**Recommended:** Backend-Core and the Connector post the same credit note whether or not the payer has paid. The
resulting credit balance stays on the payer's Customer in ERPNext, and finance refunds or allocates it there. Nothing
is held for "settled". The alternative, holding reversals of settled invoices, would need Backend-Core to read ERPNext
A/R, which Amendment A1 forbids.

### OD-571-7 — Legacy ordinary-route reversals of credit sales (case H)

**Recommended:** keep them **held permanently**: the S2 predicate never offers a reversal of a credit sale that lacks
its `sale_credit_reversals` row, and never offers that sale's `sale_post` either. Finance resolves each one manually
(ERPNext entries plus the cash variance). The query in §6 runs first; if it returns nothing, this decision is moot. The
alternative, a data migration that back-fills `sale_credit_reversals` rows, would fabricate an allocation for cash that
was really paid out in full. Rejected.

### OD-571-8 — Partial-return rounding against ERPNext

**Recommended:** the Connector posts D7's minor-unit amounts verbatim. If ERPNext's own rounding (`rounded_total`, RT-80)
would differ from Σ lines, the item is rejected as `validation`; it is never absorbed by a Round Off row. The
alternative is to allow a Round Off on credit returns, which would let the payer's credit drift from what Backend-Core
recorded.

### OD-571-9 — Closing the 035 OQ-4 carve for credit sales

**Recommended:** the owner signs **Amendment A3** to 035-DR-SETTLEMENT, written in S1 and not in this PR. It closes the
OQ-4 carve for responsibility-bearing sales on two grounds: the shipped reversal surface (RT-72/RT-73, Connector #28)
and NG-1 reuse (§1.2). DP-026's own formal determination is left to its own closeout. The alternatives:

* Close DP-026 first (CHECKPOINT-2). This is the purer order, but it gates credit reversals on an unrelated, dormant
  determination.
* Leave the carve in place. The hold then stays indefinitely.

## 8. Follow-up slices

Proposed, not created. The coordinator creates the Jira items once the owner rules on §7.

| # | Slice | Repo | Gate | Depends on | Acceptance |
| --- | --- | --- | --- | --- | --- |
| **S1** | Feed contract `posting-feed.yaml` 1.9.0-draft: `ReversalRef.receivableAdjustment`, conditional empty `refundTenders` (OD-571-3), coverage rule (OD-571-2), new gate and rollout order (OD-571-4); `sales.yaml` text: "held until RT-571" → "posted per RT-571"; Amendment A3 to `specs/035-…/decisions/settlement-receivables-decision-record.md` (OD-571-9). | Backend-Core | **[GATED] OpenAPI contract** | §7 rulings | Contract and conformance specs green; oasdiff additive only; CHANGELOG entry. |
| **S2** | Backend-Core runtime: projection reads `sale_credit_reversals` (adjustment, empty refund tenders, F1 fixed only for returns that have a credit-reversal row, still throwing for an ordinary return with zero rows); void mirror cross-check (§4); H1 split by the new gate; **H3 narrowed**: a credit `sale_post` is held only while the reversal gate is off **or** some reversal of the sale lacks its `sale_credit_reversals` row (without this, case G never releases and its reversals dead-letter through RT-172); permanent hold for case H; ordered joint re-head SQL `docs/operations/sql/sale-credit-reversals-feed-rehead.sql`. | Backend-Core | **[GATED] contract posture** (the projection starts emitting S1 fields). **Migration: none expected.** A migration, if one proves needed, takes the next free number at authoring time and needs its own gate. | S1 merged | Tests below green; `EXPLAIN` of the extended hold predicate at pilot volume. |
| **S3** | RT-419 (existing): post a credit `sale_post` to the payer's Customer. | ERPNext-Connector | **[GATED] Connector Settings / fixture** (per RT-419) | RT-418 (merged) | RT-419's own acceptance, plus a recorded decision on the forward shape that OD-571-5 assumes. |
| **S4** | Connector credit reversal: void customer mirror (F4); empty `refundTenders` under coverage (F3); payer-mismatch fail-closed (OD-571-5c); credit note with `return_against`. | ERPNext-Connector | **[GATED] Connector ERP-side posting**; bench evidence required | S1, S3 | Unit tests for cases A–F; **bench evidence** for A, B, D and E showing debtor, outstanding on the original SI, payer credit balance in case B, and GL. |
| **S5** | Deploy: run the §6 query; turn on `ERPNEXT_FEED_CREDIT_REVERSALS_ENABLED`; run the joint re-head in the same release step. | Ops (owner) | Owner deploy action | S2 deployed, S4 deployed, RT-419 gate on | The re-head script reports N rows; no reversal dead-letters as `retry_budget_exhausted`; the feed pull never fails. |
| — | POS: Manager/Admin credit reversal flow (RT-577 follow-up). | POS | Its own | #806 (merged) | Runs **in parallel**; it does not depend on RT-571. |

**Order:** S1 → S2. S3 runs in parallel with S1/S2. Then S4 (needs S1 + S3), then S5. The hold stays fully in force
until S5, so S2 and S4 can merge and deploy dark.

### Required tests (S2)

* `posting-work-item.projection.spec`:
  * a credit return with refundable 0 projects `refundTenders` absent and `receivableAdjustment.amount` = return
    total;
  * a mixed credit return projects both, and their sum equals Σ `returnLines.lineAmount`;
  * an **ordinary** return with zero tender rows still throws `ReturnTendersNotVisibleError` (the RT-86 guard is
    kept);
  * a credit void projects `receivableAdjustment.amount` = R and `sale.tenders` = C;
  * a void whose `sale_credit_reversal_tenders` differ from `sale.tenders` is held.
* `erpnext-posting.service.spec` (hold predicate):
  * with the reversal gate off, credit reversals stay held (today's behaviour);
  * with it on, a reversal with a credit-reversal row is offered;
  * a case-H reversal and its `sale_post` stay held with both gates on;
  * with both gates on, a `sale_post` whose only reversals all have a credit-reversal row is offered (H3 narrowed),
    with a lower sequence than its reversals after the re-head;
  * with the reversal gate off, that same `sale_post` stays held (H3 unchanged);
  * gate on while the responsibilities gate is off: still held;
  * re-pull is byte-identical.
* Re-head SQL integration test: a held `sale_post` plus two held returns get ascending sequences in the order
  `sale_post` < return 1 < return 2; ordinary-sale rows are untouched; case-H rows are skipped.
* Pull resilience: one malformed credit reversal does not fail other tenants' pulls, and a held row never shortens a
  page.

## 9. Review focus (inputs no test above pins yet)

1. **The payer link was re-pointed between posting and reversal** (RT-572). Expected: the Connector rejects the
   reversal as `validation` (OD-571-5c) and never credits the new Customer.
2. **A return of the last units after earlier partial returns.** Expected: the cumulative refundable shares equal C
   exactly, and the last credit note's coverage holds to the minor unit.
3. **JPY / zero-decimal currencies.** Expected: D7 with no minor unit; ERPNext precision does not round the adjustment.
4. **A credit void of a sale whose `sale_post` dead-lettered** (`permanently_rejected`). Expected: the reversal waits
   (RT-172) and then dead-letters too. It is repaired through spec 017; nothing is posted alone.
5. **The gate is flipped back off after some reversals posted.** Expected: the remaining reversals are held again,
   posted ones are untouched, and re-enabling needs the re-head again.

## 10. Risks and assumptions

* **This record depends on RT-419's forward shape** (OD-571-5). RT-419 is still To Do. If it chooses two documents
  per credit sale, §2 and S4 are re-derived.
* **ERPNext v15 return semantics are NOT VERIFIED**: whether `return_against` reduces the original invoice's
  outstanding or leaves a separate negative outstanding (`update_outstanding_for_self`), and whether ERPNext refuses a
  return whose customer differs from its `return_against`. Both go into S4's bench evidence.
* **Backend-Core is blind to payer settlement by design** (A1). Case B is handled entirely in ERPNext.
* **The single payer limit (`maxItems: 1`) stays.** Multi-payer reversal waits for multi-payer sales.
* **The POS repo was not inspected.** The offline statements in §5 rest on the Backend-Core contract alone.
