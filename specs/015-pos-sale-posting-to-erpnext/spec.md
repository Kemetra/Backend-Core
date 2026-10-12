# Feature Specification: POS Sale Posting to ERPNext

**Feature ID**: 015
**Short name**: pos-sale-posting-to-erpnext
**Status**: Draft — planning / docs-only (no implementation)
**Created**: 2026-06-05
**Owner**: Ahmed Shaaban
**Constitution version**: 3.0.1

---

## 0. What this spec is (and is not)

This is the **planning spec** for 015 — the **keystone** of the ERPNext
integration arc (011 foundation + signed decisions → 012 connector contracts →
013 product master → 014 warehouse mapping → **015 sale posting**). It turns a
Data-Pulse-2 sale fact (008) into ERPNext accounting truth over the fixed 012
pull/feed contract.

It is **docs / planning only**: no application code, no DB schema, no migration,
no OpenAPI YAML, no `package.json`/lockfile, no CI, no connector code. No runtime
behavior changes.

Like 011, 012, and 013's spec PR, this spec carries **no `plan.md`,
`tasks.md`, `data-model.md`, or `execution-map.yaml`** and **no dispatchable code
slices**. It establishes purpose, the posting model, the transport realisation,
the posting-time item resolution (015-RESOLVE), idempotency/temporal/money
design, the implementation gates it inherits but does not satisfy, the failure
posture, and the open questions (now **RATIFIED** — see §11). **Implementation stays blocked** until 015 runs
its own Spec-Kit chain (`plan.md` → Constitution Check → any `[GATED]`
contract/schema → `tasks.md` → `execution-map.yaml`) and the Agent OS gates clear.

Companion documents in this folder:

- [resolution-concepts.md](./resolution-concepts.md) — 015-RESOLVE (the 013
  posting-time resolution deferral) + the **ratified** OQ-5/OQ-6/OQ-8-bis resolutions.
- [follow-up-notes.md](./follow-up-notes.md) — the inherited implementation gates
  (DP-014, P-DP-008-LIVELOOP, G3/G7/G8), the `[GATED]` follow-ups (the
  `erpnext.posting.requested` event-type registration, any future contract
  extensions), and forward references.
- [wave-status.md](./wave-status.md) — human-readable state.

---

## 1. Background & Why

The signed **posting decision**
([011-DR-POSTING](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-record.md))
and the signed **stock-impact decision**
([011-DR-STOCK-IMPACT](../011-erpnext-pos-reference-and-integration-foundation/decisions/stock-impact-decision-record.md))
both name **015** as the slice that *implements exactly this*: async
Sales-Invoice posting with the reconciliation/repair path, posting the Sales
Invoice with "Update Stock" ON, tagged with the correlation ID.

The **owner-decision rider**
([011-DR-POSTING-R1, SIGNED 2026-06-05](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md))
**ratifies** this spec's open questions: the interim Payment Entry mode (R1 /
OQ-7), DP2-side item resolution (R2 / OQ-8-bis), and the fail-to-DLQ postures
(R3–R5 / OQ-5, OQ-6, OQ-8), and re-affirms that `P-DP-008-LIVELOOP` is not
absorbed (R6). **The rider — not this spec — is the durable owner-decision
artifact; this spec defers to it.**

The [011 follow-up-spec-map](../011-erpnext-pos-reference-and-integration-foundation/follow-up-spec-map.md)
frames 015 as **the keystone of the ERPNext arc** — *"turns the DP2 sale fact
into ERPNext accounting + stock truth. Needs items (013) and stock model (014)
settled."*

> **Authority wording clarified (RT-288, Inventory Planning Gate 1, recorded 2026-10-12).** In this feature, "turns the DP2 sale fact into ERPNext accounting + stock truth" (here and in this feature's `plan.md`) and "DP2 stays the sale-fact and operational-on-hand authority" (`plan.md`) read as follows under the owner-approved Inventory Operations baseline of 2026-10-07, decisions 719–727 (Confluence RETAIL page 22544389):
>
> - Backend-Core owns *operational* inventory authority and Available To Sell (721, 722).
> - ERPNext Stock Ledger/Bin is the *financial/book* quantity authority, and ERPNext also owns valuation, COGS and
>   GL (719, 720).
> - 009 evolves into an Inventory Effects Journal plus operational projection (724, 726).
> - ERP Bin snapshots are evidence/book state, never an overwrite master (729, 782, 783).
>
> Here, "stock truth" means ERPNext *book* stock quantity. §5.3 carries its own note. Shipped code, data and history are unchanged (727). Whether and how sale effects are activated, and how ERP confirmation avoids double counting, is decided by Jira RT-289 (Gates 2+3).

The transport already exists: the **012 posting-feed contract**
(`packages/contracts/openapi/erpnext-connector/posting-feed.yaml`, `1.0.0-draft`,
on `main`) ships a **pull/feed bidirectional** surface — the connector PULLS
pending posting work-items (`connectorPullPostings`) and ACKs outcomes back
(`connectorAckOutcome`). 015 **consumes this contract as fixed**; it does not
redesign it.

The item identity already exists: **013** shipped the `erpnext_item_map` MVP
(suggest-then-confirm, confirmed-only resolution; `0017` migration on `main`),
but explicitly **deferred the posting-time resolution path (`013-RESOLVE`) and
its OQ-5/OQ-6 to 015**. 015 defines that resolution here.

What is **not** yet built and 015 must sequence around: **DP-014** has authored
only its planning chain (its `[GATED]` SCHEMA/CONTRACT slices remain `proposed`),
and the **008 live capture→process loop is GATED** (`P-DP-008-LIVELOOP`). 015
defines its expectations on these without absorbing them (see §9, §10).

---

## 2. Purpose

Define, at the planning level:

- The **posting model**: how a DP2 sale fact (008) becomes ERPNext accounting
  truth — one submitted Sales Invoice per sale, the Payment Entry posture, stock
  impact, and void/refund reversal — **per both SIGNED decision records, exactly**.
- The **transport realisation**: how the posting path uses the fixed 012
  pull/feed contract (work-items out, outcomes back) and satisfies the seven 012
  contract obligations (O-1..O-7).
- **Item identity at posting time** (`015-RESOLVE`): how each sale line resolves
  to a confirmed ERPNext Item via the 013 `erpnext_item_map`, and what happens
  when it does not (fails-to-DLQ).
- The **idempotency, temporal, and money** design the implementation must satisfy.
- The **implementation gates 015 inherits but does not satisfy** in this
  planning lane (DP-014 warehouse mapping, P-DP-008-LIVELOOP, G3/G5/G7/G8).
- The **failure posture** (DLQ + reconciliation, no silent rewrite).
- The **open questions** — now **RATIFIED** by the
  [2026-06-05 owner rider](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md) (§11).

---

## 3. Non-Goals

This feature is **planning / docs only**. It explicitly does **not**:

- Author **OpenAPI YAML** under `packages/contracts/openapi/**` — including any
  edit to the fixed `erpnext-connector/posting-feed.yaml` (read-only input). If
  015 identifies a needed contract change, it is recorded as a **future
  `[GATED]` 012 slice** — proposed, or **required pre-implementation** in the
  case of the rider-R2 item-resolution correction
  ([follow-up-notes.md](./follow-up-notes.md)) — never authored here.
- Author any **DB schema, Drizzle schema, or SQL migration** (`packages/db/**`).
  Any work-item / DLQ / posting-status state 015 introduces is a separate
  `[GATED]` slice (§VIII), flagged in [follow-up-notes.md](./follow-up-notes.md).
- **Register** the `erpnext.posting.requested` outbox event type — a separate
  `[GATED]` approval PR (named, not registered, by 012/013).
- Build or modify any **application code** (NestJS modules, services,
  controllers, workers) — in DP2 **or** in the (future) connector repo.
- **Build the connector.** The connector posting adapter lives in the future
  `Retail-Tower-ERP-Next-Connector` repo (ADR 0008), behind the 012 contract.
- Touch any file under **`specs/008-sales-transaction-capture/**`**. The live
  capture→process loop (`P-DP-008-LIVELOOP`) is owned there and is **excluded
  from this spec** by owner decision 2026-06-05 — named as a prerequisite only
  (§10.2).
- Author **DP-014** content — warehouse mapping is 014's slice (§10.1).
- Modify **`package.json` / lockfiles / CI**.
- Change **runtime behavior** of any kind.

---

## 4. Actors

| Actor | Role in 015's domain |
|---|---|
| **Data-Pulse-2 (backend)** | Source of truth for the sale fact (008, §IX). **Exposes** the 012 pull feed of pending posting work-items and **ingests** outcomes; owns the resulting DLQ + reconciliation state (017 surfaces it). Resolves each sale line to a confirmed ERPNext Item via 013 `erpnext_item_map`. Makes **no outbound HTTP calls**; holds **no** ERPNext credentials. |
| **Retail-Tower-ERP-Next-Connector** *(future repo)* | The **only** component that posts to ERPNext. Pulls work-items, posts a submitted Sales Invoice (Update Stock ON) / reversing document, ACKs the outcome (ERPNext document ref + outcome). Holds **all** ERPNext credentials. The **G8 upgrade-gate boundary** lands here (the only ERPNext-version-aware component). |
| **ERPNext / Frappe** | The pinned ERP the connector posts into. Owns the GL and inventory valuation. Not a direct actor on the DP2 ↔ connector contract. |
| **Tenant Admin** | Confirms `erpnext_item_map` mappings (013) so sale lines are resolvable; repairs unmapped/disabled-item reconciliation cases surfaced by a failed posting (017). |
| **POS Device / POS Operator** | **Unaware of ERPNext.** Captures the sale (008) on `/api/pos/v1/…`; never participates in posting. |
| **Owner / Architect** | **Has ratified** the open-question resolutions (§11) and the interim Payment Entry mode (§5.2) via the [2026-06-05 rider](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md); approves each `[GATED]` follow-up. |

Cross-tenant isolation, non-disclosing errors (404-class), and audit obligations
on the feed follow the posture the 012 contract and the 010 read-down API
established (§II/§XII).

---

## 5. The posting model (per both SIGNED decision records)

> Every normative statement below cites the decision-record clause it
> implements. Any deviation from a SIGNED record is a **STOP-and-raise**
> condition, not a silent override (the records say so themselves). §5.2's
> interim Payment Entry mode is **owner-ratified**
> ([rider R1, 2026-06-05](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md))
> — handled on the record, not silently.

### 5.1 One submitted Sales Invoice per DP2 sale (1:1)

Each DP2 sale (008 `sales` + `sale_lines`) posts as **exactly one submitted
ERPNext Sales Invoice** [posting §1]. There is:

- **No POS Invoice + POS Closing consolidation** [posting §1].
- **No draft-then-submit two-phase flow** — the invoice is **submitted**
  [posting §1].
- A 1:1 sale ↔ document mapping for the cleanest reconciliation [posting §1].

### 5.2 Payment Entry — OWNER-RATIFIED INTERIM MODE ([rider R1, 2026-06-05](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md))

**The signed target is unchanged**: posting decision §1 names *"one submitted
Sales Invoice + the associated **Payment Entry**"* per DP2 sale — and that
**remains the accepted posting model**. This spec does **not** replace it;
"Sales Invoice only" is **not** the final posting model.

The constraint is upstream and physical: **008 models no tender** (gate A.5; the
008 `sales` row has no tender/payment fields, confirmed in 008 data-model), and
the **current 012 posting-feed work-item cannot carry tender/payment payload**:

> *PAYMENT ENTRY DEFERRAL: the posting decision pairs the Sales Invoice with "its
> associated Payment Entry", but 008 models NO tender (gate A.5 — payments
> deferred). The work-item therefore carries the sale only and CANNOT carry
> tender; the connector posts the Sales Invoice (+ stock impact per 014) — the
> Payment Entry is deferred until a DP2 payments model lands, at which point the
> work-item payload + this contract gain the tender fields (a versioned,
> backward-compatible extension). `posTotal` is the sale total, not tender.*
> — `posting-feed.yaml` (on `main`)

**Owner-ratified interim mode (rider R1) — "submitted Sales Invoice / outstanding AR only":**

- The **first implementation slice posts the submitted Sales Invoice only** (with
  stock impact, §5.3). This interim mode is explicitly labelled:
  - **NOT finance-complete production posting** — a temporary,
    finance-incomplete state, never the destination;
  - **expected to produce unpaid/outstanding ERPNext Sales Invoices** (open AR)
    until the tender/payment extension ships — by design, not a defect; any
    consumer of ERPNext finance reports must be told this is the expected state;
  - **gated**: Payment Entry posting MUST NOT be implemented before the gated
    extension work below.
- **Payment Entry requires ALL of this future gated work** (rider R1; recorded in
  [follow-up-notes.md](./follow-up-notes.md)):
  1. a DP2 **tender/payment fact model** (or approved equivalent sale-payment payload);
  2. a **012 posting-feed extension** for payment/tender data (versioned,
     backward-compatible);
  3. **connector support for idempotent Payment Entry creation**;
  4. **repair/reconciliation semantics for payment posting** (017 boundary).

> **STOP-and-raise note (per rider R1).** Implementing Payment Entry posting
> before the four gated items land — including deriving a v1 Payment Entry from
> `posTotal` (unallocated/on-account), which the rider explicitly does **not**
> ratify — is a STOP-and-raise, never something 015 authors silently.
> Ratification record: **OQ-7, RATIFIED** (§11).

### 5.3 Stock impact — "Update Stock" ON, correlated, never double-counted

The submitted Sales Invoice posts with **"Update Stock" ON** [stock-impact §3]
so ERPNext derives **valuation / COGS / GL** from it. This is **ERPNext's own
accounting ledger**, not a second operational count:

- DP2's 009 ledger independently records the operational outbound movement
  (009 US4) — the two ledgers answer **different questions** (operational
  available-to-sell vs accounting valuation) and are **never summed**
  [stock-impact §3].
- They are **correlated by the shared correlation ID** — the DP2 sale's
  `sourceSystem + externalId` [stock-impact §3, posting §3] — and **reconciled,
  not merged** (the reconciliation run is 017 [stock-impact §5]).
- A **separate Stock Entry per sale ("Update Stock" OFF) is rejected** for v1
  [stock-impact §3].
- The stock posts against an ERPNext **Warehouse mapped 1:1** to the DP2
  store/branch by **014** [stock-impact §4]. 015 depends on that mapping; the
  minimal-v1 path when 014 has not shipped is in §10.1 + [follow-up-notes.md](./follow-up-notes.md).
- **Negative-balance posture** [stock-impact §6]. DP2's 009 ledger
  **allows-and-flags** negative balances (operational reality: stock can be sold
  before a restock is recorded); ERPNext stock validation **may reject** negative
  stock. This mismatch is **expected** and handled by the failure posture (§8): a
  negative-stock rejection is a `permanently_rejected` (`validation`-class)
  outcome → DLQ + reconciliation flag (017). The DP2 flagged operational reality
  is **never** overwritten to satisfy ERPNext [stock-impact §6].

> **Superseded (RT-288, Inventory Planning Gate 1, recorded 2026-10-12):** two bullets above no longer describe the product direction.
>
> - "DP2's 009 ledger independently records the operational outbound movement (009 US4)" is not an activation
>   instruction. Whether and how sale effects become active, and how ERP confirmation avoids double counting
>   (769, 771, 776), is decided by Jira RT-289 (Gates 2+3).
> - The negative-balance posture (an ERPNext negative-stock rejection is `permanently_rejected` → DLQ) was
>   superseded by Jira RT-47 D3. Negative stock is allowed on the V1 stock path, and a negative Bin is an
>   observable operational discrepancy, not a posting failure (730, 743).
>
> Source: the owner-approved Inventory Operations baseline of 2026-10-07, decisions 719–727 (Confluence RETAIL page 22544389). Shipped code, data and history are unchanged (727).

### 5.4 Void / refund — a new reversing document, never an edit of the original

A DP2 008 terminal event (void or refund) posts as a **new reversing document**
— a **credit note / return Sales Invoice** referencing the original — and
**never** cancels/amends/edits the original submitted invoice [posting §6]. The
012 contract realises this as a **`reversal` work-item** carrying the original's
provenance (`reversalOf`) so the connector locates the document to reverse
[posting §6, 012 O-4, posting-feed.yaml `kind: reversal`]. Both the original sale
and its reversal remain as audit truth (append-only, §IX/§X).

### 5.5 System of record — DP2 owns the sale fact; ERPNext owns the GL

DP2 remains source of truth for the sale fact [posting §4, §IX]. ERPNext owns the
**General Ledger entries** the submitted Sales Invoice produces [posting §4]. The
connector **MUST NOT** silently rewrite a posted ERPNext document; DP2 **MUST
NOT** silently rewrite POS-received sale totals (§III); posted amounts reconcile
to the DP2 sale totals [posting §4].

---

## 6. Transport — realising the fixed 012 pull/feed contract

015 implements the **DP2 side** of the 012 contract; the connector side lives in
the connector repo. DP2 makes **no outbound HTTP calls** — it exposes the feed
the connector pulls and ingests the outcome the connector acks [012 transport].

### 6.1 The two halves (consumed as fixed)

| Half | 012 operation | 015's DP2-side obligation |
|---|---|---|
| **Work-items out** | `connectorPullPostings` (`GET /api/connector/v1/erpnext/postings`) | Project each pending posting (sale post + void/refund reversal) into a **self-sufficient** `PostingWorkItem`; serve the cursor-paginated, ordered, gap-detectable feed (mirrors 010 read-down delta). |
| **Outcomes back** | `connectorAckOutcome` (`POST /…/{workItemRef}/outcome`) | Ingest the outcome (`posted` / `failed_transient` / `permanently_rejected`); record the ERPNext `documentRef`; own the DLQ + reconciliation state. Idempotent ack (O-3). |

### 6.2 The seven contract obligations (O-1..O-7) — how 015 satisfies them

| Obligation | How 015 satisfies it |
|---|---|
| **O-1 — Work-item payload self-sufficiency** | The work-item carries the full 008 sale projection (header + frozen lines), `sourceSystem`/`externalId`/`payloadHash` provenance, `businessDate`, store scope, and exact-decimal money — so the connector posts **without** reaching back into DP2. 015 builds this projection from the **processed** 008 sale fact (the `P-DP-008-LIVELOOP` expectation, §10.2). Line→ERPNext-Item resolution is **DP2-side at projection** ([rider R2](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md) — §7); the work-item is therefore self-sufficient for item identity **only once the `[GATED]` 012 correction/extension lands** (`SaleLine.erpnextItemRef` or equivalent — **required before 015 implementation**, §13); see §7 for the unmapped-line failure. |
| **O-2 — Outcome return payload** | 015 ingests `outcome` + `documentRef` + nullable `etaStatus` + structured `reason` (on `permanently_rejected`); a work-item is **not complete** until DP2 records its outcome. |
| **O-3 — Wire idempotency** | Re-pulling/re-posting the same work-item (`sourceSystem + externalId`) resolves to the **same** ERPNext document; the ack echoes the existing `documentRef` on a duplicate `posted`. See §8. |
| **O-4 — Reversal operations** | Void/refund → a `reversal` work-item posting a **new** reversing document referencing the original via `reversalOf` (§5.4). |
| **O-5 — Connector lifecycle & auth** | Consumed as fixed: the connector authenticates as an opaque-revocable, tenant-scoped **service bearer** (`connectorBearer`); cross-tenant isolation + non-disclosing errors hold on the feed. 015 does not redesign auth. |
| **O-6 — Version-independence** | The work-item speaks **DP2/Retail-Tower terms** (sale, line, businessDate, outcome, documentRef), never ERPNext doctype field names. The ERPNext-version concern is the connector's (G8, §10.4). |
| **O-7 — Connector split** | Consumed as fixed (ADR 0008 accepted). 015 builds nothing in the connector repo. |

### 6.3 The posting trigger (DP2 side, design — not built here)

A processed 008 sale (and each void/refund terminal event) becomes a **pending
posting work-item** exposed on the feed. The mechanism is the
`erpnext.posting.requested` outbox event type — **named** by 012/013, **not yet
registered**; registering it is a separate **`[GATED]` `packages/db`** approval
slice ([follow-up-notes.md](./follow-up-notes.md)). 015 designs *what the
work-item carries* (O-1); it does not register the event type or author the feed
endpoint in this planning lane.

---

## 7. Item identity at posting time — 015-RESOLVE (the 013 deferral)

013 shipped the `erpnext_item_map` MVP and **deferred the posting-time resolution
path to 015**. 015 defines it here as **015-RESOLVE**. Full treatment in
[resolution-concepts.md](./resolution-concepts.md); the normative summary:

- **Resolution is lazy, at posting time, DP2-side at work-item projection**
  (013 OQ-8; resolution side **RATIFIED DP2-side** by
  [rider R2, 2026-06-05](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md)
  — connector-side resolution is rejected): when 015 projects a sale into a
  work-item, each sale line's
  `tenantProductRef` resolves to a **confirmed** `erpnext_item_map` row
  (`state = 'confirmed' AND retired_at IS NULL`) [013 data-model §3 confirmed-only
  invariant].
- A **`suggested` (unconfirmed) mapping does NOT count as mapped** — it is
  treated as unmapped [013 data-model §3].
- An **unmapped line → the posting fails-to-DLQ** [posting §1, §5; 013 "fails-to-DLQ
  if not"], surfacing a reconciliation flag (017) with the nearest 012
  `RejectionReason.category = unmapped_item`. The DP2 sale fact is **never**
  mutated on a posting failure [posting §5].
- **v1 mapping suggestion is manual-only** (013 `suggestion_source = 'manual'`;
  finding `AUTO_MATCH_NO_SOURCE`). Auto-match (barcode/item-code) needs a future
  `[GATED]` 012 item-search extension — **named, not authored** here
  ([follow-up-notes.md](./follow-up-notes.md)).
- **Ad-hoc sale lines** (008 FR-004: a line with no `tenantProductRef`) cannot
  resolve to a mapping → same fails-to-DLQ posture (an ad-hoc line has no tenant
  product to map). This is a reconciliation case, not a silent drop.

The two previously-open 013 questions this slice owns — **OQ-5** (disabled
ERPNext Item) and **OQ-6** (relationship to the inbound unknown-items queue) —
are **RATIFIED** by the 2026-06-05 owner rider (R3/R4); the ratified resolutions
are detailed in [resolution-concepts.md](./resolution-concepts.md) (§11).

---

## 8. Idempotency (G5 design) — exactly-one ERPNext document per sale

015 must guarantee **exactly-one** ERPNext document per DP2 sale across retries
[posting §3, 012 O-3, §XI]:

- The dedup anchor is the DP2 sale's **`sourceSystem + externalId`** carried as a
  stable external reference into the posting, **plus a canonical `payloadHash`**
  for provenance [posting §3, 012 O-1].
- Re-pulling/re-posting the same work-item resolves to the **same** ERPNext
  document; the `connectorAckOutcome` ack **echoes the existing `documentRef`**
  on a duplicate `posted` rather than creating a second [012 O-3, posting-feed.yaml].
- The outcome ack reuses the existing `IdempotencyInterceptor`
  (`Idempotency-Key` required); re-acking the **same** logical outcome replays
  deterministically (200), a **different** outcome for the same key is a 409
  `idempotency_key_conflict` [posting-feed.yaml]. **No new idempotency primitive.**

### Re-post / repair semantics (the 017 boundary)

- A `failed_transient` outcome re-offers the work-item on the next pull, bounded
  by a retry budget [posting §5, posting-feed.yaml]. **No** new document is
  created on a transient retry (O-3 holds).
- A `permanently_rejected` outcome dead-letters the work-item + raises a
  **reconciliation flag** [posting §5]. The **DLQ drain + repair surface is
  017** [posting §5, follow-up-spec-map §017] — 015 owns producing the DLQ +
  reconciliation **state**; 017 owns draining/repairing it. A repair re-post must
  resolve to the same document (idempotency holds across repair) — never a silent
  rewrite of an already-posted document [posting §4, §5].

---

## 9. Temporal & money

- **Temporal (§X).** The ERPNext `posting_date` is driven by the sale's
  **`businessDate`** (008, derived from store timezone), **not** the connector's
  post-time [posting §2, 012 O-1, posting-feed.yaml]. A delayed/offline-synced
  sale therefore lands in the **correct fiscal period** [posting §2, §X]. Security
  clocks remain server clocks; the outcome `recordedAt` is the DP2 server clock
  [§X, posting-feed.yaml]. `occurredAt` / `sourceClockAt` are carried/preserved,
  never used as a security clock [§X].
- **Money (§III).** Every monetary field is an **exact-decimal string + ISO-4217
  currency** end-to-end — **no floats** [§III, 012 O-1, posting-feed.yaml
  `DecimalAmount`]. **DP2 amounts are authoritative for the posted invoice** —
  POS totals preserved as received [posting §4, §III, §IX; 013 mapping-concepts
  §4]. The ERPNext Price List reference (013) exists for ERPNext document
  validity, **not** to reprice a DP2 sale [013 mapping-concepts §4]. Whether the
  posting sends explicit per-line amounts vs relies on a Price List is the §IX-safe
  default of **explicit DP2 amounts** [013 mapping-concepts §4 / OQ-4 resolved
  "no pricing on the map table"].

---

## 10. Implementation gates 015 inherits but does NOT satisfy

This is a **planning lane**. 015 **defines** how the implementation will satisfy
these gates; it does not satisfy them here. Full detail in
[follow-up-notes.md](./follow-up-notes.md).

### 10.1 DP-014 warehouse mapping — the "Update Stock ON" target (depends-on)

The stock-impact decision §3/§4 requires the Sales Invoice to post with "Update
Stock" ON against an ERPNext **Warehouse mapped 1:1 to the DP2 store** by
**DP-014**. **DP-014 has authored only its planning chain** — its `[GATED]`
SCHEMA/CONTRACT slices are `proposed`, **not built** (no `erpnext_warehouse_map`
table on `main`; git-verified). Therefore:

- 015's stock-on posting **depends on 014-CRUD shipping the store→warehouse
  map**.
- **Minimal v1 path (RATIFIED — rider R5, 2026-06-05):** absent a resolved
  warehouse for a sale's store, the posting **fails-to-DLQ** (an
  `unmapped_store`-class reconciliation case — aligning with 014's locked
  mismatch vocabulary) — it **does NOT guess a default warehouse**. This keeps
  the operational-vs-accounting split intact (stock-impact §4) and surfaces the
  gap for repair (017) rather than silently mis-valuing stock.
- 015 authors **no** 014 content (warehouse mapping is 014's slice).

### 10.2 P-DP-008-LIVELOOP — prerequisite only (OWNER DECISION 2026-06-05, NOT absorbed)

The 008 **live capture→process loop is GATED** and not yet functional (008
wave-status Active finding #1). **Owner decision (2026-06-05): it is NOT absorbed
into 015.** It remains a **separate implementation/e2e prerequisite slice scoped
under `specs/008-sales-transaction-capture/**`**. This spec:

- **(a) Names it as a prerequisite** in the dependency/sequencing section (§13).
- **(b) Defines the EXPECTATIONS the posting path places on it** — without
  restating its tasks or design:
  - 015 posts **processed** sale facts. The posting path expects that captured
    sales become **processed** (`processed_at` set off-request) and thereby
    eligible to feed work-items. Until the live loop runs, `processed_at` stays
    NULL and **no sale is eligible for posting** — the posting feed is correctly
    empty, not erroring.
  - `processed_at` semantics: a non-NULL `processed_at` is the signal that a sale
    fact has completed DP2-side processing and may be projected into a posting
    work-item. (015 does not define *how* `processed_at` is set — that is the
    008 slice.)
- **(c) Places it in the implementation order** (§13): `P-DP-008-LIVELOOP` must
  ship **before** 015's posting feed can carry real work-items end-to-end.
- This spec **MUST NOT** author, scope, or restate the live-loop's tasks,
  requirements, or design (producer binding / `sale.captured` event type /
  `main.ts` start). Those belong to `specs/008` and are out of scope here.

### 10.3 G3 — schema gate (if 015 introduces state tables)

If 015's implementation introduces **work-item / DLQ / posting-status state**
beyond what `0012`/`0017` already provide, that is a new `packages/db` surface —
a **`[GATED]` G3 schema slice** (Drizzle schema + migration + paired `*.down.sql`,
RLS, tenant-scoping per §II). **Flagged `[GATED]`; not designed here.** See
[follow-up-notes.md](./follow-up-notes.md).

### 10.4 G7 / G8 — observability & upgrade boundary

- **G7 (observability).** The posting worker/feed must emit structured logs +
  the §VII metrics (queue lag, failed-job rate, **reconciliation mismatch
  rate**, DLQ depth) carrying `correlationId`/`tenantId` [§VII]. The
  observability **seam is 017** (it surfaces the DLQ + reconciliation state);
  015 defines the signals, 017 surfaces them.
- **G8 (upgrade gate).** ERPNext-version concerns land on the **connector
  posting adapter** — the only ERPNext-calling component (DP2 makes no outbound
  HTTP calls). The DP2 ↔ connector contract is version-independent (O-6); an
  ERPNext v15→v16 change alters the connector's internal mapping, never 015's
  DP2-facing design. **Boundary noted; not 015's to satisfy.**

---

## 11. Open questions — **RATIFIED** ([owner rider 011-DR-POSTING-R1, 2026-06-05](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md))

All five resolutions below are **RATIFIED** by the signed owner rider; the
detailed treatments are in [resolution-concepts.md](./resolution-concepts.md).
**None remains an open question.** Deviating from a ratified resolution is a
STOP-and-raise (a new signed rider is required), never a silent override.

| ID | Question | Ratified resolution (rider clause) |
|---|---|---|
| **OQ-5** | Sellable-state divergence (DP2 sellable vs ERPNext Item `disabled`/`is_sales_item`): which governs posting resolvability, and how is divergence handled? | **RATIFIED (rider R3):** a disabled / non-sales ERPNext Item at posting time **fails-to-DLQ** — **no silent fallback, no substitute item** — while **operational sellability stays DP2-authoritative** (a disabled accounting Item does NOT make the product unsellable at POS). Divergence = reconciliation case (017), never a silent override. [resolution-concepts §OQ-5] |
| **OQ-6** | Relationship between resolving a 003 unknown-item and establishing a 013 ERPNext mapping. | **RATIFIED (rider R4):** the two mechanisms are **separate operational states**: inbound unknown-items (scan → no `tenant_product`) ≠ outbound unmapped-for-posting (a `tenant_product` with no confirmed map). Resolving an unknown item creates a `tenant_product` that **still needs a confirmed 013 mapping before it can post**. 015 **MUST NOT** route posting failures into the unknown-items queue. [resolution-concepts §OQ-6] |
| **OQ-7** | Payment Entry in the first implementation slice (§5.2). | **RATIFIED (rider R1):** the **signed target is unchanged** (submitted Sales Invoice + associated Payment Entry per sale). The first implementation slice runs the **owner-ratified interim mode** — submitted Sales Invoice / outstanding AR only — explicitly **gated** and **not finance-complete**; Payment Entry posting requires the four gated extensions (DP2 tender model, 012 payment extension, connector idempotent PE creation, payment repair semantics) **before** implementation. Deriving a PE from `posTotal` is **not ratified**. [§5.2] |
| **OQ-8** | Minimal-v1 stock path when DP-014 has not shipped (§10.1). | **RATIFIED (rider R5):** absent a resolved warehouse, **fail-to-DLQ** (`unmapped_store`-class) — **never guess the ERPNext warehouse**. [§10.1] |
| **OQ-8-bis** | **Where** line→Item resolution happens: DP2-side (resolve at work-item projection, embed the ERPNext Item ref) vs connector-side (connector resolves from `tenantProductRef`). | **RATIFIED (rider R2): DP2 resolves at projection**; a failed resolution **fails-to-DLQ in DP2 before the work-item is offered**. The Connector **MUST NOT** guess Item identity, reach back into DP2 for item lookup, or maintain a second copy of DP2 mapping truth. Implementation is **gated on the `[GATED]` 012 correction/extension** (`SaleLine.erpnextItemRef` or equivalent + `tenantProductRef` description correction) — **required before 015 implementation**. [resolution-concepts §OQ-8-bis] |

---

## 12. Constitution Check (planning-level)

Docs-only, so the check is at the **design-intent** level; a full per-task
Constitution Check lands in 015's future `plan.md`.

| Principle | How 015 (as specified) complies |
|---|---|
| **§II Multi-tenant RLS** | The feed is tenant-scoped from the connector principal; cross-tenant work-item refs / cursors are non-disclosing 404s (012 contract); any new state table is tenant-scoped with fail-closed RLS (G3, §10.3). |
| **§III Backend authority & money** | Exact-decimal string money end-to-end, no float (§9); DP2 amounts authoritative; POS totals preserved as received (§5.5, §9). |
| **§IV Contract-first** | 015 consumes the fixed 012 OpenAPI contract; any new ERP-backed surface is a `[GATED]` contract slice first; no raw DB entities cross the wire (the work-item is a projection). |
| **§V Async workers** | Posting is async off the request path [posting §2]; the posting worker carries `tenantId`/`correlationId`, is idempotent, and surfaces failures to a DLQ (no silent swallow) [§V, §8]. |
| **§IX Source-of-truth** | DP2 owns the sale fact; ERPNext owns the GL; mapping/reconciliation never collapses authority (§5.5, §7). |
| **§X Temporal** | `businessDate` → `posting_date`; delayed sales land in the correct period; server clocks for security (§9). |
| **§XI Idempotency** | Exactly-one document per sale via `sourceSystem + externalId` + payload hash; idempotent ack (§8). |
| **§XII Object safety** | Body-supplied scope rejected on the ack; tenant/store/actor resolve from the connector principal (012 contract). |
| **§XIII Auditability & provenance** | Provenance (`sourceSystem`/`externalId`/`payloadHash`) carried into the posting; outcomes recorded; reconciliation cases traceable (§7, §8). |
| **§VIII Reproducible releases** | No schema/migration/contract/package/lockfile/CI change in this PR; every such surface is a flagged `[GATED]` follow-up (§10.3, follow-up-notes). |

No principle is violated by this planning spec. The principle that most
**constrains** the implementation is **§III/§IX** (money + source-of-truth),
addressed in §5.5 and §9.

---

## 13. Dependencies, gates & sequencing

> **Status superseded (2026-06-06).** The state column below is the **2026-06-05
> point-in-time** snapshot. Since then, prerequisites 1–3 have **shipped to `main`**:
> P-DP-008-LIVELOOP (#496/#497), 014-CRUD (#495), and the `[GATED]` 012
> `SaleLine.erpnextItemRef` correction (#494). For current truth see
> [plan.md → Technical Context → *Prerequisite reality*](./plan.md). Only the
> `[GATED]` `erpnext.posting.requested` event-type + 015's own data-model/tasks/
> execution-map remain outstanding.

| Dependency / gate | State (verified 2026-06-05 against the worktree from `origin/main @ 0cafd0c`) |
|---|---|
| **gated_by**: posting decision (011-DR-POSTING) | ✅ **SIGNED** 2026-06-03 (gates 012/013/015/017) |
| **gated_by**: stock-impact decision (011-DR-STOCK-IMPACT) | ✅ **SIGNED** 2026-06-03 (gates 014/015/017) |
| **depends_on**: 012 posting-feed contract on `main` | ✅ present — `posting-feed.yaml` `1.0.0-draft` (git-verified) |
| **depends_on**: 013 `erpnext_item_map` MVP on `main` | ✅ CLOSED — module + `0017` migration (git-verified); `013-RESOLVE` lands here |
| **depends_on**: 008 sale fact on `main` | ✅ CLOSED — `sales`+`sale_lines`+`0012` migration (git-verified) |
| **depends_on**: DP-014 warehouse map | ⏳ **planning chain only; SCHEMA/CONTRACT `[GATED]`+`proposed`, not built** — §10.1 minimal-v1 path |
| **prerequisite**: P-DP-008-LIVELOOP | ⏳ **GATED** (separate slice, `specs/008`) — must ship before the feed carries real work-items end-to-end (§10.2) |
| G0 repo truth | ✅ worktree from `origin/main @ 0cafd0c` |
| G2 contracts | ✅ `posting-feed.yaml` present |
| G3 / G5 / G7 / G8 | **defined, not satisfied** (planning lane) — §8, §10 |
| G9 rollout | n/a (planning lane) |

**Implementation sequencing (per the 2026-06-05 rider):**

1. `P-DP-008-LIVELOOP` (scoped under `specs/008`) — makes processed sales feedable. (Rider R6: separate prerequisite slice, never absorbed here.)
2. `014-CRUD` (+ its `[GATED]` SCHEMA/CONTRACT) — the store→warehouse map ("Update Stock ON" target).
3. The **`[GATED]` 012 contract correction/extension** (`SaleLine.erpnextItemRef` or equivalent + `tenantProductRef` description correction) — **required before 015's posting-feed implementation** (rider R2; gates ALL 015 implementation).
4. The `[GATED]` `erpnext.posting.requested` event-type registration (`packages/db`).
5. 015's own Spec-Kit chain (`plan.md` → `[GATED]` schema/contract as needed → `tasks.md` → `execution-map.yaml`), then the posting feed + worker + `015-RESOLVE` — in the **interim invoice-only/outstanding-AR mode** (rider R1).
6. **017** drains the DLQ, surfaces reconciliation + observability.
7. *(Later, separately gated — rider R1)*: DP2 tender/payment model → 012 payment/tender extension → connector idempotent Payment Entry creation → payment repair semantics → **Payment Entry posting** (completing the signed target).

---

## 14. Out of scope (explicit)

- **Tax / fiscal Egypt (ETA e-invoice)** — that is **016** (rides on a working
  posting; `etaStatus` is a nullable passthrough until then per the 012 contract).
- **Connector adapter internals** — how the connector orchestrates submit /
  retry-backoff / ERPNext API calls lives in the connector repo (behind the 012
  contract), not here.
- **Any catalog read-down concern** — the retail catalog reaches the edge by
  READ-DOWN from the Data-Pulse resolved store catalog (010); ERPNext Item =
  accounting/posting identity only (ADR-0001). 015 is **capture-UP** (posting
  feed) only; it is **never** a source of the retail catalog or prices.
- **ERPNext POS UI** — rejected as the production cashier terminal (011); not in
  this arc.
- **The P-DP-008-LIVELOOP slice itself** — prerequisite only (§10.2); its tasks /
  requirements / design belong to `specs/008` and are **not** authored, scoped,
  or restated here.
- **DP-014 warehouse mapping** — its slice; 015 only depends on it (§10.1).
- **017 sync-ops / repair API** — owns the DLQ drain + reconciliation + repair
  surface; 015 produces the state it consumes.

---

## 15. Acceptance criteria (for this planning spec)

- [ ] The posting model (§5) restates **both** SIGNED decision records with **zero
      deviations**; each normative statement cites its decision-record clause.
- [ ] The interim Payment Entry mode (§5.2) is **explicit and owner-ratified**
      ([rider R1, 2026-06-05]) — labelled **gated** and **not finance-complete**,
      with the signed target (Sales Invoice + associated Payment Entry) unchanged
      and never presented as replaced by "Sales Invoice only".
- [ ] The transport (§6) consumes the 012 contract as fixed and maps all seven
      obligations (O-1..O-7).
- [ ] 015-RESOLVE (§7 + resolution-concepts) defines posting-time item resolution,
      the confirmed-only invariant, and the unmapped→DLQ posture; OQ-5/OQ-6/OQ-8-bis
      resolutions **RATIFIED** via the 2026-06-05 owner rider (DP2-side resolution
      selected; the `[GATED]` 012 correction/extension marked required before
      implementation).
- [ ] Idempotency (§8), temporal + money (§9) are designed to the constitution
      (§III/§X/§XI) and the 012 contract.
- [ ] Inherited implementation gates (§10) are scoped, not satisfied: DP-014
      depends-on + minimal-v1 path; P-DP-008-LIVELOOP prerequisite-only
      (expectations + sequencing, **no** absorbed content); G3/G7/G8 flagged.
- [ ] Out-of-scope (§14) lists tax/fiscal (016), connector internals, catalog
      read-down, ERPNext POS UI, and the live-loop slice itself.
- [ ] No runtime / OpenAPI / DB / migration / package / lockfile / CI / connector
      / POS / Console file is touched; changed files are only under
      `specs/015-pos-sale-posting-to-erpnext/`.
