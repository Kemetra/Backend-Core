# Feature Specification: ERPNext Reconciliation & Repair

**Feature Branch**: `017-erpnext-reconciliation-and-repair`

**Created**: 2026-06-06

**Status**: Draft

**Input**: User description: "017"

> **Arc context (not a clarification — grounding).** 017 is the named **operational
> reconciliation surface** of the ERPNext integration arc (011→017). Its scope is
> fixed by two signed/shipped predecessors that deliberately deferred their
> *machinery* here:
>
> - **015 (posting) — the `015-DLQ-DRAIN` traceability stub** (015 execution-map):
>   *"017 reads 015's `permanently_rejected` rows + reconciliation flags, surfaces
>   the mismatch reports, and exposes the repair re-post workflow (a repair must
>   resolve to the SAME `document_ref` — idempotency holds across repair; never a
>   silent rewrite)."*
> - **014 (warehouse mapping) — the §8 014↔017 carve** (014 spec, gated by the
>   SIGNED 011-DR-STOCK-IMPACT §5): **014 defines** the mismatch-class *vocabulary*
>   and *what is compared*; **017 owns** the reconciliation **run** (scheduling,
>   cadence, on-demand triggers), the persisted **mismatch reports** + surfaces +
>   alerting, the **repair API** (re-post / re-map / re-sync / DLQ drain), and the
>   retry/DLQ posture.
>
> 017 therefore unifies *posting* reconciliation (015) and *stock* reconciliation
> (014) under one operational surface: **run → report → repair**, with idempotent
> repair as the load-bearing safety invariant. It introduces **no new ERPNext
> authority** (mapping/reconciliation is never authority handover — 011-DR-STOCK-IMPACT:
> DP2 is operational on-hand truth, ERPNext is valuation) and **no outbound ERPNext
> HTTP from DP2** (the connector, separate repo per ADR 0008, is the only
> ERPNext-calling component; any ERPNext-Bin fetch is the connector's machinery,
> behind the fixed 012 contract).

> **Authority wording clarified (RT-288, Inventory Planning Gate 1, recorded 2026-10-12).** In this feature, "DP2 is operational on-hand truth, ERPNext is valuation", "the 009 stock ledger", and, in this feature's `plan.md`, "DP2 stays operational on-hand authority" read as follows under the owner-approved Inventory Operations baseline of 2026-10-07, decisions 719–727 (Confluence RETAIL page 22544389):
>
> - Backend-Core owns *operational* inventory authority and Available To Sell (721, 722).
> - ERPNext Stock Ledger/Bin is the *financial/book* quantity authority, and ERPNext also owns valuation, COGS and
>   GL (719, 720).
> - 009 evolves into an Inventory Effects Journal plus operational projection (724, 726).
> - ERP Bin snapshots are evidence/book state, never an overwrite master (729, 782, 783).
>
> The rule that reconciliation never mutates the 009 ledger or the sale fact stays consistent with 782 and 783. Shipped code, data and history are unchanged (727). Whether and how sale effects are activated, and how ERP confirmation avoids double counting, is decided by Jira RT-289 (Gates 2+3).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator reviews the posting dead-letter backlog (Priority: P1) 🎯 MVP

A **Tenant Admin / finance operator** opens the reconciliation surface and sees,
per tenant (and filterable by store), the list of sales (and void/refund
reversals) whose ERPNext posting **permanently failed** — each with its mismatch
class (e.g. `unmapped_item`, `unmapped_store`, `unmapped_account`, `validation`,
`closed_period`), the originating sale/terminal-event reference and its
provenance (`sourceSystem` + `externalId`), the structured rejection reason, and
when it dead-lettered. The list is paginated, sortable, and groupable by class,
so the operator can triage the backlog and understand *why* money has not reached
ERPNext.

**Why this priority**: This is the MVP and the reason 017 exists. 015 already
*produces* the `permanently_rejected` rows and the `erpnext_posting_reconciliation_total`
signal, but nothing surfaces them to a human — the backlog is invisible. Making
the backlog **visible and triageable** is the minimum that delivers value: an
operator can now see open AR-blocking failures and act outside the system
(fix a mapping, raise a ticket) even before any in-system repair exists. It is
independently shippable on top of the already-merged 015 data.

**Independent Test**: Seed a tenant with a mix of `permanently_rejected` posting
rows (different classes) + healthy `posted`/`pending` rows; call the
review/list surface as the tenant admin; confirm only that tenant's dead-letters
appear, correctly classified, with provenance + reason, paginated/sortable/
groupable, and that `posted`/`pending` rows are **absent** from the backlog.

**Acceptance Scenarios**:

1. **Given** a tenant with three `permanently_rejected` posting rows (one
   `unmapped_item`, one `unmapped_store`, one `validation`) and two healthy rows,
   **When** the operator lists the reconciliation backlog, **Then** exactly the
   three dead-letters are returned, each carrying its class, originating
   reference, provenance, structured reason, and dead-letter timestamp; the two
   healthy rows are absent.
2. **Given** dead-letters across two tenants, **When** operator A lists the
   backlog, **Then** only tenant A's rows are visible (tenant isolation; a
   cross-tenant reference is non-disclosing).
3. **Given** a backlog larger than one page, **When** the operator pages and
   sorts/groups by class, **Then** results are stable, complete, and
   gap-detectable across pages.

---

### User Story 2 - Operator repairs a failed posting by re-posting it (Priority: P2)

Once the underlying cause is fixed (e.g. a 013 item mapping is now confirmed, a
014 store→warehouse mapping is set, or a `closed_period` has reopened), the
operator triggers a **repair** of a dead-lettered posting. The repair re-makes
the work-item eligible so the connector posts it to ERPNext on the next pull.
The repair is **idempotent**: a posting that eventually succeeds resolves to
**exactly one** ERPNext document — a re-post of an already-`posted` item echoes
the existing `document_ref` and never creates a second document or silently
rewrites a submitted one.

**Why this priority**: Visibility (US1) lets operators *see* the backlog; repair
lets them *clear* it inside the system, closing the loop without manual DB
surgery. It is P2 because US1 already delivers triage value, and repair builds
directly on the surfaced backlog + the already-proven 015 ack idempotency (O-3).

**Independent Test**: Take a `permanently_rejected` posting (`unmapped_item`),
confirm the missing 013 mapping out of band, trigger repair; confirm the row
becomes eligible again (re-offered on the connector feed), the connector ack
records a single `posted` outcome with one `document_ref`, and a second repair
of the now-`posted` row is a no-op that echoes the same `document_ref` (never a
second document).

**Acceptance Scenarios**:

1. **Given** an `unmapped_item` dead-letter whose mapping is now confirmed,
   **When** the operator triggers repair, **Then** the posting becomes eligible
   again and is offered to the connector; on a `posted` ack it carries exactly
   one `document_ref`.
2. **Given** a posting that already reached `posted`, **When** a repair is
   triggered for it, **Then** the repair is a non-destructive no-op that echoes
   the existing `document_ref` — never a second document, never a rewrite of the
   submitted document.
3. **Given** a repair triggered while the underlying cause is **still** unfixed
   (the mapping is still missing), **When** the posting is re-evaluated, **Then**
   it returns to the dead-letter backlog with its class intact (no silent
   success, no infinite churn), and the repair attempt is recorded.
4. **Given** a repair request, **When** it is recorded, **Then** the originating
   immutable sale fact (008) is **never** mutated — only posting/reconciliation
   state advances (§IX).

---

### User Story 3 - Operator runs a stock reconciliation and reviews mismatches (Priority: P3)

The operator triggers (on demand, or on a schedule) a **stock reconciliation
run** for a tenant/store: the system compares DP2's operational on-hand (009)
against ERPNext's valuation view for the mapped warehouse (014), and produces a
persisted **mismatch report** using 014's mismatch-class vocabulary (e.g.
`match`, `quantity_divergence`, `unmapped_store`, `unmapped_item`, `dp2_only`,
`erpnext_only`, `negative_balance_flagged`). The operator reviews the report,
filters by class, and can trigger a repair (re-map / re-sync) for actionable
classes. **DP2 remains operational on-hand truth**; a divergence is a
reconciliation case to surface, never a silent overwrite of either side.

> **v1 ERPNext-read scope (research R3):** the run reads the ERPNext valuation
> side through a **connector seam** (the connector, separate repo per ADR 0008,
> owns the actual ERPNext-Bin fetch behind the fixed 012 boundary — DP2 makes no
> outbound ERPNext HTTP). In v1 the seam is **stub-tolerant**: 017's DP2-side run,
> persisted report, and repair workflow ship and are testable with a
> recorded/stub ERPNext view; the **live** ERPNext read activates when the
> connector ships (a future `[GATED]` connector→DP2 view contract). An absent
> connector view is reported (`erpnext_only` / unavailable), never a run failure.

**Why this priority**: Stock reconciliation completes the unified surface (it is
the 014↔017 carve's "017 runs it" half) but depends on 014's mapping being live
and on the connector's ERPNext-Bin fetch machinery; it is the largest and most
externally-coupled story, so it is P3. US1+US2 (posting) deliver standalone value
without it.

**Independent Test**: With a mapped store, a seeded on-hand divergence, and a
stub/recorded ERPNext-Bin view, trigger a reconciliation run; confirm a persisted
mismatch report is produced with the correct 014 classes, scoped to the tenant,
and that a repair on an actionable class is recorded idempotently without
mutating the 009 ledger.

**Acceptance Scenarios**:

1. **Given** a mapped store with a known on-hand divergence, **When** a
   reconciliation run executes, **Then** a persisted report is produced
   classifying each line per 014's vocabulary, scoped to the tenant.
2. **Given** an `unmapped_store` result, **When** the operator reviews it,
   **Then** the report names the missing mapping (it never guesses a warehouse —
   the 011-DR-POSTING rider / 015 OQ-8: never guess a warehouse for an unmapped
   store) and offers a re-map repair path, not a silent default.
3. **Given** a reconciliation run, **When** it reads DP2 and ERPNext views,
   **Then** the 009 stock ledger and the 008 sale fact are **never** mutated by
   the run — reconciliation is read + report + (idempotent) repair only.

---

### Edge Cases

- **Repair of a row whose cause is unfixed** → the re-evaluation fails again and
  the row returns to the backlog with its class intact; the repair attempt is
  recorded (audit + attempt count), never an infinite silent retry loop.
- **Concurrent repairs of the same dead-letter** (two operators) → serialized;
  exactly one repair takes effect, the other is an idempotent no-op echoing the
  resolved state — never two ERPNext documents (the 015 O-3 invariant extends
  across repair).
- **Repair of an item the connector already `posted`** (a stale backlog view) →
  non-destructive no-op echoing the existing `document_ref`; never a rewrite of a
  submitted document.
- **A reconciliation run while a posting for the same sale is still `pending`** →
  the run reports the in-flight state, does not double-classify it as a mismatch,
  and does not race the posting loop.
- **Cross-tenant / out-of-scope reference** on any list/repair/report call →
  non-disclosing not-found (§II/§XII); no existence leak.
- **A `closed_period` rejection repaired after the period reopens** → repair
  succeeds and posts into the now-open period; a repair while still closed
  returns to the backlog unchanged.
- **DLQ growth / alerting** → the persisted backlog + the `erpnext_posting_reconciliation_total`
  signal feed an operator alert when the dead-letter depth crosses a threshold;
  the alert never carries PII / money / raw payloads.

## Requirements *(mandatory)*

### Functional Requirements

#### Reconciliation reporting (run → report)

- **FR-001**: System MUST surface, per tenant and filterable by store, the
  backlog of ERPNext posting **dead-letters** (015 `permanently_rejected` rows),
  each carrying its mismatch class, originating sale/terminal-event reference,
  provenance (`sourceSystem` + `externalId`), structured rejection reason, and
  dead-letter timestamp.
- **FR-002**: The backlog list MUST be paginated, sortable, groupable by mismatch
  class, and gap-detectable across pages (consistent with the 007/010 list
  conventions).
- **FR-003**: System MUST scope every reconciliation read to the caller's tenant;
  a cross-tenant or out-of-scope reference MUST be non-disclosing (§II/§XII).
- **FR-004**: System MUST be able to execute a **stock reconciliation run**
  (on-demand and/or scheduled) for a mapped (tenant, store) that compares DP2
  operational on-hand (009) against the ERPNext valuation view for the mapped
  warehouse (014), and persist the result as a **mismatch report**.
- **FR-005**: A mismatch report MUST classify each result using **014's**
  mismatch-class vocabulary (014 owns the definitions; 017 reports against them);
  017 MUST NOT invent a competing classification.
- **FR-006**: A reconciliation run MUST NOT guess a warehouse for an unmapped
  store — it MUST report `unmapped_store` and offer a re-map repair path (the
  011-DR-POSTING rider / 015 OQ-8 "never guess a warehouse"; distinct from 017's
  research R5, which is the on-demand-vs-scheduled decision).
- **FR-007**: System MUST persist reconciliation reports for later review +
  audit; a report is retained (not deleted) for the operability/audit horizon.
- **FR-008**: System MUST emit/track the dead-letter depth + reconciliation
  outcome signals (building on the 015 `erpnext_posting_reconciliation_total`
  family), so operators can alert on a growing backlog; signals MUST carry no
  PII / money / raw payloads.

#### Repair (the repair API)

- **FR-009**: System MUST expose a **repair** action for an actionable
  dead-letter: a posting repair re-makes the work-item eligible so the connector
  re-posts it on the next pull (re-post); a stock-mismatch repair offers re-map /
  re-sync for actionable classes.
- **FR-010**: A posting repair MUST be **idempotent** and preserve the 015 O-3
  invariant: a posting that eventually succeeds resolves to **exactly one**
  ERPNext document; a repair of an already-`posted` item echoes the existing
  `document_ref` and MUST NOT create a second document or rewrite the submitted
  document.
- **FR-011**: A repair whose underlying cause is **still unresolved** MUST return
  the item to the dead-letter backlog with its class intact (no silent success),
  and MUST record the repair attempt (audit + attempt tracking) — never an
  infinite silent retry.
- **FR-012**: Concurrent repairs of the same dead-letter MUST be serialized so at
  most one takes effect; the others MUST be idempotent no-ops echoing the
  resolved state.
- **FR-013**: A repair MUST NEVER mutate the originating immutable sale fact (008)
  or the 009 stock ledger — only posting/reconciliation state advances (§IX).
- **FR-014**: System MUST record a platform **`audit_events`** entry for every
  reconciliation run and every repair action (actor, tenant, store, target
  reference, outcome), with no raw payloads/PII. The write MUST be **atomic with
  the state write** — a repair/run that cannot also audit rolls back.
  **Implementation note (NOT the existing async pattern):** 013/014/015 use the
  async `@Auditable` interceptor (a post-response BullMQ enqueue) and the
  synchronous `insertAuditEvent` helper **forbids** use inside a transaction — so
  neither satisfies this atomicity requirement. 017 MUST instead do a **direct
  `INSERT INTO audit_events` on the same transaction client** as the state write
  (a new in-transaction audit path, not a reuse of `@Auditable`/`insertAuditEvent`).
  This is the audit-of-record; 017's own `erpnext_reconciliation_run` /
  `…_repair_attempt` rows are the **operational** history (the reviewable
  run/repair trail) — both written atomically, never one without the other.

#### Boundary & authority

- **FR-015**: DP2 MUST make **no outbound ERPNext HTTP call**; any ERPNext-side
  read (e.g. the ERPNext-Bin valuation view) is the connector's machinery behind
  the fixed 012 contract. 017 consumes the connector boundary; it does not
  re-implement it.
- **FR-016**: 017 MUST NOT change ERPNext authority: mapping/reconciliation is
  never authority handover (011-DR-STOCK-IMPACT — DP2 is operational on-hand
  truth, ERPNext is valuation). A divergence is a reconciliation case to surface,
  never a silent overwrite of either side.
- **FR-017**: 017 MUST consume the fixed 012 `posting-feed.yaml` (and any
  reconciliation/repair surface it adds) as a contract-first surface; the 012
  posting feed/ack contract is read-only input to 017.
- **FR-018**: 017 is **exclusively a human operator surface** (Tenant Admin) in
  v1 — every 017 surface (list backlog, run reconciliation, trigger repair) MUST
  authenticate as the dashboard human session scheme (consistent with
  007/013/014), NOT the machine connector bearer and NOT a POS device scheme.
  The connector never calls 017: a posting repair simply re-makes a 015
  work-item eligible, and the connector re-posts it via the **existing** 012
  feed/ack it already polls — so 017 needs no new machine-facing contract.
  (Decided 2026-06-06: human-operator-only; a connector-facing reconciliation
  surface, if ever needed, is a separate future arc.)
- **FR-019**: Repair MUST be bounded — a repaired posting that keeps failing
  transiently MUST honor the same retry budget posture 015 established
  (`POSTING_RETRY_BUDGET` → dead-letter), so repair cannot create an unbounded
  re-offer loop.

### Key Entities *(include if feature involves data)*

- **Reconciliation Run**: One execution of a reconciliation (posting backlog
  snapshot, or a stock compare for a (tenant, store)). Attributes: scope
  (tenant, optional store), kind (posting | stock), trigger (on-demand |
  scheduled), started/finished timestamps, summary counts by mismatch class,
  actor (for on-demand). Append-only; never rewritten.
- **Mismatch Report / Reconciliation Result**: The persisted classified output of
  a run — per originating reference (sale / terminal event / stock line), the
  014 mismatch class, the relevant DP2 vs ERPNext values (no money in metric
  labels; report rows may carry values for the operator), provenance, and current
  state (open | repaired | accepted). Retained for audit.
- **Repair Attempt**: A record of an operator-triggered repair of a dead-letter /
  mismatch — target reference, repair kind (re-post | re-map | re-sync | drain),
  actor, timestamp, outcome (eligible-again | still-failing | no-op-echo), and
  the resolved `document_ref` when a posting repair succeeds. Append-only;
  the audit trail of the repair workflow.
- **Posting Dead-Letter (consumed, owned by 015)**: The `permanently_rejected`
  `erpnext_posting_status` rows 017 reads — NOT re-modeled here; 017 reads + can
  transition them back toward eligibility via repair (the 015 state machine
  remains authoritative).
- **Store↔Warehouse Mapping (consumed, owned by 014)**: The `erpnext_warehouse_map`
  017 reads for stock reconciliation; 017 may offer a **re-map** repair that
  drives the existing 014 mapping admin flow — it does not own the mapping.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can see the complete posting dead-letter backlog for
  their tenant (correctly classified, with reason + provenance) in a single
  review surface — 100% of `permanently_rejected` rows are surfaced, 0%
  cross-tenant leakage.
- **SC-002**: An operator can clear a dead-letter whose cause is fixed by
  triggering one repair, with no manual database access required.
- **SC-003**: A posting that is repaired and succeeds results in **exactly one**
  ERPNext document — 0 duplicate documents and 0 silent rewrites across any
  number of repeated repair attempts (the idempotency invariant holds 100%).
- **SC-004**: A reconciliation run for a (tenant, store) produces a persisted,
  reviewable mismatch report classified entirely in 014's vocabulary, with the
  009 ledger and 008 sale fact unchanged by the run (verified before/after).
- **SC-005**: A repair of a still-broken item returns it to the backlog without
  loss and records the attempt — 0 silent successes and 0 unbounded retry loops.
- **SC-006**: Operators are alerted when the dead-letter backlog depth crosses a
  configurable threshold, with no PII / money / raw payloads in the alert.

## Assumptions

- **015 is shipped** (posting feed + ack + `permanently_rejected` state + the
  `erpnext_posting_reconciliation_total` signal) — 017 reads that state; it does
  not re-implement posting. (Verified: 015 closed on `main`, PRs #501–#505.)
- **014 is shipped** (`erpnext_warehouse_map` + the mismatch-class vocabulary) —
  017 reports/repairs against 014's definitions; it does not redefine them.
- **The connector** (separate repo, ADR 0008) is the only ERPNext-calling
  component and owns any ERPNext-Bin fetch; 017 consumes the 012 contract
  boundary and makes no outbound ERPNext HTTP from DP2.
- **The operator surface is the dashboard human session** (Tenant Admin),
  consistent with 007/013/014. **Decided (FR-018):** 017 is human-operator-only
  in v1; the connector never calls 017 (repair re-makes a 015 work-item eligible
  and the connector re-posts via the existing 012 feed/ack).
- **No new ERPNext authority** is introduced; reconciliation never overwrites
  either side silently (011-DR-STOCK-IMPACT, SIGNED).
- **Repair re-uses 015's idempotency (O-3) + retry-budget posture** rather than
  inventing a new primitive — a repaired posting flows back through the same
  feed/ack loop and the same `POSTING_RETRY_BUDGET` bound.
- **Scheduling cadence** for scheduled reconciliation runs uses an
  industry-standard operational default (e.g. nightly per tenant) unless a later
  decision sets otherwise; on-demand triggers are always available. The exact
  cadence is a planning-phase detail, not a scope clarification.
- **Persistence/retention** of runs + reports follows the 001 long-horizon audit
  posture (a dead-letter / report is retained, not deleted, for the
  reconciliation/audit surface).

## Dependencies

- **015-pos-sale-posting-to-erpnext** (CLOSED) — produces the posting dead-letters
  + signal 017 consumes; the `015-DLQ-DRAIN` stub is 017's posting half.
- **014-branch-inventory-reconciliation-and-warehouse-mapping** (planning merged;
  CRUD shipped) — owns the mapping + mismatch-class vocabulary; the §8 carve
  assigns the run/report/repair to 017.
- **009-inventory-stock-ledger** (CLOSED) — the DP2 operational on-hand the stock
  reconciliation compares.
- **012-erpnext-connector-contracts** (SHIPPED) — the fixed pull/feed + ack
  contract; read-only input. Any new reconciliation/repair contract surface 017
  adds is its own `[GATED]` contract slice.
- **011-DR-STOCK-IMPACT / 011-DR-POSTING (+ rider)** (SIGNED) — the authority +
  failure-posture decisions 017 must not contradict.
