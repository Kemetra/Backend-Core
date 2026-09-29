# Decision Rider: ERPNext Posting Model — Owner Ratifications (2026-06-05)

**Decision ID**: 011-DR-POSTING-R1 (rider)
**Amends / clarifies**: [011-DR-POSTING](./posting-decision-record.md) (posting model). Interim postures also operate within [011-DR-STOCK-IMPACT](./stock-impact-decision-record.md) §4 (warehouse target). **Neither signed record's decisions are altered** — this rider ratifies interim modes and architecture selections *within* them.
**Feature**: 011-erpnext-pos-reference-and-integration-foundation (governs **015**)
**Status**: **SIGNED**
**Gates**: spec **015** (planning + future implementation slices); the future `[GATED]` 012 contract correction/extension slices named below
**Owner / signer**: Ahmed Shaaban
**Created / Signed**: 2026-06-05

> **SIGNED.** This rider durably records the owner decisions resolving the open
> questions raised by the 015 planning spec
> (`specs/015-pos-sale-posting-to-erpnext/`). It records the owner's dispatched
> decisions verbatim in substance. Any deviation from this rider is a
> **STOP-and-raise** condition, not a silent override.

---

## R1 — Payment Entry (resolves 015 OQ-7)

> **Amended 2026-09-29 (RT-10) by [011-DR-POSTING-A1](./posting-decision-amendment-2026-09-29-rt10.md):**
> a POS sale's tender is settled on the Sales Invoice itself (payments carried on the
> invoice), not by a separate Payment Entry. The ban on deriving tender from
> `posTotal` and every other rule here are unchanged.

**The signed target is unchanged**: each DP2 sale posts as one **submitted Sales
Invoice + its associated Payment Entry** [011-DR-POSTING §1]. DP-015 **MUST NOT**
present "Sales Invoice only" as the final accepted posting model.

However, because **DP-008 currently has no tender/payment fact model** (gate
A.5) and the **current DP-012 posting-feed work-item cannot carry tender/payment
payload**, the Payment Entry is **deferred from the first implementation slice**.

**Owner-ratified INTERIM MODE — "submitted Sales Invoice / outstanding AR only":**

- **NOT finance-complete production posting.** The interim mode is a temporary,
  finance-incomplete state — never the destination.
- **Expected to produce unpaid/outstanding ERPNext Sales Invoices** (open
  Accounts Receivable) until the tender/payment extension ships. This is by
  design and must be communicated to any consumer of ERPNext finance reports —
  it is an expected state, not a defect.
- **Gated**: Payment Entry posting **MUST NOT be implemented** until ALL of the
  following gated work lands:

  1. A DP2 **tender/payment fact model** (or an approved equivalent
     sale-payment payload).
  2. A **DP-012 posting-feed extension** carrying the payment/tender data
     (versioned, backward-compatible).
  3. **Connector support for idempotent Payment Entry creation** (exactly-one
     Payment Entry per sale tender, retry-safe).
  4. **Repair / reconciliation semantics for payment posting** (the 017
     boundary extended to cover payment outcomes).

**Not ratified:** deriving a v1 Payment Entry from `posTotal` (e.g. an
unallocated / on-account payment). That would fabricate tender data DP2 does not
own — implementing it without the gated work above is a STOP-and-raise.

---

## R2 — ERPNext Item resolution side (resolves 015 OQ-8-bis)

**Ratified: DP2-side item resolution.** DP2 resolves each sale line's ERPNext
Item reference **at work-item projection time** using the 013 `erpnext_item_map`
(confirmed-only invariant). A sale line that cannot resolve to an ERPNext Item →
the posting work-item **fails-to-DLQ in DP2 before being offered** to the
Connector.

**The Connector MUST NOT:**

- guess ERPNext Item identity;
- reach back into DP2 for item lookup;
- maintain a second copy of DP2 mapping truth.

**Implementation is GATED on a DP-012 contract correction/extension** that makes
the work-item self-sufficient for item identity — e.g. **`SaleLine.erpnextItemRef`**
or an equivalent resolved-ERPNext-Item payload — and corrects the stale
connector-side wording in the `SaleLine.tenantProductRef` description. The
contract's currently-stated connector-side resolution intent is **superseded by
this owner decision** (no longer a silent override — it is overridden here, on
the record). This correction/extension **gates ALL 015 implementation** (the
work-item cannot carry the resolved Item identity without it).

---

## R3 — Disabled ERPNext Item at posting time (resolves 015/013 OQ-5)

A **disabled / non-sales ERPNext Item at posting time fails-to-DLQ.** **No
silent fallback; no substitute item.** Operational sellability stays
DP2-authoritative (a disabled accounting Item does not make the product
unsellable at POS); divergence is a reconciliation case (017), never a silent
override of either side.

---

## R4 — Unknown-items vs unmapped-for-posting (resolves 015/013 OQ-6)

The inbound **unknown-items flow is NOT the same as unmapped-for-posting.** They
are **separate operational states** with separate triggers, actors, and
remedies. Resolving an unknown item creates a `tenant_product` that **still
requires a confirmed 013 mapping** before it can post. 015 never routes posting
failures into the unknown-items queue.

---

## R5 — Missing warehouse mapping (resolves 015 OQ-8)

If the **DP-014 warehouse mapping is absent** for a sale's store, the posting
**fails-to-DLQ** (`unmapped_store`-class reconciliation case). **Never guess the
ERPNext warehouse.**

---

## R6 — P-DP-008-LIVELOOP (re-affirmed, unchanged)

The standing owner decision (2026-06-05) is preserved: **P-DP-008-LIVELOOP is
NOT absorbed into DP-015.** It remains a **separate implementation/e2e
prerequisite slice** scoped under `specs/008-sales-transaction-capture/**`.
DP-015 defines **expectations and sequencing only** — it does not author, scope,
or restate the live-loop's tasks, requirements, or design.

---

## Sign-off

**SIGNED** — Ahmed Shaaban, 2026-06-05.

The 015 planning spec references this rider as the **ratified** resolution of
OQ-5 / OQ-6 / OQ-7 / OQ-8 / OQ-8-bis. Implementation slices verify against this
rider; deviating from it requires a new signed rider, never a silent override.
