# Decision Record: ERPNext Posting Model

**Decision ID**: 011-DR-POSTING
**Feature**: 011-erpnext-pos-reference-and-integration-foundation
**Status**: **SIGNED**
**Gates**: specs **012**, **013**, **015**, **017** (per spec §9)
**Owner / signer**: Ahmed Shaaban
**Created**: 2026-06-03
**Signed**: 2026-06-03

> **SIGNED.** A decision has been recorded below. The specs this record gates
> (012/013/015/017) may proceed through their own Spec-Kit planning chains and
> Agent OS gates, consistent with this decision. Any deviation from it is a
> STOP-and-raise condition, not a silent override.

---

## Question to be decided

**How does a Data-Pulse-2 sale fact (008: `sales` + `sale_lines`) get posted into ERPNext, and what is the system of record for each posted artifact?**

Sub-questions the signed decision MUST answer:

1. **Posting target shape** — does a DP2 sale post as an ERPNext **Sales Invoice**, a **POS Invoice**, or a draft-then-submit pair? What ERPNext doctype(s) are written?
2. **Trigger & timing** — is posting synchronous on sale capture, or asynchronous via the connector (queue/outbox)? What is the posting `businessDate` vs `occurredAt` mapping (Constitution §X)?
3. **Idempotency & provenance** — how does a re-posted sale (retry) resolve to the same ERPNext document? (`sourceSystem + externalId`, payload hash — §XI/§IX.)
4. **System of record** — DP2 remains source of truth for the sale fact (§IX). What does ERPNext own that DP2 does not (GL entries)? Confirm DP2 never rewrites a posted ERPNext document silently.
5. **Failure posture** — what happens when ERPNext rejects a posting (validation, period closed)? Reconciliation/repair path (ties to 017).
6. **Void / refund** — how do 008 terminal events (void/refund) map to ERPNext credit notes / return invoices?

## Constraints any decision MUST respect

- DP2 stays the source of truth for the sale fact (§IX). ERPNext receives a posting; it is not the origin.
- Money is exact-decimal (§III, no floats). Posted amounts must reconcile to the DP2 sale totals; DP2 MUST NOT silently rewrite POS-received totals.
- The trust boundary holds: posting flows DP2 → connector → ERPNext only.

## Decision

A DP2 sale is posted to ERPNext as follows. Each numbered item answers the
correspondingly-numbered sub-question above.

1. **Posting target shape — one submitted `Sales Invoice` per DP2 sale (1:1).**

   > **Amended 2026-09-29 (RT-10) by [011-DR-POSTING-A1](./posting-decision-amendment-2026-09-29-rt10.md).**
   > **Superseded for POS sale settlement:** every instruction in this section to post
   > a separate **Payment Entry** for a POS sale, including "MUST NOT present Sales
   > Invoice only as final", now reads as **a Sales Invoice that carries its own
   > payments**. That is the final target. An invoice *without* payments stays the interim
   > mode for tender-unknown sales. The ban on deriving tender from `posTotal` and
   > every other rule here are unchanged.

   Each DP2 sale (008 `sales` + `sale_lines`) posts as exactly one **submitted**
   ERPNext **Sales Invoice**, with its tender posted as the associated **Payment
   Entry**. We do **not** use the ERPNext `POS Invoice` + `POS Closing`
   consolidation doctype for v1, and we do **not** use a draft-then-submit
   two-phase flow. Rationale: a 1:1 mapping gives immediate GL impact and the
   cleanest DP2-sale ↔ ERPNext-document reconciliation (no many-to-one
   consolidation to unwind), matching DP2's one-sale-one-immutable-fact model
   (§IX). Higher document volume in ERPNext is accepted as the cost of clean
   provenance. *(Stock lines on the Sales Invoice are governed by the
   [stock-impact decision](./stock-impact-decision-record.md) — this record does
   not decide whether the invoice itself decrements stock.)*

2. **Trigger & timing — asynchronous, via outbox + connector worker.** Sale
   capture writes the DP2 sale fact **and** an outbox event on the request path;
   a worker hands the event to the connector, which posts to ERPNext **off** the
   request path. Sale capture is **never** coupled to ERPNext availability or
   latency (ERPNext down/slow MUST NOT fail or block a DP2 sale). This reuses the
   shipped 008 outbox + BullMQ worker pattern and honours the §IV trust boundary
   (DP2 → connector → ERPNext only). Synchronous inline posting is **rejected**.

   **Posting date — driven by `businessDate`/`occurredAt`, not post-time.** The
   ERPNext `posting_date` is the sale's business/occurred date (when it happened
   at the terminal), **not** when the connector posted it. A delayed or
   offline-synced sale therefore lands in the **correct fiscal period**. Security
   clocks remain server clocks (§X); offline/delayed events are expected and MUST
   NOT be silently rewritten or rejected (§X).

3. **Idempotency & provenance — `sourceSystem + externalId` + payload hash
   (constrained by §XI/§IX, not a free choice).** A re-posted sale (retry)
   resolves to the **same** ERPNext document via the DP2 sale's
   `sourceSystem + externalId` carried as a stable external reference on the
   ERPNext side, plus a canonical-payload hash for provenance. The same pair
   resolves to the same posted document across retries; re-posting is idempotent
   and creates no duplicate invoice.

4. **System of record — DP2 owns the sale fact; ERPNext owns the GL.** DP2
   remains the source of truth for the sale (§IX). ERPNext owns what DP2
   deliberately does **not** model: the **General Ledger entries** (and the
   accounting view) produced by the submitted Sales Invoice + Payment Entry
   (for a POS sale: the Sales Invoice carrying its own payments — amended by
   [011-DR-POSTING-A1](./posting-decision-amendment-2026-09-29-rt10.md)). The
   connector **MUST NOT** silently rewrite a posted ERPNext document, and DP2
   **MUST NOT** silently rewrite POS-received sale totals (§III); posted amounts
   reconcile to the DP2 sale totals.

5. **Failure posture — retry-with-backoff → DLQ + reconciliation flag; DP2 fact
   untouched.** Transient ERPNext errors retry with backoff. Persistent
   rejections (validation, closed accounting period, unmapped item) move to a
   **dead-letter queue** and raise a **reconciliation flag** that the
   [017 sync-ops & repair API](./../follow-up-spec-map.md) surfaces. The DP2 sale
   fact is **never** mutated or rolled back on a posting failure — the sale is
   valid; only its posting needs repair. Silent failure (log-and-drop) is
   **rejected** (no silent swallow).

6. **Void / refund — new reversing document, never an edit of the original.** A
   DP2 008 terminal event (void or refund) posts as a **new** ERPNext reversing
   document — a **credit note / return Sales Invoice** that reverses the original
   — and **never** cancels/amends/edits the original submitted invoice. This
   matches both ERPNext's immutable-submitted-document model and DP2's
   append-only / immutable-history posture (§IX): the original sale and its
   reversal both remain as audit truth.

### Downstream obligations this decision imposes

- **012** (connector contracts): the DP2 ↔ connector contract MUST carry the
  sale payload + `sourceSystem`/`externalId`/payload-hash + `businessDate`, and
  model the post/reverse operations and the DLQ/repair surface.
- **013** (product master): item identity/mapping MUST be resolvable so a sale
  line posts against a real ERPNext Item (a posting fails-to-DLQ if not).
- **015** (sale posting): implements exactly this — async Sales-Invoice posting
  with the reconciliation/repair path.
- **017** (sync-ops/repair): owns the DLQ drain + reconciliation-flag surface.

## Sign-off

| Field | Value |
|---|---|
| Status | **SIGNED** |
| Signer | Ahmed Shaaban |
| Date | 2026-06-03 |
