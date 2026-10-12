# Feature Specification: ERPNext live stock-view (Bin) read contract

**Feature Branch**: `019-erpnext-stock-view-contract`

**Created**: 2026-06-07

**Status**: Draft

**Input**: User description: "ERPNext live stock-view (Bin) read contract"

> **What this is.** 019 is the contract that makes the 017 stock reconciliation's
> ERPNext-Bin side *real*. Today 017 runs its stock reconciliation over a
> stub-tolerant seam (`EMPTY_BIN_VIEW`) — every DP2-on-hand item classes as
> `dp2_only` because nothing reports the live ERPNext Bin quantity. 019 is the
> 017-deferred **`017-STOCK-VIEW-CONTRACT`**, named by 018 as the future arc
> handoff **019**: the **`[GATED]` DP2 ↔ connector OpenAPI contract** by which the
> ERPNext live on-hand (Bin) quantities flow connector→DP2, keyed by the 014
> `erpnext_warehouse_map`, consumed by the 017 reconciliation run.
>
> **What this is NOT.** Per the **signed 014 stock-impact decision** and **014
> OQ-1**: DP2 is the operational on-hand authority; ERPNext owns valuation; a
> **read-DOWN of valuation is REJECTED** and there is **NO standing Bin mirror in
> DP2**. 019 is therefore a **READ-ONLY, RUN-SCOPED VIEW contract** — point-in-time
> evidence the connector reports for a specific reconciliation run, never a
> continuously-synced copy of ERPNext stock.
>
> **Authority wording clarified (RT-288, Inventory Planning Gate 1, recorded 2026-10-12).** In this feature, "DP2 is the operational on-hand authority; ERPNext owns valuation" and, in this feature's `plan.md`, "DP2 stays on-hand authority" read as follows under the owner-approved Inventory Operations baseline of 2026-10-07, decisions 719–727 (Confluence RETAIL page 22544389):
>
> - Backend-Core owns *operational* inventory authority and Available To Sell (721, 722).
> - ERPNext Stock Ledger/Bin is the *financial/book* quantity authority, and ERPNext also owns valuation, COGS and
>   GL (719, 720).
> - 009 evolves into an Inventory Effects Journal plus operational projection (724, 726).
> - ERP Bin snapshots are evidence/book state, never an overwrite master (729, 782, 783).
>
> The run-scoped Bin view with no standing mirror stays consistent with 729. Shipped code, data and history are unchanged (727). Whether and how sale effects are activated, and how ERP confirmation avoids double counting, is decided by Jira RT-289 (Gates 2+3).
>
> **Direction (a repo invariant, not a choice).** DP2 **makes NO outbound HTTP**
> (012). DP2 **exposes** endpoints; the **connector calls them**. So even though
> the Bin data semantically originates in ERPNext (the connector *provides* it),
> in HTTP terms the **connector is the client and DP2 is the server** — exactly
> like 012's `connectorPullPostings` / `connectorAckOutcome`. 019 mirrors that
> pull/report idiom: DP2 exposes a feed of *which* `(tenant, store)` bin views are
> wanted; the connector fetches live ERPNext Bin and reports the snapshot back.
>
> **This is a CONTRACT spec.** Its eventual gated artifact is a YAML under
> `packages/contracts/openapi/erpnext-connector/` (sibling to `posting-feed.yaml`).
> This planning pass authors NO gated file — the contract is described in prose;
> the YAML + its conformance test land in their own `[GATED]` slice.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connector reports a store's live ERPNext Bin view for a reconciliation run (Priority: P1)

A tenant's connector (a dedicated, tenant-scoped, revocable machine principal,
018 identity) needs to tell DP2 the **current ERPNext Bin on-hand quantities**
for a store that has an active 014 `stock` warehouse mapping, so that the 017
reconciliation run can compare them against DP2's 009 operational on-hand and
classify each item in 014's mismatch vocabulary. The connector pulls the set of
**wanted bin-view requests** from DP2 (a cursor feed of `(tenant, store)` targets
with their mapped ERPNext warehouse reference), reads live ERPNext Bin for the
mapped warehouse, and **reports** the per-item Bin quantities back to DP2 against
the originating request. DP2 makes the reported snapshot available to the 017 run
as run-scoped evidence — it stores no standing copy.

**Why this priority**: This is the entire reason 019 exists — it is the single
leg that turns 017's `dp2_only`-only reconciliation into a true cross-system
comparison. Without it, no other story has anything to operate on. It is the MVP.

**Independent Test**: With a seeded tenant + store + active 014 `stock` mapping +
a `connectorBearer` principal, the connector can (a) pull a feed page listing that
store as a wanted bin-view target carrying its `erpnextWarehouseRef`, and (b)
report a Bin-view snapshot of `{ erpnextItemRef → quantity }` entries against the
request; DP2 accepts it (idempotently) and a 017 run consuming the snapshot
classifies items into `match` / `quantity_divergence` / `dp2_only` / `erpnext_only`
correctly. Fully testable end-to-end without a real ERPNext (the connector side is
stubbed by the test).

**Acceptance Scenarios**:

1. **Given** a store with an active 014 `stock` mapping and pending reconciliation
   intent, **When** the connector pulls the bin-view feed after an empty cursor,
   **Then** the response lists the store as a wanted target carrying its
   `erpnextWarehouseRef` and an opaque advanced cursor.
2. **Given** a pulled bin-view request, **When** the connector reports a snapshot
   of per-item Bin quantities with a required `Idempotency-Key`, **Then** DP2
   records the snapshot for the run and returns the recorded projection; a replay
   of the same key + same body returns the prior response without double-applying.
3. **Given** a reported snapshot, **When** a 017 reconciliation run consumes it,
   **Then** items present in both ledgers within tolerance class `match`, quantity
   deltas class `quantity_divergence`, DP2-only items class `dp2_only`, and
   Bin-only items class `erpnext_only` (014 §6.2 vocabulary, exact-match v1).
4. **Given** every monetary or quantity field, **When** any value is emitted on
   the wire, **Then** quantities are exact-decimal strings (never floats) and no
   valuation/cost field appears anywhere (014 OQ-1).

---

### User Story 2 - Cross-tenant / out-of-scope reads are refused non-disclosingly (Priority: P2)

A connector principal scoped to tenant A must never be able to pull a bin-view
request for, or report a snapshot against, a store owned by tenant B — and must
not be able to learn whether such a store or request exists. Scope is taken from
the authenticated connector principal only; any scope identifier supplied in the
query or body is ignored or rejected.

**Why this priority**: Tenant isolation is the highest-severity SaaS bug class
(§II). The contract is worthless if it leaks across tenants, but it is layered on
top of US1 (you need the happy path before you can prove the negative path), so it
is P2.

**Independent Test**: With two tenants each with a store + mapping + connector
principal, a tenant-A principal pulling the feed sees only tenant-A targets; a
tenant-A principal reporting against a tenant-B request reference (or a forged
body scope) receives the same non-disclosing `not_found` (404-class) as a
genuinely-absent reference, with no existence signal in any response or error
shape.

**Acceptance Scenarios**:

1. **Given** a tenant-A connector principal, **When** it pulls the bin-view feed,
   **Then** only tenant-A bin-view requests appear; tenant-B requests never do.
2. **Given** a tenant-A principal, **When** it reports a snapshot against a
   tenant-B (or non-existent) request reference, **Then** the response is a
   non-disclosing `not_found`, identical for cross-tenant and absent references.
3. **Given** a report body carrying a `tenant_id` / `store_id` / warehouse scope,
   **When** the request is validated, **Then** the body-supplied scope is rejected
   (strict boundary, §XII); the principal's scope is authoritative.

---

### User Story 3 - Run correlation, staleness, and gap detection (Priority: P3)

When a bin-view request is older than DP2 can serve (e.g. the run it belonged to
has been superseded or the retained horizon has passed), the connector is told to
re-baseline rather than acting on stale intent. A reported snapshot carries enough
correlation (the request/run reference + the warehouse reference + a connector
read timestamp) for DP2 to bind it to the correct reconciliation run and for the
017 run's persisted result `detail` to remain an honest point-in-time record of
what was compared.

**Why this priority**: Robustness and observability around the feed cursor and
run binding. The happy path (US1) and isolation (US2) deliver value first; this
hardens delayed/duplicate/stale interactions. P3.

**Independent Test**: Presenting a cursor older than the retained horizon returns
`snapshot_required`; reporting a snapshot against a superseded/stale request
returns a deterministic, non-double-applying outcome (rejected or recorded-as-stale
per the resolved policy); the recorded projection carries the run/request
correlation and the connector read timestamp.

**Acceptance Scenarios**:

1. **Given** a stale/unservable `since` cursor on the feed, **When** the connector
   pulls, **Then** it receives `snapshot_required` (re-baseline directive), exactly
   as 012's pull feed does.
2. **Given** a reported snapshot, **When** DP2 records it, **Then** the recorded
   projection includes the request/run correlation reference, the
   `erpnextWarehouseRef`, and the connector-reported read timestamp (preserved as
   received; never used as a security clock — §X).
3. **Given** a duplicate report of the same snapshot for the same request, **When**
   replayed with the same `Idempotency-Key`, **Then** the prior recorded outcome is
   returned with no second application.

---

### Edge Cases

- **Store with no active 014 `stock` mapping**: it is never offered as a bin-view
  target (the feed is keyed off active mappings); 017 independently classes such a
  store `unmapped_store`. 019 does not invent the mapping.
- **Item present in ERPNext Bin but with no confirmed 013 `erpnext_item_map`**:
  the connector reports it by `erpnextItemRef`; DP2 cannot translate it to a
  `tenant_product_ref`, so the 017 run classes it `erpnext_only` (its existing
  behavior for a Bin entry with no DP2 counterpart). 019 never auto-creates a map.
- **Empty / absent Bin snapshot** (connector has nothing to report, or warehouse
  is empty): a valid, non-failing report; the 017 run then classes every DP2
  on-hand item `dp2_only` (identical to today's `EMPTY_BIN_VIEW` behavior).
- **Negative DP2 on-hand** (009 allow-and-flag): classed `negative_balance_flagged`
  by 017 *before* the quantity compare, regardless of the reported Bin value (014
  §6.3); 019 carries the Bin value but never overrides the operational reality.
- **Connector reports a quantity for an item DP2 didn't ask about**: accepted into
  the snapshot; surfaces as `erpnext_only` if it has no DP2 on-hand.
- **Revoked / disabled connector principal** (018 lifecycle): a generic 401 on
  both feed and report, non-disclosing.
- **Quantity precision**: ERPNext stock UOM may carry fractional quantities;
  quantities are exact-decimal strings, never floats; no silent rounding (§III).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The contract MUST define a connector-facing endpoint by which the
  connector PULLS a cursor-paginated, ordered, idempotent, gap-detectable feed of
  **wanted bin-view requests** for its authenticated tenant scope, each carrying
  the `(tenant-implicit, storeId, erpnextWarehouseRef, requestRef)` needed to read
  the right ERPNext warehouse. (Mirrors `connectorPullPostings`.)
- **FR-002**: The contract MUST define a connector-facing endpoint by which the
  connector REPORTS a per-item ERPNext-Bin on-hand snapshot back to DP2 against a
  pulled `requestRef`, carrying a list of `{ erpnextItemRef, quantity }` entries
  plus a connector-reported read timestamp. (Mirrors `connectorAckOutcome`.)
- **FR-003**: Both endpoints MUST be namespaced under `/api/connector/v1/erpnext`
  and MUST be authenticated by the opaque, revocable, tenant-scoped **machine**
  `connectorBearer` scheme — NOT the POS `clerkJwt` device scheme and NOT a human
  `cookieAuth` session.
- **FR-004**: The report endpoint MUST require an `Idempotency-Key` header and MUST
  replay deterministically: the same key + same body returns the prior recorded
  response with no second application; the same key with a materially different
  body returns `409 idempotency_key_conflict`. (Reuses the existing
  `IdempotencyInterceptor`; no new primitive — §XI.)
- **FR-005**: All scope (tenant, store, warehouse) MUST resolve from the
  authenticated connector principal; scope identifiers supplied in the query or
  body MUST be ignored or rejected (§XII strict boundary, `additionalProperties:
  false`).
- **FR-006**: Cross-tenant / out-of-scope `requestRef` or feed cursor access MUST
  return the same non-disclosing `not_found` (404-class) response as a
  genuinely-absent reference — no existence leak in any response or error shape
  (§II / §XII).
- **FR-007**: A stale / unservable feed cursor MUST return `snapshot_required`
  (409), directing the connector to re-baseline by pulling from the start.
  (Mirrors 012's pull feed.)
- **FR-008**: Bin quantities MUST be exact-decimal strings (never floats); the
  contract MUST NOT include any valuation, cost, or price field anywhere (014
  OQ-1 — ERPNext owns valuation, DP2 never reads it down).
- **FR-009**: The reported snapshot MUST be **run-scoped evidence** — DP2 MUST NOT
  persist a standing, continuously-synced Bin-quantity table/column (014 OQ-1, the
  rejected read-down look-alike). The point-in-time Bin value MAY be recorded in
  the 017 reconciliation `result.detail` (already its behavior) as audit of what
  was compared, but never as an authoritative DP2 stock balance.
- **FR-010**: The connector MUST report items by `erpnextItemRef` (the
  ERPNext-terms item identity, mirroring 012's `ErpnextItemRef` doctype+name shape);
  the translation from `erpnextItemRef` to a DP2 `tenant_product_ref` MUST be
  **DP2-side**, via the confirmed 013 `erpnext_item_map`, behind the contract. The
  connector MUST stay ignorant of DP2 product IDs (version-independence, 012 O-6).
- **FR-011**: The contract MUST be version-independent (012 O-6): it speaks in
  Retail-Tower terms (`storeId`, `erpnextWarehouseRef`, `erpnextItemRef`,
  `quantity`, `requestRef`) and MUST NOT name ERPNext doctype field internals. An
  ERPNext v15→v16 change alters the connector's internal mapping, not this
  DP2-facing contract.
- **FR-012**: DP2 MUST make NO outbound ERPNext HTTP for this contract — DP2
  EXPOSES the two endpoints; the connector CALLS them (the 012 invariant).
- **FR-013**: Request/response bodies MUST be explicit wire projections (§IV) — no
  raw DB shape, no credentials, no `tenant_id` echoed (implicit in the principal
  scope), and no field that would let the connector mutate DP2 state beyond
  recording its reported snapshot.
- **FR-014**: The error vocabulary MUST reuse the canonical `Error` envelope shared
  by `auth.openapi.yaml` / `outbox.openapi.yaml` / `pos-sales/sales.yaml` /
  `posting-feed.yaml`. The closed `error.code` set on this surface is
  `validation_failure`, `snapshot_required`, `idempotency_key_conflict`,
  `not_found`, `system_failure`, plus the generic 401 refusal.
- **FR-015**: The contract MUST have a stable `operationId` per endpoint (renames
  are breaking, §IV) and MUST be exercised by an OpenAPI structural conformance
  test loaded with an explicit `dir` (the non-recursive loader convention used by
  `posting-feed.yaml`).
- **FR-016**: The reported snapshot MUST carry a connector-reported read timestamp,
  preserved as received and NEVER used as a security clock; DP2's own server clock
  stamps the recorded-at time (§X).
- **FR-017**: This spec MUST NOT modify the 008 sale fact, the 009 ledger, the 014
  mapping, or the 013 item-map; it is a read/report contract feeding the 017 run
  only (§IX — reconciled, never merged; authorities unchanged).
- **FR-018**: The 017 run-lifecycle change required to consume a connector-fed
  (asynchronous) view — today `fetchBinView` is synchronous over `EMPTY_BIN_VIEW`,
  a connector-fed view is request→await→report — MUST be described as a SEPARATE
  future 017-rewiring slice (precedent: `017-RECON-WIRING`) and is OUT OF SCOPE for
  019. 019 authors the contract and the DP2-side feed/report surface design only.

### Key Entities *(include if feature involves data)*

- **Bin-view request (feed item)**: A wanted ERPNext-Bin read DP2 advertises to the
  connector, for one `(tenant-implicit, store)` with an active 014 `stock` mapping.
  Carries a stable opaque `requestRef`, the `storeId`, the `erpnextWarehouseRef`
  (014 mapping, opaque DP2-terms string, no FK), and the opaque advanced cursor.
  Bound to a reconciliation run (correlation). Derived/projected, not a new
  standing entity owned by 019.
- **Bin-view snapshot (report)**: The connector's point-in-time report against a
  `requestRef`: a list of `{ erpnextItemRef, quantity }` entries + a
  connector-reported read timestamp. Run-scoped evidence; NOT a persisted standing
  Bin mirror (FR-009). Its per-item values may be recorded in the 017 result
  `detail`.
- **`erpnextItemRef`**: ERPNext-terms item identity (doctype fixed to `Item` +
  opaque `name`), mirroring 012's `ErpnextItemRef`. Translated DP2-side to
  `tenant_product_ref` via confirmed 013 `erpnext_item_map`.
- **`erpnextWarehouseRef`**: The 014 `erpnext_warehouse_map.erpnext_warehouse_ref`
  string for the store's active `stock` mapping — opaque, no FK, version-independent.
- **Recorded outcome projection**: DP2's `toBody()` confirmation of a recorded
  snapshot report — `requestRef`, server `recordedAt`, accepted entry count, and
  idempotent-replay marker. No raw DB shape.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A 017 stock reconciliation run consuming a connector-reported Bin
  snapshot classifies 100% of compared items into exactly one 014 §6.2 class, with
  `match` / `quantity_divergence` / `dp2_only` / `erpnext_only` distinguished
  correctly on a seeded fixture (vs today's 100%-`dp2_only` floor).
- **SC-002**: 100% of cross-tenant / out-of-scope feed-pull and report attempts
  return the canonical non-disclosing `not_found` (or 401) with zero existence
  leakage, proven by a cross-tenant sweep test.
- **SC-003**: A duplicate snapshot report with the same `Idempotency-Key` and body
  produces exactly one recorded outcome and zero additional side effects (idempotent
  replay), proven by a retry test.
- **SC-004**: Zero floating-point and zero valuation/cost fields appear anywhere in
  the contract (static check of the YAML in the gated slice), upholding the signed
  014 OQ-1 no-mirror / no-valuation decision.
- **SC-005**: The contract's OpenAPI structural conformance test passes (every
  operation has a stable `operationId`, an explicit `connectorBearer` security
  section, strict request/response schemas, and the closed error set), matching the
  `posting-feed.yaml` conformance bar.
- **SC-006**: DP2 makes zero outbound ERPNext/connector HTTP calls for this feature
  (verified by the absence of any outbound client in the design + the connector-as-
  client direction), preserving the 012 invariant.

## Assumptions

- **A-1**: ERPNext major version is still UNCONFIRMED (014 A-1); the contract is
  deliberately version-independent (FR-011), so this does not block authoring.
- **A-2**: The connector repo (`Retail-Tower-ERP-Next-Connector`) is the live
  reader of ERPNext Bin; it is actively built but the live Bin read is not yet
  exercised end-to-end. 019 authors the DP2-facing contract + surface; cross-system
  live validation against a staging ERPNext remains an external prerequisite (the
  same gate carried by 017's `017-STOCK-VIEW-CONTRACT` deferral).
- **A-3**: The 018 connector identity (machine `connectorBearer` principal,
  registration-linked, revocable) is the auth substrate; 019 reuses it and
  introduces no new auth primitive.
- **A-4**: The 014 `erpnext_warehouse_map` (active `stock` mapping) and the 013
  `erpnext_item_map` (confirmed) are the keying authorities; 019 reads them,
  modifies neither.
- **A-5**: The 017 `ErpnextBinView` seam (`fetchBinView(tenantId, storeId) →
  Map<tenant_product_ref, qty>`) is the consumption point; 019's reported snapshot
  is what eventually backs a non-empty implementation of that seam. The seam's
  current `EMPTY_BIN_VIEW` stub stays valid until the 017-rewiring slice (FR-018).
- **A-6**: No perf environment exists (005/008/009/010/015/017 precedent); any perf
  target for the feed/report is report-only, not gating.
- **A-7**: The request/report (pull-then-report) idiom is preferred over an
  unsolicited connector push because 014 specifies the Bin view is "fetched
  on-demand at reconcile time"; a run-correlated request/report keeps the data
  on-demand and run-scoped, avoiding the standing-snapshot drift that a free-running
  push would create (which slides toward the forbidden mirror).

## Clarifications

### Session 2026-06-07

- **Q1 — Direction: does DP2 pull Bin from the connector, or does the connector
  report Bin to DP2?**
  **A**: The connector is the HTTP **client**; DP2 is the HTTP **server** and makes
  NO outbound HTTP. DP2 EXPOSES the two endpoints (a wanted-bin-view feed + a
  snapshot report); the connector CALLS them. *Rationale*: The 012 contract states
  this as a flat invariant ("DP2 makes NO outbound HTTP calls — it EXPOSES these
  endpoints, the connector CALLS them"). "Provider of data" ≠ "HTTP server";
  conflating them is the trap. This is not a coin-flip — it is fixed by the repo
  invariant. (Resolved into the header, US1, FR-001/FR-002/FR-012.)

- **Q2 — Shape: a request/report pair (mirroring 012 pull+ack) or an unsolicited
  connector push of bin snapshots?**
  **A**: A request/report pair — DP2 exposes a feed the connector pulls to learn
  which `(tenant, store)` bin views are wanted, then the connector POSTs the live
  snapshot back. *Rationale*: 014 says the Bin view is "fetched on-demand by 017 at
  reconcile time." A request/report is genuinely on-demand and run-correlated; a
  free-running push forces DP2 to hold a latest-snapshot, which slides toward the
  014-OQ-1-forbidden mirror. Mirrors `connectorPullPostings` + `connectorAckOutcome`
  for symmetry. (Resolved into US1, FR-001/FR-002, A-7.)

- **Q3 — Does 019 persist the reported Bin quantities anywhere standing?**
  **A**: No standing Bin mirror. The reported snapshot is run-scoped evidence;
  point-in-time values may be recorded in the 017 `result.detail` (already its
  behavior) for audit, but no continuously-synced `erpnext_bin` table/column is
  created. *Rationale*: A persistent always-synced Bin copy is exactly the
  read-down look-alike the signed 014 stock-impact decision (OQ-1) rejects. (Resolved
  into FR-009, SC-004, the header.)

- **Q4 — Item keying: by DP2 `tenant_product_ref` or by ERPNext `erpnextItemRef`?**
  **A**: The connector reports by `erpnextItemRef` (doctype+name, mirroring 012);
  DP2 translates to `tenant_product_ref` via the confirmed 013 `erpnext_item_map`,
  DP2-side, behind the contract. *Rationale*: The connector must stay ignorant of
  DP2 product IDs for version-independence (012 O-6); the 017 seam keys by
  `tenant_product_ref`, so the translation is a DP2-side responsibility. (Resolved
  into FR-010, the `erpnextItemRef` entity, the unmapped-item edge case.)

- **Q5 — The 017 run completes synchronously today; a connector-fed view is
  async. Does 019 redesign the run lifecycle?**
  **A**: No. 019 is contract-only. The run-lifecycle change (synchronous
  `EMPTY_BIN_VIEW` → request→await→report) is named as a SEPARATE future
  017-rewiring slice (precedent: `017-RECON-WIRING`) and is OUT OF SCOPE here.
  *Rationale*: 019's charter is the wire contract + DP2-facing surface; conflating
  it with the worker run-lifecycle rewire would violate the thin-slice rule and
  the no-implement boundary of this planning pass. (Resolved into FR-018, scope
  notes throughout.)

> No residual `[NEEDS CLARIFICATION]` markers remain. One external prerequisite
> (live cross-system validation against a staging ERPNext via the connector repo)
> is acknowledged in A-2 — it is a gate on *exercising* the contract live, not an
> ambiguity in *authoring* it, and is handled exactly as 017 handled the same gate.
