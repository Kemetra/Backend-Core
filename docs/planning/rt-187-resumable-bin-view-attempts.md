# RT-187 — Resumable multi-window bin-view attempts: decision record

> **Status:** decision record (Work Mode: **Planning**, contract decision). Follow-up of RT-176.
> **Jira holds the live status.** This file records the 2026-10-17 planning pass and is not a status tracker.
>
> No production code, OpenAPI, migration, package or CI change. §5 describes a **dormant** resumable-attempt
> design. It is not applied. A later issue applies it to `packages/contracts/openapi/**` and the runtimes only if
> the trigger in §4 fires, and only under that issue's own `[GATED]` approval.
>
> **Sources:** Jira RT-187 (this item), RT-176 (connector paged Bin read, Done), RT-174/RT-175 (stock-view 1.2,
> Done), RT-179 (scheduled stock-run sweep, Done), RT-189 and RT-428 (open, related).
> Backend-Core `origin/main` **`5215d79`**, read-only:
>
> * `packages/contracts/openapi/erpnext-connector/stock-view.yaml` (`1.3.0-draft`)
> * `apps/api/src/catalog/erpnext-bin-view/{erpnext-bin-view.service.ts,dto/snapshot-report.dto.ts}`
> * `apps/worker/src/erpnext-reconciliation/{reconciliation-run.processor.ts,stock-run-sweep.repository.ts}`
> * `packages/db/src/helpers/stock-reconciliation-run.ts`
> * `packages/db/src/schema/catalog/erpnext-reconciliation.ts`
> * `apps/api/src/idempotency/idempotency.interceptor.ts`
>
> ERPNext-Connector `main` **`391b717`**, read-only: `connector/bin_view/{worker,poller,retry,frappe_glue}.py`.
> POS, Admin-Console and Orchestrator were **not inspected**. No runtime was exercised.
>
> **No pilot data exists yet.** The first-store pilot (RT-20) has not run, so warehouse Bin sizes and DP2 report
> latency are **NOT VERIFIED**. The rationale below uses the bounds that `main` enforces in code, and §4 names the
> pilot evidence that would reopen the decision.

---

## 1. The question

RT-176 runs each paged bin-view attempt as a Frappe long-queue job with a time budget of
`maxWindows × 30 s + 60 s`, capped at 1200 s. Inside the job, an `AttemptDeadline` stops the attempt cleanly before
any window call that could overrun that budget. Every retry is a **fresh** attempt: a new `attemptRef`, starting
again at window 0. After `MAX_RETRY_TICKS` (5) failed retries, about 25 minutes at the 5-minute cron, the request is
abandoned with `bin_view.report.incomplete_abandoned`, reason `attempt_deadline`.

The ticket asks:

1. Is a report that cannot finish inside one attempt realistic for the pilot?
2. If yes, should we pick (a) a resumable-attempt contract, (b) larger windows / fewer windows, or (c) accept the
   limit and alert?
3. For (a): attempt lifetime, continuation semantics, consistency under the original `readAt`, idempotency,
   ERPNext changes mid-attempt, failure and expiry, and tenant isolation.

## 2. What `main` does today (facts)

### 2.1 Backend-Core already accepts a continuation

The window rules in `stock-view.yaml` (`binViewReportSnapshot`, "MULTI-WINDOW REPORTS (v1.2)") and
`ErpnextBinViewService.reportSnapshot` (`planAttempt` / `extendsAttempt`) have **no attempt lifetime and no
process affinity**:

| Rule on `main` | Consequence for resume |
| --- | --- |
| `windowSeq k` is accepted once windows `0..k-1` of the same `attemptRef` are recorded, with the same `readAt` and no repeated `erpnextItemRef`. | Any process can send window `k` of an existing attempt at any later time, and Backend-Core records it. |
| An incomplete attempt stays in `run.summary.bin_view_report` until a new window 0 supersedes it or the run leaves `running`. | Attempt state lasts as long as the run, which can be indefinitely (§2.4). |
| A recorded window with identical content replays (O-3, `recordedWindowReplay`). Different content → 409 `idempotency_key_conflict`. | A resender that lost its acknowledgements can resend from window 0 of the same attempt. Recorded windows replay and the first unrecorded window is accepted. This holds even after the 72 h `Idempotency-Key` replay TTL, because the O-3 replay compares content in the service. |
| All checks run under the run row's `FOR UPDATE`. | Two resenders of one attempt serialize. They cannot both append the same window. |

So the Backend-Core half of "continue an `attemptRef` from another process or a later tick" **already exists**.
The ticket's statement that 1.2.0 "does not define" continuation is true only in the sense that the contract never
says so in words, and never bounds it in time.

### 2.2 The connector never resumes

`worker.process_paged_request` reads the whole warehouse once, holds it in memory, splits it into windows and sends
them in order. On any failure, the poller's retry calls `process_request` again: a new `readAt`, a new
`attemptRef`, from window 0. Nothing is persisted between attempts except the request itself, in the retry set.
A window 0 under a new `attemptRef` supersedes the incomplete attempt in Backend-Core.

The "resume" gap is therefore **connector-side persistence**. It is not a missing Backend-Core primitive.

### 2.3 The budget runs out only when DP2 or ERPNext is degraded

* Backend-Core advertises `itemWindow.maxWindows = BIN_VIEW_MAX_WINDOWS = 20` and `maxItems = 500`
  (`snapshot-report.dto.ts`). The most a paged read can carry is 10,000 Bin items.
* The connector budget is `20 × 30 + 60 = 660 s`, well under the 1200 s cap. The "`maxWindows` > ~38" case in the
  ticket is **unreachable** while Backend-Core advertises 20.
* `AttemptDeadline.check` refuses a window when `elapsed + 30 s > 660 s`, and `elapsed` includes the ERPNext Bin
  read, which completes before window 0 is sent (§2.2). The deadline can therefore fire for two reasons:
  * **slow DP2:** the window calls average close to 30 s each. 30 s is also the transport timeout, so at that
    latency calls would already be failing as transport errors;
  * **slow ERPNext read:** the keyset Bin read (at most 21 pages of ≤ 500 rows for one warehouse) takes more than
    about 630 s. Then window 0 is refused even when every DP2 call is fast. The read is not timed on `main`, so
    its duration is NOT VERIFIED. A read that slow means ERPNext or its database is degraded.
* A warehouse above 10,000 items is refused deterministically with `bin_view.window.limit_exceeded`. Nothing is
  reported and nothing is retried. That is the **capacity** limit. It is separate from the deadline, and resuming
  would not help with it.

`attempt_deadline` abandonment therefore needs either a DP2 that is **persistently** near its transport timeout or
an ERPNext Bin read that **persistently** takes more than about 10 minutes. Both are degraded systems, and the
operational answer is an alert, not a protocol. A resumable attempt would not help the slow-read case at all: the
read happens before any window, so a resume has nothing to continue. D4 therefore alerts on `deadline_reached` with
its `window_seq`. A `window_seq` of 0 points at the ERPNext read, and a higher one points at DP2. §4 adds a
read-duration trigger.

### 2.4 Gap found: an abandoned run stays `running`

No code on `main` moves a stock run out of `running` unless its report completes. `grep` of `apps/api/src`,
`apps/worker/src` and `packages/db/src` found no timeout or expiry of `erpnext_reconciliation_run` rows.

When the connector abandons a request, for any reason (`attempt_deadline`, retry set full, retry budget spent):

* the run stays `running` indefinitely, with `finished_at` NULL;
* the RT-179 scheduled sweep skips that store from then on (`skipped_running`,
  `stock-run-sweep.repository.ts:142-151`), so **scheduled stock reconciliation stops for that store**. An on-demand
  run does **not** clear this. `createStockReconciliationRun` only inserts another row, and the sweep keeps skipping
  while any run of the store is `running`. An on-demand run gives a one-off reconciliation, but the abandoned row
  blocks every later scheduled run until something makes it terminal (D5);
* the run stays in the bin-view feed, but the connector cursor has already passed it, so nothing offers it again
  until a `snapshot_required` re-baseline.

This affects options (a), (b) and (c) alike, and resuming would not remove it, since a resumed attempt can also be
abandoned. It is the real failure-and-expiry question of this ticket. See D5.

### 2.5 Gap found: windows of one attempt are not bound to one warehouse

`ErpnextBinViewService.lockRun` re-resolves the store's **currently active** `stock` warehouse map on every window,
and `buildStored` writes that current `erpnext_warehouse_ref` without comparing it with the stored report's.
Suppose the store is remapped (old map retired, new one active) between window `k` and window `k+1` of one attempt.
Window `k+1` is then accepted, and the whole report, including windows read from the old warehouse, is labelled
with the new warehouse and reconciled against it. The same happens to a **fresh** window 0 after a remap. The
connector's retry set keeps the originally pulled request, including the old `erpnextWarehouseRef`, and the report
body carries no warehouse. A retry therefore reads the old warehouse, and Backend-Core labels the result with the new
one. On `main` the in-attempt case is narrow (at most 660 s), but the retry case spans the connector's whole retry
horizon (about 25 min). A resumable attempt would widen both. §5.1 adds the binding rule, and F1 proposes it on
`main`.

### 2.6 Staleness grows with completion delay

The 017 processor compares the Bin snapshot (as of `readAt`) with DP2 on-hand **read at compare time**
(`reconciliation-run.processor.ts:178-192`, `SUM(stock_movements.quantity)` with no time bound). Every sale or
movement between `readAt` and completion is a potential false `quantity_divergence`. Today that gap is at most about
660 s. A resumable attempt that completes hours later under the original `readAt` would widen it without bound. Any
resume design therefore needs an attempt lifetime (D3). Pending-aware comparison is RT-428's scope, not this
ticket's.

## 3. Decisions

Each decision lists the options, the one marked **Recommended**, and the selection.

### D1 — Is the case realistic for the pilot?

| Option | For | Against |
| --- | --- | --- |
| **A. Not on `main`'s current bounds; reopen on pilot evidence (Recommended)** | §2.3: 20 windows give a 660 s budget, and the deadline fires only when DP2 is near its transport timeout or the ERPNext Bin read takes more than about 10 minutes. The size limit (10,000 items) is a separate, deterministic refusal. | No witnessed pilot data. Warehouse sizes, DP2 latency and Bin-read duration are NOT VERIFIED. |
| B. Realistic; build (a) now | Removes the limit before the pilot. | Builds a cross-repo protocol (contract, runtime, connector persistence) for a case `main` cannot currently reach, without evidence. |

**Selected: A** — recommended option, chosen by the coordinator under the owner's standing delegation of
2026-10-17; owner may revisit.

### D2 — Which option: (a) resumable, (b) window sizing, (c) accept and alert?

| Option | For | Against |
| --- | --- | --- |
| (a) Resumable attempts now | Survives a slow DP2 across ticks. | Needs connector snapshot persistence (Redis or a DocType), a Backend-Core attempt TTL, contract text, tests on both sides and an ADR, all for an unreached case. It also widens the staleness gap (§2.6). |
| (b) Larger `maxItems` / smaller `maxWindows` | Fewer calls per attempt. | `maxItems` is capped at 500 by the contract schema (`BinViewSnapshotReport.entries.maxItems`) and by RT-189's stored-report size concern. A smaller `maxWindows` only lowers capacity, and neither change helps a slow DP2. |
| **(c) Accept the limit, alert on abandonment, and keep (a) specified but dormant (Recommended)** | Matches §2.3. The alert covers the one realistic cause (a DP2 near outage). §5 keeps (a) ready to build, and the trigger in §4 says when. | A store whose report genuinely needs more than 660 s cannot reconcile until (a) is built. Today that case does not exist. |

**Selected: (c)** — recommended option, chosen by the coordinator under the owner's standing delegation of
2026-10-17; owner may revisit.

Consequences:

* No stock-view contract change now. `stock-view.yaml` stays `1.3.0-draft`.
* No ADR in Orchestrator. The ticket requires one only if (a) is chosen; §5 marks where it would go.
* The alerting (D4) and the run-expiry follow-up (D5) are the actionable output.

### D3 — Attempt lifetime (dormant (a) design; answers the ticket's TTL question)

| Option | For | Against |
| --- | --- | --- |
| **A. Backend-Core TTL from window 0's server-clock `recordedAt`: 40 minutes (Recommended)** | Server clock, so it is a real security and expiry clock (§X: `readAt` is connector-reported and is never a security clock). Five 5-minute retry ticks (25 min) plus one full 660 s attempt is about 36 min, so 40 min covers the connector's whole retry horizon, including a resume on the last retry tick. It bounds the §2.6 staleness gap. | One new constant, `BIN_VIEW_ATTEMPT_TTL_SECONDS`. |
| B. TTL from `readAt` | Measures data age directly. | `readAt` is untrusted (§X / FR-016). A skewed connector clock would expire attempts early or never. |
| C. No TTL (today) | Nothing to build. | A resume could complete days later under a stale `readAt`. |

**Selected: A** (applies only if (a) is activated) — recommended option, chosen by the coordinator under the
owner's standing delegation of 2026-10-17; owner may revisit.

### D4 — Alerting for (c)

| Option | For | Against |
| --- | --- | --- |
| **A. Alert on the connector's existing events, plus a Backend-Core stranded-run signal (Recommended)** | The connector already logs `bin_view.report.incomplete_abandoned` (with `reason`), `bin_view.report.deadline_reached` and `bin_view.window.limit_exceeded`. Backend-Core is the only side that sees a run stuck in `running` (§2.4), whatever the connector did. The `window_seq` on `deadline_reached` separates a slow ERPNext read (0) from a slow DP2 (> 0). | Two places to watch. |
| B. Connector events only | No Backend-Core change. | Misses a stranded run caused by a dead connector, which emits nothing. |

**Selected: A** — recommended option, chosen by the coordinator under the owner's standing delegation of
2026-10-17; owner may revisit.

Proposed shape, for the follow-up issues in §6:

* **Connector (ERPNext-Connector repo):** a Sentry/Datadog monitor on `incomplete_abandoned` (any reason) and
  `limit_exceeded`, at error level. This is allowlisted fields only (`request_ref`, `reason`, `window_seq`, counts),
  under the RT-629 observability contract. It is configuration of the existing log events.
* **Backend-Core:** a worker gauge `erpnext_stock_run_stranded` counting `kind='stock'` runs that have been in
  `running` for longer than the D5 run TTL. It carries no labels except a bounded outcome, following the RT-629
  label rules (no tenant or store ids). It becomes zero once D5 expires such runs, and its transitions are then
  counted as `erpnext_stock_run_expired_total`.

### D5 — Run lifetime and expiry (gap §2.4; applies under every option)

| Option | For | Against |
| --- | --- | --- |
| **A. Backend-Core expires a stock run left in `running` past a run TTL: `running → failed` (Recommended)** | Needs no migration: `status` already admits `failed`, and the `finished_at` CHECK holds when it is set. The reason goes into `summary.failure` (for example `{"reason": "bin_view_not_completed", "attemptRef": …, "windowsRecorded": …}`), with no PII or quantities. The sweep stops skipping the store, and the feed stops offering the run (it only offers `running`). The partial `bin_view_report` is left as evidence. | A worker sweep and an audit row to build. It changes the run lifecycle, so it needs its own Implementation issue. |
| B. Leave runs `running`; operators trigger on demand | Nothing to build. | Scheduled reconciliation silently stops per store (`skipped_running`). |
| C. Connector reports "abandoned" to Backend-Core | The run ends at once. | A new contract operation, and still nothing if the connector is dead. |

**Selected: A** — recommended option, chosen by the coordinator under the owner's standing delegation of
2026-10-17; owner may revisit.

Proposed rule: run TTL = **2 hours** from `started_at`. That is four times the connector's retry horizon (about
25 min) plus margin, and far shorter than the scheduled period. The rule needs:

* a per-tenant sweep under the tenant GUC, the same posture as RT-179;
* `FOR UPDATE` on the run, re-checking `status='running'` so it never races a completing report (the report path
  holds the same lock);
* an `audit_events` row with actor label `system:erpnext-stock-run-expiry`.

A report that arrives after expiry gets today's non-disclosing 404 (`BinViewNotFoundError`, run no longer
`running`), which the connector already treats as terminal (`bin_view.report.stale`). This does not change the
contract.

### D6 — Tenant isolation (unchanged; confirmed for (a) and D5)

* Attempt state lives only in `erpnext_reconciliation_run.summary` under tenant RLS (`FORCE`). `requestRef` resolves
  only under the connector principal's tenant GUC, so a foreign `requestRef` or `attemptRef` reads nothing and
  returns a non-disclosing 404.
* `attemptRef` is scoped to one run's stored report. It is never looked up on its own, so knowing another tenant's
  `attemptRef` addresses nothing.
* A dormant (a) connector snapshot is keyed by `(requestRef, attemptRef)` in the connector site's own cache. It
  holds item codes, exact-decimal quantities and UOMs only: no valuation (014 OQ-1), no PII, no credentials.
* The D5 sweep follows RT-179's RLS posture. Its only platform read is tenant ids, and every write runs under one
  tenant's GUC.

## 4. Trigger to activate the dormant (a) design

Reopen D1/D2 and build §5 when pilot evidence shows **any** of the following:

1. `bin_view.report.deadline_reached` at `window_seq` **> 0**, ending in `incomplete_abandoned` with
   `reason=attempt_deadline`, at least once per week for one store. Only a deadline after window 0 shows DP2-side
   slowness that resuming can bridge;
2. a mapped pilot warehouse holding more than **5,000** Bin items (half the 10,000 capacity). Raising
   `BIN_VIEW_MAX_WINDOWS` above about 38 would then push the budget to the 1200 s cap;
3. a DP2 `binViewReportSnapshot` p95 latency above **10 s** on pilot hardware.

A `deadline_reached` at `window_seq` 0 (§2.3, slow ERPNext read) is **not** a trigger for (a), because resuming cannot
shorten a read that happens before any window. It is a trigger for a separate connector-side fix: time the read,
and either split the read budget from the window budget or raise the read allowance. That fix would be planned on
its own issue.

Below these, (c) stands.

## 5. Dormant (a) design — resumable attempt contract (not applied)

This is the specification a later `[GATED]` issue would apply. It would go into `stock-view.yaml` as **1.4.0-draft**
(additive, text plus one rule), with an ADR in Orchestrator recording the choice of (a).

### 5.1 Continuation semantics (no new token)

* **Multi-process continuation (normative).** The contract text would state that the windows of one attempt
  **may** be sent by different processes and in different ticks, within the attempt lifetime (5.3).
* **No continuation token.** The continuation identity is the existing tuple
  `(requestRef, attemptRef, next windowSeq, readAt)`, **bound to the warehouse mapping the request was pulled
  under** (§2.5). The binding goes into `requestRef` itself, so it also covers window 0 and needs no new body field:
  * Backend-Core derives `requestRef = deterministicId(NS, "<runId>:<warehouseMapId>:0")` (today `"<runId>:0"`).
    `lockRun` re-derives the ref from the store's **currently active** map. After a remap, a request pulled under
    the old map no longer resolves and gets today's non-disclosing 404 `not_found` on **every** window, window 0
    included. The connector already treats that as terminal (`bin_view.report.stale`), so it never reports old-
    warehouse rows under the new mapping. `requestRef` stays opaque, so the wire shape does not change; only its
    contract description is extended to say it identifies the run **and** its warehouse mapping.
  * There is no re-pull path, and none is needed. A remapped run can no longer complete, so the remap ends it at
    once. The warehouse-map retire path (`erpnext-warehouse-map.service.ts`, `SET retired_at = now()`), in the same
    transaction and under `FOR UPDATE` on the run, moves the store's in-flight `running` stock run to `failed` with
    `summary.failure = {"reason": "warehouse_remapped"}` and an audit row. The RT-179 sweep is then not blocked
    (`skipped_running`) for the 2 h D5 window, and the next scheduled or on-demand run is created under the new
    mapping, with a new `requestRef` that the feed offers. D5 stays as the backstop.
  * The connector keys its persisted snapshot by `(requestRef, attemptRef)`. The warehouse is implied by
    `requestRef`.
  * Cutover: on deploy, every in-flight `requestRef` changes once. Those reports get 404, and their runs are expired
    by D5. To avoid that, `lockRun` may also accept the legacy `"<runId>:0"` derivation for runs started before the
    deploy, but only while the run's map is unchanged. The implementing issue chooses between the two.
* **Finding the position.** The connector keeps its own acknowledgement log (the highest acknowledged `windowSeq`)
  next to the snapshot. If that log is lost, it resends from window 0 of the **same** attempt. Recorded windows
  replay (O-3) and the first unrecorded window is accepted (§2.1). `RecordedBinView.windowsRecorded` confirms the
  position. **No status or query endpoint is added.**

### 5.2 Consistency under the original `readAt`

* A continuation sends the **persisted rows of the original read**. It never re-reads ERPNext for the remaining
  windows. Mixing reads would produce a snapshot from no single instant, and the rule that every window carries the
  attempt's `readAt` would then be false. Backend-Core keeps enforcing the same `readAt` (409
  `window_sequence_conflict` on mismatch). It cannot detect a re-read with the old `readAt`, so the no-re-read rule
  is a normative connector obligation, covered by a connector test.
* **ERPNext changes mid-attempt** are deliberately not reflected. The attempt is a point-in-time view at `readAt`.
  Changes after `readAt` show up in the next run. The staleness this adds against DP2 on-hand, which is read at
  compare time (§2.6), is bounded by the attempt TTL (5.3).
* The connector persists the snapshot (Redis, under the same key family as the retry set) with a TTL **≤** the
  Backend-Core attempt TTL, so it never resends an attempt that Backend-Core has already expired.

### 5.3 Attempt lifetime and expiry (D3)

* `BIN_VIEW_ATTEMPT_TTL_SECONDS = 2400`, measured from the server-clock `recordedAt` of the attempt's window 0. The
  window 0 `recordedAt` is already stored, in `windows[0].recordedAt`, so no new field is needed.
* Window `k > 0` of an attempt past its TTL → 409 `window_sequence_conflict`, deterministic and with no side effects.
  This **reuses the existing code**. The connector on `main` already treats a `window_sequence_conflict` at
  `window_seq ≠ 0` as "superseded or stale, retry with a fresh attempt" (`poller._attempt`), so the expiry needs no
  new error code and no connector error-handling change.
* A window 0 under a new `attemptRef` still supersedes, expired or not. A replay of a recorded window of an expired
  attempt still replays (O-3 stays deterministic).
* Run expiry (D5) bounds every attempt from above.

### 5.4 Idempotency

* Unchanged per-window key `binview-{requestRef}-{attemptRef}-w{windowSeq}`. A resumed window is byte-identical to
  its first send, because it comes from the persisted rows and the quantities are already quantized strings. It
  therefore replays rather than conflicting.
* After the 72 h interceptor TTL, the service-level O-3 replay still decides, and the 40 min attempt TTL means a
  continuation never gets near 72 h.

### 5.5 Failure behaviour (summary)

| Situation | Backend-Core | Connector |
| --- | --- | --- |
| Resume within TTL | Accepts the next window, or replays a recorded one | Continues from its acknowledgement log |
| Resume after attempt TTL | 409 `window_sequence_conflict` | Fresh attempt from window 0 (existing handling) |
| Run expired (D5) | Non-disclosing 404 | `bin_view.report.stale`, terminal (existing) |
| Snapshot lost on the connector | — | Fresh attempt (supersede), as on `main` today |
| Store remapped mid-attempt or before a retry | The remap fails the in-flight run (`warehouse_remapped`); later reports get 404 `not_found` (§5.1) | Terminal (`bin_view.report.stale`). The next run uses the new mapping |
| Capacity above `maxWindows × maxItems` | — | `limit_exceeded`, nothing reported (unchanged) |

### 5.6 Tests the activating issue would need

* Backend-Core: a window `k` within TTL from a "second process" is accepted; past TTL it gets 409; replay of a
  recorded window past TTL still replays; supersede past TTL works; no change for a v1 report.
* Connector: resume continues after the last acknowledged window with the original `readAt` and rows (no Bin re-read,
  asserted with the fake reader's call count); a lost acknowledgement log resends from window 0 of the same attempt
  and recovers; a snapshot past its TTL forces a fresh attempt.
* Both sides: after a remap between windows `k` and `k+1`, window `k+1` and a fresh window 0 under the old
  `requestRef` both get 404. Nothing is recorded under the new mapping until a new run's request is pulled.

## 6. Proposed follow-up work (not created)

| # | Repo | Work Mode | Scope | Gate |
| --- | --- | --- | --- | --- |
| F1 | Backend-Core | Implementation | D5 stock-run expiry sweep (`running → failed`, `summary.failure`, audit row) and the D4 `erpnext_stock_run_stranded` gauge plus `erpnext_stock_run_expired_total` counter. Also the §2.5 warehouse binding on `main`: derive `requestRef` from `(run, active warehouse map)`, so that a request pulled before a remap gets 404 on every window, and have the remap fail the store's in-flight `running` stock run (`warehouse_remapped`) in the same transaction, so the sweep is not blocked until D5. No migration and no wire-shape change, but the `requestRef` description in `stock-view.yaml` changes under `[GATED]`. | Run-lifecycle change: owner approval on the issue. |
| F2 | ERPNext-Connector | Implementation (config) | D4 monitors on `incomplete_abandoned` and `limit_exceeded`, within the RT-629 allowlist. | Owner (observability destinations are already approved). |
| F3 | Backend-Core + Connector | Planning → Implementation | Activate §5 only if a §4 trigger fires: ADR in Orchestrator, `stock-view.yaml` 1.4.0-draft, runtime TTL, connector snapshot persistence. | `[GATED]` contract plus a cross-repo issue. |

## 7. Risks and assumptions

* **No pilot data.** D1 rests on code-enforced bounds (20 × 500, a 660 s budget, a 30 s transport timeout). The ERPNext Bin-read duration is not measured on `main`. If the
  pilot shows large warehouses or slow DP2 calls, §4 reopens the decision.
* **Bin-read consistency across keyset pages** is a connector assumption that is not bench-verified (REPEATABLE READ,
  `frappe_glue.py`). It is unchanged by this decision and already a recorded connector follow-up.
* **§2.4 is a live gap on `main`.** Until F1 ships, an abandoned request silently stops scheduled reconciliation for
  its store. An on-demand run gives a one-off reconciliation, but it does not clear the block (§2.4).
* The 2 h run TTL and the 40 min attempt TTL are proposals. F1 and F3 confirm them against the cron cadence in force
  when they are built.
* §2.1 describes behaviour that `main`'s window rules and tests imply. A resume across processes has not been
  exercised as a runtime scenario.
