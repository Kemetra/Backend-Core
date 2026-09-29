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
  the original sale's tenders.
* **Return** (RT-14 D3 / RT-10 D6): the return invoice pays out the return's
  recorded `refundTenders` (cash only).
* **Tender-unknown sale** (RT-10 D8): a sale captured without `tenders` posts
  exactly as in R1's interim mode, as an unpaid invoice with open receivables.
  Its reversal stays an outstanding credit note. There is **no backfill**, and
  tender is **never derived from `posTotal`**: that R1 rule is unchanged.

## 5. Not changed

* The 1:1 sale → Sales Invoice mapping and the rejection of POS Invoice /
  POS Closing consolidation (011 §1).
* The posting date/time (RT-49) and reversal time (RT-63) rules, and stock
  movement on the invoice (RT-47/RT-48).
* The 035 payer receivables (`receivable.erpnextPaymentEntryRef`): those are
  third-party payer settlement, still gated by R1 and not affected here.
* ADR-0005: Backend-Core records tender as a sale fact. It owns no payment
  allocation or GL ledger.
