# RT-547 + RT-548 — POS `readSale`: receipt line order and read audit (planning record)

**Status:** PLAN. Work Mode: Planning. Parent: RT-2. Both tickets are follow-ups of RT-534 (findings F4 and F5).
**Route:** `GET /api/pos/v1/sales/{saleRef}` (`operationId: readSale`, `sales.controller.ts` `readSale`, `sales.service.ts` `readSaleProjection`).
**What this document does:** it plans two bounded changes to the one route: the order of its lines (RT-547) and an audit event for it (RT-548). It describes the proposed contract wording. It changes no code, contract, migration or package.
**Decisions:** the owner decisions below were selected under the owner's standing delegation (see §4). The owner may revisit any of them.

---

## 0. Baseline and "already executed?" check

| Item | Value |
| --- | --- |
| Repo | Kemetra/Backend-Core |
| `origin/main` | `ff9e683` (RT-669, #819), fetched 2026-10-17 |
| Jira | RT-547 and RT-548: To Do, no comments. RT-567: To Do (sibling, running in parallel) |
| Code on `main` | `readSaleProjection` still loads lines `ORDER BY sl.line_name` (`sales.service.ts:517`). `readSale` has no `@Auditable` (`sales.controller.ts:316`) |

Neither ticket was executed before. `git log origin/main` and a grep for RT-547 / RT-548 found nothing.

What changed since the tickets were written (they cite `main@9f2b0428`):

* **The dependency is satisfied.** Migration `0047_sale_history_capture` (RT-538) added `sale_lines.line_seq` (nullable integer, `CHECK line_seq IS NULL OR line_seq >= 1`). Capture writes each line's 1-based position in `lines[]` as `line_seq` (`insertSaleLines`, `sales.service.ts:1030-1061`, sales.yaml 1.9.0). Every sale captured since that deploy has a recorded order. Older sales have `line_seq` NULL on every line.
* **The RT-534 detail read exists and is audited.** `GET /api/pos/v1/sale-history/{saleRef}` (RT-539) orders lines `ORDER BY sl.line_seq NULLS LAST, sl.line_name, sl.id` and returns `lineOrder: recorded | not_recorded` plus a per-line `sequence`. It is `@Auditable("sale_history.detail_read")`. So the RT-548 clause "and to the new RT-534 detail read (RT-539)" is **already done**. Only `readSale` remains.
* **OD-534-7 (are reads audited?) was answered yes** and applied: `sale_history.listed`, `sale_history.detail_read`, `sale.receipt.reprinted`, `console_sales.listed` and `console_sales.detail_read` all ship. `readSale` is the one sale read that was missed.

## 1. RT-547 — line order

### 1.1 Finding (re-verified on `ff9e683`)

* `readSaleProjection` sorts lines by `line_name`. The receipt order is lost on this route even for sales whose `line_seq` is recorded.
* `readSaleProjection` serves three paths, so all three get name order today:
  1. `readSale` (POS void/return screen, duplicate-replay confirmation);
  2. the `captureSale` 201 response;
  3. the `captureSale` replay response (the 200 + `Idempotent-Replayed`).
* Other readers already ignore names. The posting feed uses `ORDER BY sl.id` (`posting-work-item.projection.ts:271`). The sale-history detail uses `line_seq`.

### 1.2 Options

| | Order | Legacy rows (`line_seq` NULL) | Wire change |
| --- | --- | --- | --- |
| **A** | `ORDER BY sl.line_seq NULLS LAST, sl.line_name, sl.id`, the same key as the sale-history detail | Name order, then `id` as a deterministic tiebreak (today's order, plus a tiebreak for duplicate names) | None. The `readSale` description states the order |
| B | As A | As A | A adds `sequence` per `SaleLine` and `lineOrder` on `Sale` |
| C | `line_seq`, else `id` | `id` order (UUIDv7) | None |

**A is recommended.**

* **Why not B (yet):**
  * `Sale` and `SaleLine` are `additionalProperties: false`. A new response field is the 033 situation again: if the POS validates responses strictly, its contract pin must move in the same release.
  * Nothing needs the fields today. The screen that shows a receipt (history detail, reprint) already reads `sale-history`, which carries `sequence` and `lineOrder`. The `readSale` consumers (void/return, replay confirmation) need a stable, sensible order, not a label.
  * B stays open as a later additive change if a `readSale` consumer asks for it.
* **Why not C:**
  * C relies on UUIDv7 ids being monotonic within one capture loop. `newId()` is `uuid` v7. Whether the installed version guarantees sub-millisecond monotonicity is **NOT VERIFIED**.
  * C also breaks the alignment with the sale-history detail. The same legacy sale would list in two orders on two POS screens.

### 1.3 Proposed change (implementation ticket; not authorized here)

* `sales.service.ts` `readSaleProjection`: change the lines query to `ORDER BY sl.line_seq NULLS LAST, sl.line_name, sl.id`. No new column is read and no projection field is added (option A).
* **Contract (`[GATED]` contract edit; description only):** in `pos-sales/sales.yaml`, add to the `readSale` description and to the `Sale.lines` description:
  > Lines are in their original receipt order (capture `lines[]` order, RT-538) when it is recorded. A sale captured before the order was recorded lists its lines by name, then by `lineRef`: a stable order that is not the receipt order.
* **Version bump:** the minor version moves (`1.11.0-draft` → next), and the changelog notes the ordering.
* **No schema change.** No migration and no data backfill: legacy rows cannot be backfilled, because the order was never stored.
* **Compatibility:**
  * The response shape is unchanged. Clients that match lines by `lineRef` are unaffected.
  * **Replay across the deploy:** a `captureSale` replay served after the deploy, for a sale first answered before it, can list the same lines in a different order than the original 201. FR-100 promises an identical body.
    * Two cases are affected:
      * sales captured after 0047 (they have `line_seq`) and before the fix deploys, whose capture order was not alphabetical;
      * any sale, pre-0047 included, that has two or more lines with the same `line_name`. Today's `ORDER BY sl.line_name` leaves the relative order of equal names unspecified (in practice, whatever plan order Postgres returns), and the new key pins it to `id`. Those lines can swap places even on a sale with no `line_seq`. The same holds between two plain reads today: the current order of equal names is not guaranteed stable either, so the new tiebreak is a fix as well as a change.
    * The line set and every line's fields are unchanged; only their array order differs. Whether the POS compares replay bodies by array position is **NOT VERIFIED**. The risk is accepted and noted in the changelog. No mitigation code is proposed.
* **Tests (to write in the implementation PR):**
  * Capture lines in a non-alphabetical order, for example `["Zeta", "Alpha", "Mid"]`. Assert that `readSale`, the 201 response and the replay all return capture order.
  * A legacy fixture with all `line_seq` NULL, including two lines with the same name, returns name-then-`lineRef` order.
  * A replay of that legacy duplicate-name sale returns the same name-then-`lineRef` order as `readSale`, and two consecutive reads return an identical body (the tiebreak makes the order deterministic).
  * Grep the existing `apps/api/test/catalog/sales/**` suites for any assertion on name order by index (for example `lines[0]` after mixed names), and update each one in the same PR.
* **Repo:** Backend-Core only. POS needs no change under A.

## 2. RT-548 — read audit

### 2.1 Finding (re-verified on `ff9e683`)

* `readSale` has only `@UseGuards(PosOperatorAuthGuard, TenantContextGuard)`. No `@Auditable`, so a POS operator's full read of a sale (lines, amounts, tenders, responsibilities) leaves no `audit_events` row.
* Every comparable read is audited:

  | Route | Action |
  | --- | --- |
  | `GET /api/pos/v1/sale-history` | `sale_history.listed` |
  | `GET /api/pos/v1/sale-history/{saleRef}` | `sale_history.detail_read` |
  | `GET /api/v1/sales` (console) | `console_sales.listed` |
  | `GET /api/v1/sales/{saleRef}` (console) | `console_sales.detail_read` |

* `AuditEmitterInterceptor` is global (`APP_INTERCEPTOR`). It runs on GET routes and emits after a successful response only, fire-and-forget. It takes tenant and store from `request.context` and the actor from `request.principal.userId`. It copies `annotateAudit` metadata, and `target_type` / `target_id` stay null.
* `PosOperatorAuthGuard` does **not** set `request.posDeviceId`; only the envelope, device and rotation guards do. So the calling device is not available to `readSale` today.

### 2.2 Proposed event

| Field | Value |
| --- | --- |
| Action | **`pos_sales.detail_read`** (OD-548-1) |
| Emitted | Once per `200` from `readSale`, through `@Auditable` + the global interceptor (the `sale_history.detail_read` / `console_sales.detail_read` precedent). Not emitted on 401/404/500, and not on the `captureSale` responses that reuse the projection |
| `actor_user_id` | The operator's `principal.userId` (interceptor default) |
| `tenant_id` / `store_id` | `request.context` (interceptor default). `readSale` already refuses a null tenant or store |
| `target_type` / `target_id` | null (interceptor limitation, unchanged) |
| `metadata` | `{ "sale_ref": "<uuid>" }`, set with `annotateAudit` after the projection resolves |

**Metadata limits and PII rules** (Constitution §XIII/§XIV, FR-AUDIT-3, the `annotateAudit` doc comment):

* **Identifiers only.** `sale_ref` (a UUID that already passed `SALE_REF_RE`) is the only key.
* **Never included:**
  * line names, amounts, quantities or totals;
  * tender method/amount/reference;
  * payer or responsibility data;
  * receipt content;
  * customer data;
  * the bearer token;
  * any request header.
* **No `device_id` in v1** (OD-548-2). `PosOperatorAuthGuard` does not expose one. Adding it means changing a shared auth guard, which is outside RT-548's bounds. Whether an investigation can recover the device from `actor_user_id` + time through the token/session tables is NOT VERIFIED here. If it cannot, `device_id` is a follow-up that needs the guard change.
* **Size:** one key, under 100 bytes. No free-text field is allowed into this metadata.

**Contract (`[GATED]` contract edit; documentation only):**

* In `pos-sales/sales.yaml`, add `x-audit-action: pos_sales.detail_read` to `readSale`.
* Add one sentence to its description, mirroring `sale-history.yaml`:
  > Audit (OD-534-7, RT-548): one `pos_sales.detail_read` event per authorized `200`, with the sale ref in its metadata. No sale content is recorded.
* The contract spec gains the "names its audit action" assertion that `sale-history.contract.spec.ts:232` already has.

**Tests (to write in the implementation PR):**

* An HTTP integration test with the enqueuer overridden (the existing pattern) asserts:
  * one payload with `action = pos_sales.detail_read`, the operator's user id, the tenant and store, and `metadata = { sale_ref }`;
  * **no** payload on a 404 (cross-store / absent sale) and none on a 401;
  * **no** `pos_sales.detail_read` payload on `captureSale`.
* A metadata key allowlist assertion (exact keys equal `["sale_ref"]`).

### 2.3 Volume and delivery

* `readSale` is called on every void/return start and on duplicate-replay confirmation. That is one more event per such action, the same order of magnitude as `sale.voided` / `sale.returned` themselves. This is acceptable, and is the cost OD-534-7 already accepted for the other reads.
* Delivery stays best-effort: the event is lost if the enqueue fails (logged, RT-124). Durable fan-out in production depends on the audit worker deployment, which is **NOT VERIFIED** here (as RT-548 notes). That check is an ops item, not part of this change (see §5).
* `readSale` is not audited on refusal. The reprint audit writes refusals in-transaction, but that is a write with a recorded outcome. A refused read discloses nothing (non-disclosing 404), and the console and sale-history reads also skip refusals.

### 2.4 Interaction with RT-567 (audit action categories, sibling planning ticket)

* RT-567 decides how `listAuditEvents` excludes read-only actions. Its options are an `exclude_reads` filter, an action category field, or a prefix include/exclude list. It is not blocked by this plan, and this plan does not wait for it.
* **`pos_sales.detail_read` is classifiable as a read under all three RT-567 options:**
  * **Suffix rule:** it ends in `.detail_read`, like `sale_history.detail_read` and `console_sales.detail_read`.
  * **Prefix rule:** `pos_sales.` is a read-only namespace, like `console_sales.`. The alternative `sale.read` / `sale.detail_read` would share the `sale.` prefix with the write actions `sale.captured`, `sale.voided`, `sale.returned`, `sale.refunded` and `sale.credit_reversed`, so a prefix exclusion would drop the writes with it. That is the main reason for OD-548-1.
  * **Category field:** RT-567 must list this action as `read` in whatever catalog it defines. **Handoff:** add `pos_sales.detail_read` to the RT-567 read-action inventory. If RT-567 merges first, the RT-548 implementation PR adds the action to its catalog. If RT-548 merges first, RT-567's inventory must include it.
* No RT-567 decision changes this plan. If RT-567 picks a category field that is set at emit time, the RT-548 implementation sets `read` like every other read.

## 3. Sequencing

1. RT-547 and RT-548 touch the same route and the same contract file. **One implementation PR** for both is fine, and avoids two `sales.yaml` version bumps.
2. Both contract edits are `[GATED]`, description and extension only, and need explicit authorization on the implementation ticket.
3. No migration, package, lockfile or CI change. Backend-Core only. No POS change (option A adds no field. The POS can ignore the audit).

## 4. Decisions

| ID | Question | Options | Selected |
| --- | --- | --- | --- |
| OD-547-1 | Order key for `readSale` lines | **A** `line_seq NULLS LAST, line_name, id` (Recommended) · B = A + `sequence`/`lineOrder` on the wire · C `line_seq`, else `id` | **A.** Selected (the recommended option), chosen by the coordinator under the owner's standing delegation of 2026-10-17. The owner may revisit |
| OD-547-2 | Legacy rows (no `line_seq`) | **Name, then `lineRef` (stable, not receipt order), documented** (Recommended) · `id` order (UUIDv7 monotonicity not verified) | **Name then `lineRef`.** Selected (the recommended option), chosen by the coordinator under the owner's standing delegation of 2026-10-17. The owner may revisit |
| OD-548-1 | Action name | **`pos_sales.detail_read`** (Recommended) · `sale.read` (ticket's placeholder) · `sale.detail_read` | **`pos_sales.detail_read`.** Selected (the recommended option), chosen by the coordinator under the owner's standing delegation of 2026-10-17. The owner may revisit |
| OD-548-2 | Metadata keys | **`sale_ref` only** (Recommended) · `sale_ref` + `device_id` (needs a `PosOperatorAuthGuard` change) | **`sale_ref` only.** Selected (the recommended option), chosen by the coordinator under the owner's standing delegation of 2026-10-17. The owner may revisit |
| OD-548-3 | Audit refusals (401/404)? | **No, success only, like the other reads** (Recommended) · Yes, in-transaction like the reprint | **No.** Selected (the recommended option), chosen by the coordinator under the owner's standing delegation of 2026-10-17. The owner may revisit |

## 5. Risks and gaps

* **NOT VERIFIED:** production audit-worker durability. In non-production the enqueuer is `NoOpAuditJobEnqueuer`. This is an ops check that applies to every `@Auditable` route, not just this one.
* **NOT VERIFIED:** POS strict-vs-lenient response validation. It does not matter under A (no new field). It matters if B is ever taken.
* **NOT VERIFIED:** whether any existing test asserts name order by index. It must be checked in the implementation PR (§1.3).
* **Accepted:** the one-time replay body order change across the deploy (§1.3). It covers post-0047 sales captured in non-alphabetical order, and duplicate-name lines on any sale, legacy included.

## 6. Next safe action

Open one Backend-Core **Implementation** ticket for RT-547 + RT-548. Its scope:

* the `readSaleProjection` ORDER BY change;
* `@Auditable("pos_sales.detail_read")` + `annotateAudit({ sale_ref })` on `readSale`;
* the `[GATED]` `sales.yaml` description, `x-audit-action` and version edits;
* the tests in §1.3 and §2.2.

The ticket carries explicit `[GATED]` authorization for the contract edit.
