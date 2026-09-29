# Decision Amendment: POS Sale Settlement on the Sales Invoice (RT-10, 2026-09-29)

**Decision ID**: 011-DR-POSTING-A1 (amendment)
**Amends**: [011-DR-POSTING](./posting-decision-record.md) §1 (posting target shape) and rider [R1](./posting-decision-rider-2026-06-05.md#r1--payment-entry-resolves-015-oq-7) (Payment Entry)
**Source**: Jira RT-10: proposal comment 10393, owner decision 10394, spike confirmation 10401. Bench evidence: RT-75 comment 10400.
**Status**: **SIGNED** (owner, 2026-09-29, "go recommended"; the condition in §3 was met on the same day)
**Owner / signer**: Ahmed Shaaban

> This amendment changes only **how** a paid POS sale is represented in ERPNext.
> Everything else in 011-DR-POSTING and rider R1 stands. That includes the 1:1
> sale → Sales Invoice mapping, the posting date/time rules, the failure posture,
> and R1's ban on deriving tender from `posTotal`.

---

## 1. What changes

**Before (011 §1 / R1):** each sale posts as a submitted Sales Invoice **plus a
separate associated Payment Entry**. The Payment Entry stayed deferred, and the
interim posting was an unpaid Sales Invoice with open receivables.

**After (this amendment):** a sale that carries tender facts posts as **one
submitted Sales Invoice that carries its own payments**. That is `is_pos = 1`
with one row in the invoice's `payments` table per tender (RT-10 D3(b)). There
is **no separate Payment Entry** for a POS sale.

* The invoice is **Paid** on the same submit. The Connector's existing Sales
  Invoice exactly-once guarantee (Posting Log + `unique_rt_si_provenance`)
  therefore also covers settlement.
* The posting-feed ack is unchanged: one `documentRef` per work item.
* This is still the **Sales Invoice** doctype. It does not adopt ERPNext's POS
  Invoice / POS Closing documents or the ERPNext POS UI (Retail Tower's POS
  remains the cashier).

## 2. R1 gated items: how each is met

| R1 gate item | Met by |
| --- | --- |
| 1. A tender/payment fact model | RT-10 D1: `tenders[]` on capture, stored as an immutable sale child (RT-76 contract, RT-77 implementation) |
| 2. A posting-feed extension carrying tender | RT-76: posting-feed `Sale.tenders` and `ReversalRef.refundTenders` (additive) |
| 3. Connector exactly-one settlement per sale | The settlement is inside the Sales Invoice submit, so it inherits the invoice's exactly-once guarantee (RT-78) |
| 4. Repair / reconciliation semantics | Unchanged from the Sales Invoice path: there is no separate payment outcome to repair |

## 3. Condition (met)

The amendment was conditional on a bench spike, **RT-75**, which passed on
ERPNext v15.110.0. The spike showed that:

* **no POS Profile** is required;
* the invoice posts **Paid**, with correct GL and stock entries in the same submit;
* **split tender** works;
* a **void** as a return invoice with **negative payments mirroring the original
  tenders** nets receivables to zero and restores stock exactly once.

Two prerequisites follow for the Connector (RT-78):

1. **`disable_rounded_total = 1`**. With the default rounding, a 10.49 cash sale
   booked a false 0.49 "change" and a round-off. The same default also rounds
   today's unpaid invoices, which is a latent defect tracked as RT-80.
2. **Every mapped payment mode must have a company account.** Mapping a missing
   one fails closed (RT-10 D5). The pilot card clearing account is finance
   configuration.

If ERPNext behaviour ever invalidates §1, the fallback is the original R1 shape:
a per-sale Payment Entry. That fallback needs the owner's re-confirmation.

## 4. Reversals and tender-unknown sales

* **Void** (RT-10 D6): the return invoice carries negative payments that mirror
  the original sale's tenders. The feed carries them as non-negative magnitudes,
  and the Connector negates them, as it negates returned lines.
* **Return** (RT-14 D3 / RT-10 D6): the return invoice pays out the return's
  recorded `refundTenders` (cash only).
* **Tender-unknown sale** (RT-10 D8): a sale captured without `tenders` posts
  exactly as in R1's interim mode, as an unpaid invoice with open receivables.
  A **void** of it has no tenders to mirror, so it stays an outstanding credit
  note. A **return** against it still pays out its recorded `refundTenders`,
  because that cash really left the drawer. The original invoice's open
  receivable is part of the D8 reconciliation population, not settled by the
  return. There is **no backfill**, and
  tender is **never derived from `posTotal`**: that R1 rule is unchanged.

## 4a. Total mismatch

Capture keeps the POS total verbatim, and a difference from the line sum is
only an advisory flag (008 FR-030/031). Tenders sum to `posTotal`, while the
Connector builds the invoice total from the lines. When the two differ, the
Connector rejects the work item (`permanently_rejected` / `validation`, a
reconciliation case). It never adjusts a line, invents change or posts a
partial settlement to force a match.

## 5. Not changed

* The 1:1 sale → Sales Invoice mapping and the rejection of POS Invoice /
  POS Closing consolidation (011 §1).
* The posting date/time (RT-49) and reversal time (RT-63) rules, and stock
  movement on the invoice (RT-47/RT-48).
* The 035 payer receivables (`receivable.erpnextPaymentEntryRef`): those are
  third-party payer settlement, still gated by R1 and not affected here.
* ADR-0005: Backend-Core records tender as a sale fact. It owns no payment
  allocation or GL ledger.

## 6. Superseded text

For **POS sale settlement**, this amendment supersedes:

* 011-DR-POSTING §1: "with its tender posted as the associated Payment Entry".
* 011-DR-POSTING §4: "produced by the submitted Sales Invoice + Payment Entry".
  For a POS sale, the GL comes from the Sales Invoice carrying its own
  payments. The rest of §4 (system of record, no silent rewrites) stands.
* Rider R1: "each DP2 sale posts as one submitted Sales Invoice + its associated
  Payment Entry" and "MUST NOT present 'Sales Invoice only' as the final accepted
  posting model". The final model is now a Sales Invoice **carrying its own
  payments**. A Sales Invoice without payments remains the interim mode, but only
  for tender-unknown sales.
* Rider R1 gate item 3's "exactly-one Payment Entry per sale tender". See §2.
* Spec `015-pos-sale-posting-to-erpnext`, wherever it plans a POS-sale Payment
  Entry. Those passages are historical for POS sales; this record governs.

Payment Entry language about **third-party payer settlement** (spec 035
receivables) is not superseded.

## 7. Rollout order

A Connector without settlement support would post a tendered sale unpaid and
ack it `posted`. That outcome is terminal, so the sale would never be settled
later. Two rules follow:

* Backend-Core MUST NOT emit tender fields on the posting feed until the
  Connector supports settlement (RT-78).
* **Invariant:** a work item for a tender-bearing sale (or its return) is
  never offered *without* its tenders. Withholding only the fields gives the
  same terminal unpaid posting.
* **Returns wait for settlement too:** every return carries `refundTenders`
  (RT-14 D3), even against a tender-unknown sale. So no return work item is
  offered until the Connector supports settlement (RT-78) as well as returns
  (RT-16), whatever the original sale's tenders. In Backend-Core, the RT-73
  `POS_RETURNS_ENABLED` switch stays off until both have shipped.

So tender acceptance on capture (RT-77) goes live only once RT-78 is deployed,
unless Backend-Core holds tender-bearing work items off the feed until then.
See the posting-feed contract's ROLLOUT ORDER and INVARIANT.
