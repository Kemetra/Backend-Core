# RT-334 — Hybrid ERP sale posting: plan refresh (2026-10-15)

**Status:** PROPOSAL / refresh. **Not a new decision.** Work Mode: Planning. Parent: RT-2.
**Plan of record:** RT-334 comment 11536 (2026-10-11). **Ratified:** comment 11538 (D1–D7, owner, 2026-10-11).
**What this document does:** it re-checks 11536 against the current `main` of both repos. For each ratified decision it gives a verdict: *unchanged*, *status update*, or *proposed amendment (needs owner ratification)*. It does not re-derive the A/B/C analysis. Sections 3–5 of 11536 (decision table, scenario trace, C deep-dive) remain the analysis of record.
**Posted:** as RT-334 comment 11878 (2026-10-15).
**Git:** this file is committed in Backend-Core under the owner's authorization, relayed verbatim: "commit and pr and merge auhtrized for all". Jira comments 11536, 11538 and 11878 remain the plan of record (D5). An Orchestrator `docs/research/` copy still needs separate authorization.

---

## 0. Baselines

| Repo | 11536 baseline | Now (`origin/main`, fetched 2026-10-15) |
| --- | --- | --- |
| Kemetra/Backend-Core | `d36fcbd` | `ddae78a7` |
| Kemetra/ERPNext-Connector | `d639746` | `65a002a` |
| ERPNext / Frappe (rt9 lab) | v15.110.0 | v15.110.0, unchanged. The Connector pin is still v15; RT-201 (v16) is To Do |

POS and Orchestrator were not re-inspected.

The Connector was read with `git show origin/main:<path>` only. Its local checkout has untracked files that were not touched.

**Runtime numbers:** none are new. No posting latency, throughput or backlog measurement exists yet: RT-317 is To Do. Every numeric cell in 11536 §3 stays **NOT VERIFIED**.

## 1. What changed since 11536, and why it matters to RT-334

### 1.1 F-1 (ack before commit) was fixed by RT-458. The fix is verified on the sale leg only

* **Code:** Connector `9cb465e` (RT-458, #70) adds `_commit_before_ack()` → `frappe.db.commit()` (`frappe_glue.py:337-353` at `65a002a`). It is called by every ack that reports an existing document:
  * `_ack_posted` `:363`;
  * `_ack_verify_transient` `:381`;
  * `_ack_reconciliation` `:401`.

  Rejections never commit, because the RT-48 savepoint already rolled them back.
* **Evidence:**
  * Pre-fix: RT-382 comment 11784 has the verdict **REPRODUCED**, with an aggravation: invoice-name reuse.
  * Post-fix: comment 11828 has the verdict **NOT REPRODUCED** on `ack500` and `pull500`, rt9, Connector `5f3b97e`. The lost-ack replay was observed at runtime for the first time.
* **The lab evidence still covers today's main:** `git log` shows no commits on the posting paths since the lab SHAs, in either repo. The paths checked were:
  * Connector `5f3b97e..65a002a`: `connector/posting`, `hooks.py`;
  * Backend-Core `36bb0c71..ddae78a7`: `erpnext-posting`, `erpnext-reconciliation`, worker `erpnext-posting` and `sales`, `packages/db/src`.

  So the 11828 runtime evidence applies to the posting code on current `main`.
* **Still open:**
  * Reversal/return leg at runtime: **BLOCKED**, because voiding needs an operator session from Clerk (11838).
  * Timeout path: **static only**.
  * Production deployment: **NOT VERIFIED**.
  * RT-382 is **In Review**, and the RT-20 gate is **not waived** (11800).
* **Effect on 11536:**
  * §2 ("the whole tick is one ERPNext transaction") is **superseded on main** for the posted/reconciliation/verify-transient paths. The tick is now N per-item transactions plus an uncommitted remainder.
  * A long tick, or one killed by the 300 s job timeout, now loses only in-flight, **un-acked** work. Backend-Core still holds that work `pending` and re-offers it. It is no longer a silent ERP gap.
  * The "F-1 sensitivity" row of the 11536 decision table changes for A and B, from "present / widened by larger ticks" to "closed on the sale leg; reversal leg and timeout not runtime-proven".

### 1.2 RT-456: the per-tenant feed-sequence lock serializes intent writes and **all** acks

* **Code:** Backend-Core `6bdfae76` (#750) takes `lockPostingFeedSequence(client, tenantId)`, a transaction-scoped advisory lock, before any sequence draw:
  * worker intent insert (`posting-requested.consumer.ts:56`);
  * repair (`erpnext-reconciliation.service.ts:268`);
  * re-resolve (`posting-re-resolution.service.ts:70`);
  * **every** `ackOutcome`, taken first, before the row lock (`erpnext-posting.service.ts:296`).
* **Matters for B:**
  * **B3, parallel Connector workers:** within one tenant, acks serialize on this lock. Parallel workers cannot speed up the ack leg for a single tenant. They could only overlap ERPNext submit time.
  * **B1, batch ack:** if one batch were applied in a single DB transaction, it would hold the tenant lock for the whole batch. That would block the worker's intent inserts for the tenant, and so delay sale processing. B1 must therefore apply elements in **per-element transactions**; see 1.3 for a second reason.
  * This is a design constraint for a future B issue. It is **not a defect**.
* **Measurement:** lock wait is not measured. It is added to the RT-317 list in §3.

### 1.3 RT-426: posting outcomes now drive Inventory Effect integration state, in the same transaction

* **Code:** Backend-Core `79cedc43` (#748). `ErpnextPostingService.applyPosted / applyRejected / applyTransient` moves linked Inventory Effects `pending → confirmed / rejected / reconciliation_required` in the **same transaction** as the posting-status update.
  * An illegal transition throws and **rolls back the posting update with it**.
  * Effects (`stock_movements`) are never inserted, updated or deleted by a transition.
* **Invariant check (static, code):** operational stock and availability are not gated by ERP posting. This matches the RT-334 invariant. **Runtime NOT VERIFIED.**
  * `inventory.service.ts:637-643` `LEFT JOIN`s `inventory_effect_integration` only to *project* `integration_state`. Its `WHERE` clause filters on store and product only.
  * A grep for state predicates under `apps/api/src` finds none on the integration table `i.state`. Every hit is a mapping-table `m.state = 'confirmed'`.
* **Matters for B1:** a batch ack in one transaction would let one element's illegal transition roll back every element. That is another reason for per-element transactions.
* **Matters for C:** it strengthens the NO-GO.
  * Every member's effects would stay `pending` until group close.
  * A partial-group failure would need per-member `rejected` / `reconciliation_required` transitions against **one** shared ERP document.
  * The effect → `erp_document_ref` link stops being 1:1.

### 1.4 RT-457: re-drive sweep and new failure signals (observability for A)

* **Code:** Backend-Core `cb0c3bfe` (#751). A scheduled sweep re-processes sales stranded before their posting intent and re-emits `erpnext.posting.requested` for dead-lettered sources, with a cap of 3. Each kind runs in batches of 100 per tick under a per-tenant try-lock.
* **New counters:** `worker_processing_failure_total` and `sale_redrive_total{reason}`.
* **Matters for RT-334:**
  * Under A, the gap "sale captured but never got a posting row" now has a recovery path and a metric. These are inputs to the pilot watch-list in §4.
  * RT-457 is In Review, and its runtime is **NOT VERIFIED**.

### 1.5 RT-195 is Done, but it did not answer the question D3 waits on

* **Verdict:** RT-195 comment 11561 rejected one app (Axentor `erpnext_egypt_compliance`) **for Retail Tower**. It states explicitly that it is not a legal-applicability or compliance statement.
* **Issuance owner:** it leaves the Egypt B2C **issuance owner unresolved** (§9.7, ref. 1196), across the device-side, ERP-side and hybrid models.
* **Effect on D3:** D3's reopen gate ("only … after RT-195") is now met on paper but has no answer in substance. The per-receipt fiscal-identity question that blocks C now sits with **RT-296** (Fiscal Requirement / Legal Evidence Registry + Egypt Country Pack source verification), which is To Do, and with the issuance-owner decision.
* **Side observation, runtime R in the RT-195 v16 lab, **not** a Retail Tower decision:**
  * ERPNext v16 POS Settings default to `invoice_type = "Sales Invoice"`, so `POS Invoice` is not the v16 default path.
  * This further weakens any transfer of native `POS Invoice Merge Log` consolidation (11536 §5.6), if v16 is adopted later.

### 1.6 Other main changes checked against the 11536 scenario trace (static; no change to the trace)

| Change | Scenario row | Result |
| --- | --- | --- |
| RT-448 tracking foundation (`e94ca29d`, additive, "no selling, no activation") | Batch/serial Item | Connector still **fails closed** on batch/serial Items (`frappe_glue.py:557-558, 906-927` at `65a002a`). Unchanged |
| RT-401 Store time zone (`0ca6fe79`) | Midnight / period close | No posting-path files touched. The Connector clamp is unchanged (`posting_time.py:11-21`). Its precondition is still **store TZ = ERPNext site TZ** (10312). A store whose TZ differs from the site TZ is now *configurable*, which makes that precondition easier to break. Noted as a risk; not tested |
| RT-383 admin shift-close read (`9fa13b5a`, `ccc8b142`) | Cash session close | Shift close *reads* posting status through the sync-ops read model (`shift-closes.service.ts:11`) and *emits* no posting (grep of `shift-closes`, `pos-shifts`). It is a consumer, not a trigger. The invariant "Cash Session End ≠ ERP posting" holds. Unchanged |
| RT-360 tender-line identity (`02260606`) | Mixed tender | Adds per-tender-line identity on the sale. It makes per-sale tender evidence richer, so it adds to C's tender-lineage cost. A/B unchanged |
| Connector constants | B0 | Unchanged:<br>• `_MAX_PAGES_PER_TICK = 20` (`poller.py:31`);<br>• default limit 100, max 500 (`transport.py:35-36`);<br>• cron `* * * * *` (`hooks.py:61-65`);<br>• cursor in Redis (`poller.py:298-302`).<br>Backend-Core: `POSTING_FEED_MAX_PAGE = 500` (`erpnext-posting.service.ts:36`), `POSTING_RETRY_BUDGET = 5` (`:47`), controller default 100 (`erpnext-posting.controller.ts:95`) |

## 2. Ratified decisions: verdicts

| ID | Ratified (11538) | Verdict now | Note |
| --- | --- | --- | --- |
| **D1** | Pilot/V1 = A (one SI per sale, async), GO | **Unchanged** | RT-456/457/458 all *strengthen* A's correctness. Nothing on main argues for B or C |
| **D2** | B DEFER; B0 unchanged; measure under RT-317 | **Unchanged + clarification (P2)** | Keep B0 constants frozen until **both** RT-382 is reconciled **and** RT-317 has measured. B1/B3 design constraints from §1.2–1.3 are recorded for any future B issue |
| **D3** | C NO-GO pilot/V1; reopen only via a new Planning issue after RT-195 | **Proposed amendment (P1)** | RT-195 is Done but did not answer the gating question (§1.5). Retarget the gate |
| **D4** | Bounded Connector Verification of F-1 before pilot financial traffic | **Status update: executed** | RT-382 REPRODUCED → RT-458 fix → re-verification NOT REPRODUCED on the sale leg. Open: reversal leg runtime (BLOCKED), timeout path (static), production deployment. **RT-20 gate stays with the owner** |
| **D5** | Plan of record = Jira comment; Orchestrator docs PR needs authorization | **Unchanged** | Refresh posted as Jira comment 11878. This file is a working copy |
| **D6** | Measurement folded into RT-317 | **Unchanged + proposed RT-317 addendum (P3)** | 11542 predates RT-456/458. See §3 |
| **D7** | One row in the ERP Integration baseline "Deferred / gated" table once ratified | **Not done** | Page 25264129 was read on 2026-10-15. Its "Deferred / gated" table has 7 rows and none covers hybrid posting, batch transport or consolidation. The page was last modified 2026-10-07, before ratification. Applying the row is an owner-authorized Confluence write; it was not performed |

### Proposed amendments (each needs owner ratification; none applied)

* **P1 — D3 reopen gate.**
  * Replace "after RT-195" with "after **RT-296** records the Egypt B2C legal sources **and** the owner decides the B2C issuance owner (1196)".
  * The other reopen triggers are unchanged:
    * a legal or fiscal mandate to aggregate;
    * ERP capacity still failing after B;
    * the owner accepts losing per-sale ERP traceability.
  * C stays NO-GO either way.
* **P2 — D2 clarification.** B0 constants (page 100, 20 pages/tick, 1-minute cron) stay frozen until RT-382 is reconciled and RT-317 has produced numbers. This is the same intent as 11542, which said to wait for an RT-382 verdict. That verdict has now come in, but the reversal leg is still open.
* **P3 — RT-317 addendum.** Add the items in §3 to the D6 measurement scope.

## 3. Measurement plan delta (proposed addendum to RT-317 comment 11542)

**Precondition:** measure only on a deployment that **includes RT-458** (Connector ≥ `9cb465e`) and **RT-456** (Backend-Core ≥ `6bdfae76`). Numbers taken without them describe a different transaction shape.

Add to 11542:

1. **Per-item ERPNext commit cost:** the added time per posted item from `_commit_before_ack`. It is now part of the per-item tick time.
2. **Tenant feed-lock wait:** wait time on `lockPostingFeedSequence` during acks and during intent inserts, at peak.
3. **Re-drive signals:** `sale_redrive_total{reason}` and `worker_processing_failure_total` rates across the outage and recovery run.
4. **Lost-ack replay count:** the count during the ERP-outage scenario. These are items committed in ERPNext but re-offered because the ack failed.

**Re-justified threshold (iii):** "tick duration above ~50% of the 300 s job timeout".

* Before RT-458 this was a **correctness** threshold: rollback of acked work.
* After RT-458 it is a **latency / wasted-work** threshold. A killed tick discards un-acked in-flight items, and re-offer delays them by at least one tick.
* It stays a valid trigger for B2 (feed N+1) and B4 (constants), not for correctness work.

Thresholds (i) and (ii) are unchanged. The **owner sets all numbers**.

## 4. Pilot posture (unchanged from 11536 §7, with the deltas applied)

* **Model:** A only. B0 constants unchanged (P2).
* **Watch-list:**
  * pending depth and oldest-pending age (sync-ops read model);
  * dead-letter count (`permanently_rejected` + `reconciliation_required`);
  * `sale_redrive_total{reason}` and `worker_processing_failure_total` (RT-457);
  * Inventory Effects stuck in `pending` (RT-426).
* **Reopen B** on a threshold: B2 first, then B1 (contract-first, per-element transactions, §1.2–1.3), then B3 (fencing; limited by the per-tenant ack lock).
* **Reopen C** only via a new Planning issue on the P1 gate.

## 5. Migration / backward compatibility (unchanged from 11536 §8, plus B1 constraints)

* **B1 gates gain:**
  * per-element DB transactions, so that neither the tenant feed lock nor an RT-426 illegal-transition rollback spans a batch;
  * per-element RT-458 commit before the batch response leaves the Connector.
* **C gates gain:** per-member Inventory Effect transitions against a shared document. Everything else is as in 11536.

## 6. Draft ADR framing (for the Orchestrator copy, only if D5 authorization is given; not written to `docs/adr/`)

> **ADR: Retail sale → ERPNext posting model is one Sales Invoice per Retail fact (async)**
> **Date:** 2026-10-11 (ratified; backfilled 2026-10-15). **Status:** accepted. **Deciders:** owner (RT-334 comment 11538).
> **Context:** Sales commit locally and in Backend-Core independently of ERP. Per-sale fiscal, tender and return lineage must survive. Exactly-once rests on per-sale provenance:
> * Posting Log;
> * SI unique `(rt_source_system, rt_external_id)`;
> * RT-331/378 verification;
> * RT-458 commit-before-ack.
>
> **Decision:** keep A. B (batch transport, one document per sale) is deferred to measured thresholds under RT-317. C (accounting consolidation) is rejected for pilot/V1.
> **Alternatives:**
> * **B:** cuts HTTP/SQL overhead only. It is bounded by the per-tenant feed lock and needs a contract change (B1).
> * **C:** breaks 1:1 provenance, return lineage, Inventory Effect transitions and per-receipt fiscal identity. Native ERPNext POS consolidation would make shift close a posting trigger and does not transfer.
>
> **Consequences:**
> * One SI, GL and SLE set per sale (more ERP rows).
> * Simple, per-sale recovery and reconciliation.
> * Throughput is bounded by per-item submit + commit + ack, so it must be measured before any tuning.

## 7. Open questions (carried forward; updated)

1. Real peak-hour sales per store, and the store count for year one. Still unanswered (RT-317).
2. Does Egyptian B2C issuance require a per-receipt ERP document, and who issues it? Moved from RT-195 to **RT-296** plus the issuance-owner decision (P1).
3. Per-item tick time on the target VM, now including the commit cost (§3).
4. Store TZ ≠ ERPNext site TZ, now configurable through RT-401. Does the clamp precondition (10312) need a guard? This is **outside RT-334 scope**: it is reported for the owner, with no action proposed here.
5. ERPNext v16 POS (RT-201). Relevant only if C is ever reopened.

## 8. Next safe action

The owner rules on **P1** (retarget D3's gate to RT-296 plus the issuance-owner decision). Every other item is unchanged, is already a status update, or is a mechanical follow-up:

* P2: a clarification;
* P3: the RT-317 addendum;
* D7: the Confluence row.

**Proposed D7 row** (for the owner to apply):

| Capability | Disposition |
| --- | --- |
| Hybrid ERP sale posting (batch transport / accounting consolidation) | DEFERRED (batch transport, until RT-317 thresholds) / REJECTED for pilot-V1 (consolidation). One Sales Invoice per Retail fact. RT-334 comments 11536/11538 |
