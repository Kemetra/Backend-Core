# Wave Status — `019-erpnext-stock-view-contract`

> Human-readable summary of where the spec stands. 019 is the 017-deferred
> **`017-STOCK-VIEW-CONTRACT`** named by 018 as a future arc handoff: a `[GATED]`
> DP2↔connector **READ** contract for DP2 to read the connector's ERPNext-Bin
> (live on-hand) view, consumed by 017 stock reconciliation. **019 is now FULLY
> SHIPPED and LIVE-VALIDATED** — the `EMPTY_BIN_VIEW` stub that 017 shipped with
> has been replaced.

**Last updated:** 2026-10-15 — #531 multi-window marked SHIPPED (RT-174/175/176). Previously (2026-06-08): **CONTRACT + T040 + T041 ALL MERGED to `main` via PR #528 (`9a3f475`). Connector client merged (connector PR #25, `ce44129`). Full loop LIVE-VALIDATED against WSL ERPNext staging.**
**Spec:** `019-erpnext-stock-view-contract` (`specs/019-erpnext-stock-view-contract/`)
**Base:** `main` (planning chain MERGED via PR #525 `75d9967`; contract slice merged via PR #526 `88562af`; runtime + 017-rewire merged via PR #528 `9a3f475`).
**Status:** **019 CLOSED — CONTRACT + T040 + T041 all MERGED, connector client merged, loop LIVE-VALIDATED.** The CONTRACT slice (29 conformance tests) merged via PR #526 (`88562af`). The runtime + 017-rewire merged via PR #528 (`9a3f475`, 2026-06-08):

- **T040 — DP2 bin-view feed/report runtime** (`apps/api/src/catalog/erpnext-bin-view/`): `binViewPullRequests` (projects open 017 stock runs → BinViewRequest feed) + `binViewReportSnapshot` (records the connector snapshot run-scoped, O-3 idempotent, reverse-resolves erpnextItemRef→tenant_product_ref). **Option B: no new table** — recorded into `run.summary.bin_view_report` (MERGE write). **18/18** GREEN; code+security reviewed (1 HIGH keyset-pagination bug fixed; 1 HIGH idempotency-tenant-partition collapse — **resolved by PR #532 (`b08591c`)**, see §6b of `t040-runtime-design.md`).
- **T041 — 017-rewire** (`apps/worker/.../report-backed-bin-view.ts` + lifecycle): `ReportBackedBinView` replaces `EMPTY_BIN_VIEW`; the seam is per-run + string-quantity (canonical-decimal compare, §III). Lifecycle shape (a): `triggerRun` no longer auto-emits for a MAPPED store — it WAITS on the bin-view feed; `binViewReportSnapshot` emits `erpnext.reconciliation.requested` after recording → processor reads real Bin data → run completes. UNMAPPED stores still emit at trigger (complete as `unmapped_store`). **23 api + 14 worker** GREEN; no new gated surface.
- **Connector client** (separate repo `Retail-Tower-ERP-Next-Connector`, merged via connector **PR #25** `ce44129`): pull → read ERPNext Bin → report + poller; **20/20** local. Bin doctype confirmed live against `retail.localhost`. Loud `WindowOverflowError` guard for >500-item warehouses.
- **Idempotency security fix** (PR #532 `b08591c`, 2026-06-08) — `IdempotencyInterceptor` now falls back to `req.principal?.tenantId` when `req.context` is absent, fixing the cross-tenant idempotency-partition collapse that affected the 019 report route (+ 015 ack). 85/85 idempotency suite green. Closes issue #530.

**Live exercise PASSED (2026-06-08):** Full loop ran against the real WSL ERPNext staging (`devcontainer-frappe-1`, `retail.localhost`). Empty-Bin run → completed `counts {}`. Non-empty run (ERPNext qty 10 vs DP2 on-hand 10) → completed `counts {match: 1}`. 019 is functionally LIVE-VALIDATED.

### Slice ledger
| Slice | Tests | Notes |
|---|---|---|
| SETUP (T001/T002) | — | deps confirmed; posting-feed conventions re-read |
| RED (T011) | 29 fail | conformance spec fails for the right reason: contract absent (`loaded ids: [posting-feed]`) |
| `[GATED]` CONTRACT (T010) + US1/US2/US3 (T012/13, T020-22, T030/31) | 29/29 GREEN | `stock-view.yaml` authored; exact-decimal quantity, NO valuation, connectorBearer, closed error set incl. `snapshot_required`, `runRef` correlation, `readAt`/`recordedAt` split, idempotent-replay header; HIGH fix: `BinViewItemWindow` (≤500-item window, truncation-safe); MED fixes: `erpnextWarehouseRef`+`readAt` echoed on `RecordedBinView`; `stockUom` on `BinEntry` |
| T090 | OK | contract self-documents §IX/OQ-1/013-translation/O-6/017-rewire (11 refs) |
| T092 | OK | build clean; no regression (posting-feed 31/31) |
| T040 — bin-view feed/report runtime | 18/18 GREEN | MERGED PR #528 `9a3f475` |
| T041 — 017-rewire (`ReportBackedBinView`) | 23 api + 14 worker GREEN | MERGED PR #528 `9a3f475`; replaces `EMPTY_BIN_VIEW` |
| Idempotency fix (#530) | 85/85 GREEN | MERGED PR #532 `b08591c` |
| Connector client (PR #25) | 20/20 GREEN | MERGED connector repo `ce44129` |
| T042 — live cross-system exercise | PASSED 2026-06-08 | Empty-Bin → `{}`; ERPNext 10 / DP2 10 → `{match: 1}` |

### Artifacts on `main` (PRs #526 + #528 + #532)
`spec.md` · `plan.md` (Constitution Check, all PASS) · `research.md` (R1–R9) · `data-model.md` (wire entities updated; **no new table, no migration** — read-only view) · `tasks.md` · `analysis.md` (0 CRITICAL / 0 HIGH / 1 MED / 5 LOW / 1 INFO) · `review.md` · `t040-runtime-design.md` · **`packages/contracts/openapi/erpnext-connector/stock-view.yaml`** (`[GATED]`, 629 lines) · **`apps/api/test/erpnext-connector/contract/stock-view.contract.spec.ts`** (544 lines, 29 tests) · **`apps/api/src/catalog/erpnext-bin-view/`** (T040 module) · **`apps/worker/.../report-backed-bin-view.ts`** (T041 rewire).

### Key resolved design decisions
- Connector is the HTTP **client**; DP2 is the **server** (§IX no-outbound-HTTP invariant).
- **Pull-request + report** idiom mirroring 012's `connectorPullPostings` / `connectorAckOutcome`.
- **NO standing Bin mirror** (signed 014 stock-impact decision — DP2 = operational on-hand authority, ERPNext = valuation); run-scoped evidence lives in 017 `result.detail`, so 019 touches **no `packages/db` surface** and needs **no migration**.
- Items keyed by `erpnextItemRef`, DP2-side-translated to `tenant_product_ref` via the confirmed 013 map.
- The 017 sync→async run-lifecycle rewire **shipped as T041** (PR #528) — `ReportBackedBinView` replaced `EMPTY_BIN_VIEW`; `triggerRun` now WAITS on the bin-view feed for mapped stores.

### Deferrals / open follow-ups
- **~~Cross-system live-leg exercise (T042)~~** — **PASSED 2026-06-08** (empty-Bin + non-empty/match:1 runs against WSL staging). CLOSED.
- **~~MED finding F-03 (contract inert / EMPTY_BIN_VIEW)~~** — **RESOLVED**: T041 (PR #528) replaced `EMPTY_BIN_VIEW`; connector client merged (connector PR #25). CLOSED.
- **~~T040 / T041 pending approval~~** — **MERGED** via PR #528 (`9a3f475`). CLOSED.
- **~~Issue #530 — idempotency-tenant-partition collapse~~** — **FIXED** by PR #532 (`b08591c`). CLOSED.
- **Open — issue #529**: OTel SDK construction hangs api boot at module-load; needs an env-guard. Not a 019 issue — pre-existing.
- **~~Issue #531 — multi-window bin-view for >500-item warehouses~~** — **SHIPPED** as connector-driven paging (design: Jira RT-21): contract v1.2 `4afbe25`/`0e9a157` (RT-174), runtime `95abc3e` / PR #691 (RT-175), connector paged Bin read `3e23aa3` / connector PR #56 (RT-176). Resumable attempts (RT-187): decided 2026-10-17 — accept the limit and alert, keep a resumable design dormant until pilot evidence; see `docs/planning/rt-187-resumable-bin-view-attempts.md`.

### Next recommended action
019 is **FULLY CLOSED and LIVE-VALIDATED**. The loop (DP2 feed/report ↔ connector ↔ ERPNext Bin) ran end-to-end on 2026-06-08. Open follow-up (#529 OTel boot hang) is lower-priority (#531 multi-window has since shipped, see above) and not 019-owned. The next ERPNext-arc work is gated: **020** (connector health) is self-contained; **021** (product-master recon) and the cross-system live legs remain blocked on #524 (connector repo + staging ERPNext).
