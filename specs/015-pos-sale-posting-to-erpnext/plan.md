# Implementation Plan: POS Sale Posting to ERPNext

**Branch**: `docs/015-plan` | **Date**: 2026-06-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/015-pos-sale-posting-to-erpnext/spec.md`

> **Decision-gated plan — the open questions are RATIFIED by the owner
> ([rider 011-DR-POSTING-R1, SIGNED 2026-06-05](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md)).**
> This is a **docs-only planning artifact**. It records the approach, the full
> Constitution Check, the Architecture Impact Map, the Technical Context, and the
> scoped (NOT authored) project structure. **No application code, DB schema,
> migration, OpenAPI YAML, `package.json`/lockfile, CI, or connector file is
> touched; the only changed files are under `specs/015-pos-sale-posting-to-erpnext/`
> plus the `.specify/feature.json` pin.**
>
> **Ratified (owner rider, 2026-06-05):**
> - **OQ-7 / Payment Entry (R1)** = signed target unchanged (Sales Invoice **+
>   associated Payment Entry** per sale); the **first implementation slice runs
>   the interim "submitted Sales Invoice / outstanding AR only" mode** — explicitly
>   **gated** and **not finance-complete** (expect open AR until the tender
>   extension ships). Deriving a PE from `posTotal` is **not ratified**.
> - **OQ-8-bis / resolution side (R2)** = **DP2 resolves line→Item at work-item
>   projection**; failed resolution **fails-to-DLQ in DP2 before** the work-item is
>   offered. Connector MUST NOT guess Item identity. Implementation is **gated on
>   the `[GATED]` 012 correction** (`SaleLine.erpnextItemRef`) — *now SATISFIED on
>   `main`, see Technical Context*.
> - **OQ-5 (R3)** = disabled / non-sales ERPNext Item at posting → **fails-to-DLQ**,
>   no substitute; operational sellability stays DP2-authoritative.
> - **OQ-6 (R4)** = inbound unknown-items ≠ outbound unmapped-for-posting; 015
>   never routes posting failures into the unknown-items queue.
> - **OQ-8 (R5)** = absent a resolved warehouse → **fail-to-DLQ**
>   (`unmapped_store`-class); never guess the warehouse.
>
> Still docs-only: the work-item feed/ack endpoints, the posting worker,
> `015-RESOLVE`, and any new state table are described as **future `[GATED]` /
> GREEN slices**, not authored here.

---

## Summary

015 plans **POS sale posting to ERPNext** — the **keystone** of the ERPNext
integration arc. It turns a processed DP2 sale fact (008 `sales` + `sale_lines` +
void/refund terminal events) into ERPNext **accounting + stock truth**, posting
**one submitted Sales Invoice per sale** (1:1) over the **fixed 012 pull/feed
contract** (`erpnext-connector/posting-feed.yaml`, consumed as-is). DP2 **exposes**
the feed of pending posting work-items (`connectorPullPostings`) and **ingests**
outcomes (`connectorAckOutcome`); it makes **no outbound HTTP calls** and holds
**no** ERPNext credentials — the connector (future `Retail-Tower-ERP-Next-Connector`
repo, ADR 0008) is the only ERPNext-calling component.

**The committed design (per both SIGNED 011 decision records + the 2026-06-05 rider):**

- **Posting model** ([011-DR-POSTING](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-record.md))
  — one **submitted** Sales Invoice per sale (no POS-Invoice/Closing consolidation,
  no draft-then-submit); void/refund → a **new reversing document** referencing the
  original (never an edit); DP2 owns the sale fact, ERPNext owns the GL.
- **Interim Payment Entry mode** (rider R1) — the first GREEN slice posts the
  **Sales Invoice only** (outstanding AR); Payment Entry is **gated** behind a
  future DP2 tender model + 012 payment extension + connector PE support + payment
  repair semantics. The signed target (SI + PE) is unchanged, not replaced.
- **Stock impact** ([011-DR-STOCK-IMPACT](../011-erpnext-pos-reference-and-integration-foundation/decisions/stock-impact-decision-record.md))
  — Sales Invoice posts with **"Update Stock" ON** against the **014**-mapped
  ERPNext Warehouse, correlated by `sourceSystem + externalId`, **never** summed
  with the DP2 009 operational ledger; negative-stock rejection → DLQ +
  reconciliation, DP2 reality never overwritten.
  - **Superseded (RT-288, Inventory Planning Gate 1, recorded 2026-10-12):** the premise that ERPNext rejects negative stock (→ `permanently_rejected` / DLQ / repair queue) was superseded by Jira RT-47 D3. Negative stock is allowed on the V1 ERPNext stock path, and a negative Bin is an observable operational discrepancy, not by itself a posting failure (730, 743). How negative balances are classified in reconciliation belongs to the Inventory reconciliation decisions (923–942) and Jira RT-289, not to this artifact. Source: the owner-approved Inventory Operations baseline of 2026-10-07, decisions 719–727 (Confluence RETAIL page 22544389). Shipped code, data and history are unchanged (727).
- **Item identity** (`015-RESOLVE`, the 013 deferral) — **DP2-side at projection**
  (rider R2): each sale line's `tenantProductRef` resolves against a **confirmed**
  `erpnext_item_map` row; unmapped → **fails-to-DLQ** before the work-item is
  offered. v1 suggestion is manual-only (013 `AUTO_MATCH_NO_SOURCE`).
- **Idempotency / temporal / money** — exactly-one document per sale via
  `sourceSystem + externalId` + canonical `payloadHash`; `businessDate` →
  ERPNext `posting_date`; exact-decimal string money end-to-end, DP2 amounts
  authoritative.

**The authority question is closed** by the signed records — DP2 stays the sale-fact
and operational-on-hand authority; ERPNext owns the GL + valuation; mapping/
reconciliation **never** collapses authority. 015's job is fidelity to that, not
re-deciding it.

---

## Technical Context

> **Resolution level.** The OQs are RATIFIED (rider 2026-06-05) and three of the
> four implementation prerequisites have **shipped to `main` since the spec was
> authored** (verified 2026-06-06 — see *Prerequisite reality* below). So the
> Technical Context can be filled concretely; the only true unknown is the precise
> shape of any new posting-status / DLQ state table, which is deferred to 015's
> `data-model.md` (a `[GATED]` G3 decision, §10.3 of the spec).

**Language/Version**: TypeScript 5.x strict, Node.js 20 LTS, pnpm workspaces (the
DP2 stack). The future connector adapter is a **separate repo** and out of scope.

**Primary Dependencies**: NestJS 11 (api + worker), Drizzle ORM, PostgreSQL 16+
with RLS, Redis 7+ / BullMQ (the async posting worker, §V), Zod (runtime
validation at the contract boundary), OpenAPI 3.1 (the 012 contract of record,
consumed as fixed).

**Storage**: reads the **processed** 008 sale fact (`sales` + `sale_lines` +
`sale_voids` / `sale_refunds`, migration `0012`) and the **confirmed** 013
`erpnext_item_map` (`0017`) for line→Item resolution, and the **014**
`erpnext_warehouse_map` (`0018`, now on `main`) for the store→Warehouse target.
**If 015's implementation needs new posting-status / work-item / DLQ state** beyond
those tables, that is a **new `[GATED]` `packages/db` surface** (Drizzle schema +
migration + paired `*.down.sql`, fail-closed RLS, tenant-scoped per §II) — a future
G3 slice, **not designed here** (§10.3 of the spec).

**Testing**: Jest + Supertest + Testcontainers (`MIGRATION_TEST_ALLOW_SKIP=1` for
Docker-less local runs; Testcontainers paths run under WSL per the repo's CI
reality). The isolation-harness-first pattern (seed + RLS/cross-tenant sweep,
operation cases RED until built) mirrors 008/010/013.

**Target Platform**: Linux server (api + worker containers); Prometheus exporter
(api `:9464`, worker `127.0.0.1:9091`) for the §VII posting signals.

**Project Type**: web-service (backend feed/ack endpoints + an async posting
worker). No frontend. The connector and POS are separate repos.

**Performance Goals**: report-only at planning (no perf env; 005/008/009/010
precedent). The feed is cursor-paginated, ordered, gap-detectable (mirrors the 010
read-down delta); a bounded per-pull page ceiling applies (009/010 precedent).

**Constraints**: **Version-independence** (012 O-6) — the work-item speaks
DP2/Retail-Tower terms, never ERPNext doctype field names; the ERPNext-version
concern lives entirely in the connector (G8). **No outbound HTTP from DP2.**
**No float** anywhere (§III). **No silent rewrite** of a posted ERPNext document or
a DP2 sale total (§IX). DP2 posts **processed** sales only (`processed_at` non-NULL).

**Scale/Scope**: one Sales Invoice per sale (1:1); one reversal document per
void/refund. Work-item volume tracks sale volume. No bulk/batch posting path in v1.

> **Prerequisite reality (verified against `origin/main`, 2026-06-06).** The spec
> §13 (authored 2026-06-05) listed prerequisites 1–3 as pending; **all three have
> since merged to `main`** — this plan reflects current truth:
> - **P-DP-008-LIVELOOP** ✅ **SHIPPED** (#496 + #497): `sale.captured` registered
>   in `OUTBOX_EVENT_TYPES`, in-transaction emit, `SaleWorker.start()`;
>   `processed_at` is now set off-request. Sales are now eligible to feed work-items.
> - **014-CRUD** ✅ **MERGED** (#495): `erpnext_warehouse_map` + `0018` migration on
>   `main` — the "Update Stock ON" target exists.
> - **`[GATED]` 012 `SaleLine.erpnextItemRef`** ✅ **MERGED** (#494): `erpnextItemRef`
>   is `required` in `posting-feed.yaml` — the rider-R2 contract correction that
>   gated all 015 implementation is satisfied.
>
> **Still outstanding** before 015 GREEN work: the `[GATED]`
> `erpnext.posting.requested` outbox event-type registration (`packages/db`), and
> 015's own `data-model.md` / `tasks.md` / `execution-map.yaml`.

---

## Constitution Check

> *GATE:* docs-only, so the check is at the **design-intent** level; a full
> per-task Constitution Check re-runs in 015's `tasks.md`/`execution-map.yaml`
> phase once concrete surfaces (any `[GATED]` state table, the feed/ack endpoints,
> the posting worker) are designed. The principle that most **constrains** the
> implementation is **§III/§IX** (money + source-of-truth): DP2 amounts are
> authoritative, ERPNext owns the GL, and neither side silently rewrites the other.

| Principle | Gate verdict |
|---|---|
| **§II Multi-tenant RLS** | ✅ (design intent) The feed is tenant-scoped from the `connectorBearer` principal; cross-tenant work-item refs / cursors are non-disclosing 404s (012 contract); any new state table is tenant-scoped, fail-closed RLS (G3). |
| **§III Backend authority & money** | ✅ Exact-decimal string + ISO-4217 money end-to-end, **no float**; DP2 amounts authoritative; POS totals preserved as received; the 013 Price List is for ERPNext document validity, not repricing. |
| **§IV Contract-first** | ✅ Consumes the **fixed** 012 OpenAPI contract; any new ERP-backed surface is a `[GATED]` contract slice first; the work-item is a **projection**, not a raw DB entity on the wire. |
| **§V Async workers** | ✅ (design intent) Posting is async off the request path; the posting worker carries `tenantId`/`correlationId`, is idempotent, surfaces failures to a DLQ (no silent swallow). |
| **§VII Observability** | ✅ (design intent) Posting feed/worker emit the §VII signals (queue lag, failed-job rate, **reconciliation mismatch rate**, DLQ depth) with `correlationId`/`tenantId`; the surfacing seam is **017** (G7). |
| **§VIII Reproducible releases** | ✅ **No** schema / migration / contract / `package.json` / lockfile / CI change in this PR; every such surface is a flagged `[GATED]` follow-up. |
| **§IX Source-of-truth model** | ✅ **RESOLVED by the SIGNED posting + stock-impact decisions.** DP2 owns the sale fact + operational on-hand; ERPNext owns the GL + valuation; mapping/reconciliation **never** collapses authority. |
| **§X Retail temporal** | ✅ `businessDate` → ERPNext `posting_date` (delayed sales land in the correct fiscal period); server clocks for security; `occurredAt`/`sourceClockAt` carried, never used as a security clock. |
| **§XI Idempotency & external IDs** | ✅ Exactly-one ERPNext document per sale via `sourceSystem + externalId` + canonical `payloadHash`; idempotent `connectorAckOutcome` (reuses the existing `Idempotency-Key` interceptor — no new primitive). |
| **§XII Authorization & object safety** | ✅ Body-supplied scope rejected on the ack; tenant/store/actor resolve from the connector principal (012 contract). |
| **§XIII Auditability & provenance** | ✅ Provenance (`sourceSystem`/`externalId`/`payloadHash`) carried into the posting; outcomes recorded; reconciliation cases traceable. |

**Constitution Check result: PASS** (planning-level). No principle is violated by
this docs-only spec/plan.

**Complexity Tracking:** No violations to justify. The one genuine design tension —
DP2 allow-and-flag negative balances vs ERPNext may-reject-negative-stock (§III vs
ERPNext validation) — is **resolved by design**, not waived: it is the expected
`permanently_rejected` → DLQ + reconciliation path (spec §5.3 / §8), with the DP2
operational reality never overwritten.

---

## Architecture Impact Map

> Forward reference for the future GREEN/`[GATED]` slices; this docs-only plan
> authors **none** of it.

### Impact Classification

- **Impact level:** HIGH (a new cross-system posting pipeline — feed/ack endpoints,
  an async posting worker, posting-time item resolution, and likely new
  posting-status/DLQ state), but **0% authored in this PR** (planning lane).
- **Reason:** 015 is the first DP2 surface that projects the sale fact outward for
  ERPNext posting; it spans the api (feed/ack), the worker (projection + outcome
  handling), and `packages/db` (if new state is needed).
- **Boundary crossings:** DP2 ↔ connector (over the fixed 012 contract only); DP2
  ↔ ERPNext is **indirect** (connector-mediated). DP2 makes no outbound HTTP calls.

### Triggered Review Gates — *firm forward reference; satisfied by future slices, not this PR*

- [ ] **G2 Contract gate** — **YES (consume-only here).** 015 consumes the fixed
  `posting-feed.yaml`. The rider-R2 `SaleLine.erpnextItemRef` correction it depended
  on is **already merged** (#494). Any *further* contract change (e.g. a future
  payment/tender extension, an item-search extension for auto-match) is its own
  `[GATED]` 012 slice — named, not authored.
- [ ] **G3 Schema gate** — **MAYBE.** Only if 015 introduces posting-status /
  work-item / DLQ state beyond `0012`/`0017`/`0018`. A `[GATED]` `packages/db` slice
  (schema + migration + `*.down.sql` + RLS) decided in 015's `data-model.md`.
- [ ] **Outbox event-type gate** — **YES.** `erpnext.posting.requested` must be
  registered in `OUTBOX_EVENT_TYPES` — a `[GATED]` `packages/db` approval slice
  (the 008-LIVELOOP `sale.captured` registration is the precedent).
- [ ] **G5 Idempotency** — **YES (design satisfied).** Exactly-one document per sale;
  reuses the existing `Idempotency-Key` interceptor on the ack.
- [ ] **G7 Observability** — **YES (signals defined here, surfaced by 017).**
- [ ] **G8 Upgrade gate** — **N/A to DP2.** Lives on the connector adapter (O-6).

### Required dimensions — *firm forward reference (future `[GATED]`/GREEN slices)*

| Dimension | This docs-only PR | Decided impact (future slices) |
|---|---|---|
| Affected modules | none | NEW `apps/api/src/…/erpnext-posting/` (feed/ack) + worker projection/outcome handlers |
| DB tables (read) | none | `sales`, `sale_lines`, `sale_voids`/`sale_refunds` (008); `erpnext_item_map` (013); `erpnext_warehouse_map` (014) |
| DB tables (write) | none | possibly NEW posting-status / DLQ state (`[GATED]` G3) — decided in `data-model.md` |
| APIs / contracts | none | DP2-side impl of `connectorPullPostings` + `connectorAckOutcome` (fixed 012 contract) |
| Events | none | NEW `[GATED]` `erpnext.posting.requested` outbox event type (the posting trigger) |
| Files | only `specs/015-…/**` + `.specify/feature.json` | the module/worker/test trees below |
| Risky dependencies | none | the connector repo (out of repo); ERPNext negative-stock validation (handled via DLQ) |
| Regression areas | none | the 008 outbox path (new event type added beside `sale.captured`); the shared `IdempotencyInterceptor` |

> **Superseded (RT-288, Inventory Planning Gate 1, recorded 2026-10-12):** the premise that ERPNext rejects negative stock (→ `permanently_rejected` / DLQ / repair queue) was superseded by Jira RT-47 D3. Negative stock is allowed on the V1 ERPNext stock path, and a negative Bin is an observable operational discrepancy, not by itself a posting failure (730, 743). How negative balances are classified in reconciliation belongs to the Inventory reconciliation decisions (923–942) and Jira RT-289, not to this artifact. Source: the owner-approved Inventory Operations baseline of 2026-10-07, decisions 719–727 (Confluence RETAIL page 22544389). Shipped code, data and history are unchanged (727).

---

## Project Structure

### Documentation (this feature)

```text
specs/015-pos-sale-posting-to-erpnext/
├── spec.md                 # Planning spec (authored, on main via #493)
├── resolution-concepts.md  # 015-RESOLVE + ratified OQ-5/6/8-bis (authored)
├── follow-up-notes.md      # inherited gates + [GATED] follow-ups (authored)
├── plan.md                 # This file (decision-gated plan)
├── data-model.md           # NEXT — any [GATED] posting-status/DLQ state + the work-item projection shape
├── tasks.md                # LATER — /speckit-tasks after data-model
└── execution-map.yaml      # LATER — slice state / allowed-files / validation contract
```

> No `research.md` is needed — the OQs are RATIFIED (rider 2026-06-05) and the
> transport (012), item identity (013), warehouse target (014), and live loop
> (008-LIVELOOP) prerequisites are all settled on `main`. The only remaining
> design decision is the posting-status/DLQ state shape, which is a `data-model.md`
> concern, not open research.

### Source Code (repository root) — *scoped, NOT authored by this plan*

> The **decided** target for the future `[GATED]`/GREEN slices. No source file is
> created by this docs-only plan. Mirrors the 008/010/013 module + worker + isolation
> pattern.

```text
apps/api/src/
└── catalog/                            # (or a new top-level `erpnext/` group — decided in tasks.md)
    └── erpnext-posting/                # NEW module — DP2-side of the 012 feed/ack
        ├── erpnext-posting.controller.ts   # connectorPullPostings (GET feed) + connectorAckOutcome (POST outcome)
        ├── erpnext-posting.service.ts        # work-item projection (O-1) + outcome ingestion + DLQ/reconciliation state
        ├── posting-work-item.projection.ts   # 015-RESOLVE: line→confirmed erpnext_item_map; store→erpnext_warehouse_map; fail-to-DLQ on miss
        └── erpnext-posting.module.ts

apps/worker/src/
└── erpnext-posting/                    # NEW — async posting trigger consumer (erpnext.posting.requested → pending work-item)
    └── posting-requested.consumer.ts   # mirrors the 008 SaleCapturedConsumer pattern

packages/db/src/
├── outbox/producer.ts                  # [GATED] add OUTBOX_EVENT_TYPES.ERPNEXT_POSTING_REQUESTED ("erpnext.posting.requested")
└── schema/…/erpnext-posting-*.ts       # NEW [GATED] (IF needed) posting-status / DLQ state — decided in data-model.md
packages/db/drizzle/
└── 00NN_erpnext_posting_*.sql          # NEW [GATED] (IF needed) migration + paired *.down.sql, RLS, tenant-scoped

packages/contracts/openapi/erpnext-connector/
└── posting-feed.yaml                   # CONSUMED AS FIXED — read-only input (NOT edited by 015)

apps/api/test/catalog/erpnext-posting/  # NEW — isolation harness (seed + RLS/cross-tenant sweep) + projection/resolve/idempotency/outcome cases
```

**Structure Decision.** 015 adds a DP2 **api module** (the feed/ack endpoints +
the work-item projection that performs `015-RESOLVE`) and a **worker** consumer
(the `erpnext.posting.requested` trigger), mirroring the 008→010→013 sibling
pattern (module + worker + isolation-harness-first tests). The **only forbidden-path
surfaces** are: the `[GATED]` `erpnext.posting.requested` event-type registration
(always required) and a `[GATED]` posting-status/DLQ schema slice (only **if**
`data-model.md` concludes new state is needed). The 012 `posting-feed.yaml` is a
**read-only input** — never edited by 015.

---

## Open-question gate (status)

All five OQs are **RATIFIED** by the signed owner rider (2026-06-05); **none remains
open**. Deviating from a ratified resolution is a STOP-and-raise (a new signed rider
required), never a silent override.

| Question | Status | Effect |
|---|---|---|
| **OQ-5** disabled/non-sales ERPNext Item | ✅ **RATIFIED (R3) — fail-to-DLQ, no substitute; sellability stays DP2-authoritative** | resolution = reconciliation case (017) |
| **OQ-6** unknown-items vs unmapped-for-posting | ✅ **RATIFIED (R4) — separate states; never route posting failures to the unknown-items queue** | resolving an unknown item still needs a confirmed 013 map |
| **OQ-7** Payment Entry in slice 1 | ✅ **RATIFIED (R1) — interim SI-only / outstanding AR; PE gated behind 4 future items** | first GREEN slice posts SI only; expect open AR |
| **OQ-8** stock path w/o DP-014 | ✅ **RATIFIED (R5) — fail-to-DLQ (`unmapped_store`); never guess** | now moot for the happy path: 014 map is on `main` (#495) |
| **OQ-8-bis** resolution side | ✅ **RATIFIED (R2) — DP2-side at projection; connector never guesses** | gated on `SaleLine.erpnextItemRef` — **satisfied** (#494) |

---

## Next step

015's spec + companions are on `main` (#493) and this plan is authored. The OQs are
ratified and **three of the four implementation prerequisites have shipped**
(008-LIVELOOP #496/#497, 014-CRUD #495, 012 `erpnextItemRef` #494). The remaining
foundational work, in order:

- **`[GATED]` `erpnext.posting.requested` event-type registration** (`packages/db`)
  — add `OUTBOX_EVENT_TYPES.ERPNEXT_POSTING_REQUESTED`; the 008-LIVELOOP
  `sale.captured` registration (#496) is the precedent. Owner approval required.
- **`/speckit-tasks` → `data-model.md`** — decide whether 015 needs new
  posting-status / work-item / DLQ state (a `[GATED]` G3 schema slice) or can derive
  the feed on-read from existing tables; define the `PostingWorkItem` projection
  shape (O-1) + the `015-RESOLVE` resolution rules.
- **`015-SCHEMA`** `[GATED]` *(only if `data-model.md` concludes new state is needed)*
  — Drizzle schema + migration + `*.down.sql`, fail-closed RLS, tenant-scoped.
- **`015-ISOLATION-HARNESS`** — seed + RLS/cross-tenant sweep (operation cases RED
  until built), mirroring 008/010/013.
- **`015-FEED` / `015-ACK` / `015-RESOLVE`** (GREEN) — the DP2-side feed projection,
  the outcome ack, and posting-time item/warehouse resolution, in the **interim
  invoice-only / outstanding-AR mode** (rider R1).

The reconciliation **run** + DLQ drain + repair surface is **017** (a separate
Spec-Kit chain). Payment Entry posting is **later, separately gated** (DP2 tender
model → 012 payment extension → connector PE → payment repair), completing the
signed target (rider R1).

Per the Agent OS operating mode, each `[GATED]` slice is dispatched separately:

```text
Use Agent OS. Execute slice 015-<NAME>. Stop before commit.
```
