# Plan 045 — Versioned Return Policy V1 (gate G5)

Jira RT-272 (Planning, epic RT-6). This plan answers gate **G5, Return Policy**, from *Sales & Returns Operations*. It proposes the V1 policy shape, how a return freezes the revision it was judged under, the `[GATED]` slices, and an owner-decision list (§7). **No OpenAPI, migration, runtime, package or CI file is changed by this plan.** Every OD-272-n below is **PROPOSED** until the owner ratifies it.

The plan builds on decisions that are already ratified. It does not re-decide them:

| Source | What it fixes for G5 |
|---|---|
| *Sales & Returns Decisions 991–1046* §D (Confluence 22904843), owner-approved 2026-10-07 | 1035 first-class policy; 1036 versioned and effective-dated; 1037 the Sale snapshot keeps the applicable version; 1038 not retroactive by default; 1039 law overrides commercial policy; 1040 the window anchors on completed-sale business time; 1041/1042 returnability exceptions and Final Sale; 1043/1044 typed line-level reasons, note where required; 1045 thresholds come from Policy, not POS constants; 1046 the approval binding |
| RT-271 R-1 to R-12 (planning c11872, owner ratification c11886) | Four facts (acceptance, derived obligation, execution, implicit disposition). **R-12: pilot returns are cash-only, for all-cash sales only.** R-6: tender-unknown legacy sales allow a cash allocation. R-8: 1050 stays POS-enforced |
| RT-114 C1–C10 (c10764, ratified c11721) and the 2026-10-07 reconciliation in its description | Manager Approval PIN; the approval envelope (C7) widened by 1046 to lines, quantities, amount, reason, refund method and **policy version**; **C5: returns stay online-only (I-16)**; C6: a manager or admin session acts directly, with no approval record; "return approval" and "different-instrument refund" are reserved action kinds |
| RT-284 P-A to P-H, Q1–Q8, Q10, Q11 (c11873, ratified c11887) | A narrow store is absorbed later (PE-ABS); facts freeze the version they used (P-E); offline modes `allow_cached` / `deny_if_stale` / `online_only` (P-F); store overrides default to `stricter_only` (Q5); the Console is a control surface only (P-G) |
| AD-CASH-001 / spec 040, implemented by RT-385 / RT-387 | The precedent: immutable revisions in a linear chain, Apply Now, pure resolution, an ETag/304 device read, attributed audit |

## Baselines

| Repo | Ref | Note |
|---|---|---|
| Backend-Core | `origin/main` `046b7f7c` | read for this plan |
| POS | `origin/main` `763b7f6c` | read for this plan (returns flow and approval catalogue) |
| Admin-Console, Connector | not re-read | no return-policy consumer exists (RT-271 A-1, C-1 to C-4) |

Confluence pages are taken from their summaries in RT-272, RT-271, RT-114 and RT-284. They were not re-read.

## 1. Facts on `main` (what decides returns today)

| # | Fact | Where |
|---|---|---|
| F-1 | **There is no return window, returnability rule, reason catalogue or approval on returns.** `recordReturn` locks the sale, replays by provenance, refuses credit and voided sales, prices lines from the frozen sale line, checks the cumulative quantity and that the tenders sum to the total. | `apps/api/src/catalog/sales/sale-returns.service.ts:1-21,101-117` |
| F-2 | The only reason field is an **optional, free-text, return-level** `reason` (1–500 chars). Nothing is line-level or typed. | `dto/record-return-request.dto.ts:45`; `pos-sales/sales.yaml` 1.12.0-draft `:1761-1765` |
| F-3 | Refund tenders are `{method: 'cash', amount}` only (RT-271 BC-5). | `dto/record-return-request.dto.ts:26-31` |
| F-4 | A return's business date is the server's store-day at insert: `(now() AT TIME ZONE <store tz>)::date`. The sale has its own `business_date` and the POS-clock `occurred_at`, plus a server `received_at`. | `sale-returns.service.ts:272-283`; `packages/db/drizzle/0012_sales.sql` (`sales`) |
| F-5 | `sale_lines` keeps a nullable `tenant_product_ref`, **no category snapshot**. The category is the product's current `category_id` (`ON DELETE SET NULL`). | `0012_sales.sql` (`sale_lines`); `0007_catalog.sql:145` |
| F-6 | The route is behind `POS_RETURNS_ENABLED` (default off, 404) and `PosOperatorEnvelopeSaleGuard`. The guard re-verifies the operator live through `OperatorReverifier.reverify`, which refuses any membership role outside `{owner, tenant_admin, store_manager}`. **There is no return-specific role or capability check.** Not traced: whether a cashier-admission envelope can reach this route by another path. | `sales.controller.ts:410-427`; `returns-gate.ts:14-17`; `auth/pos-operator-envelope-sale.guard.ts:14-23`; `auth/operator-context-resolver.ts:65,310-328` |
| F-7 | **Precedent, policy store:** `cash_variance_policy_revisions` holds immutable tenant/store revisions in a linear `supersedes_revision_id` chain (a concurrent publish → 23505 → 409), Apply Now by CHECK, derived state, tenant RLS ENABLE+FORCE, append-only. Resolution is pure (`latestAt` / `effectiveAt`, no DB, no clock). The device read is ETag/304. Publishes write an attributed audit row. | `0050_shift_variance_policy.sql`; `apps/api/src/cash-variance-policy/policy-resolution.ts`, `policy-device.controller.ts`, `policy-audit.ts` |
| F-8 | **Precedent, approval evidence:** a void records `approval_id`, approver, requester, `approval_policy_version`, `approved_at` (all-or-none), single-use per tenant. That `approval_policy_version` is RT-114's **approval-policy** label, not a business-policy revision. | `0046_sale_void_approval.sql` |
| P-1 | POS returns require a manager/admin session, an online `readSale`, a same-terminal sale and an all-cash sale. Offline is refused (`offline`). | POS `src/main/returns/returns-service.ts:6-8,250`; `returns-tender.ts` |
| P-2 | POS `line_not_returnable` / `nothing_returnable` are **quantity** checks only. | POS `src/main/returns/returns-quote.ts:54,83` |
| P-3 | The POS sends no reason. The return journal stores the exact request bytes, the state and the refusal reason; it has no policy column. | POS `returns-wire.ts`; `migrations/0039_create_return_journal.sql` |
| P-4 | The RT-114 catalogue has 12 kinds (with `sale.void`, RT-530). **No return kind.** | POS `src/shared/operator/manager-action-kinds.ts:11-26` |
| P-5 | The POS has **no** cash-variance policy client on `main` (RT-388 not landed). There is no POS policy-cache code to reuse yet. | grep over POS `src` |

## 2. What V1 must express (minimal for the pilot)

V1 is a **tenant** policy. A field is either **configurable** (the tenant publishes a value) or **locked** (a V1 constant written into the contract, so a later version can open it additively).

| Rule | V1 | Kind | Decision |
|---|---|---|---|
| Return window | `windowDays`, integer 0–365. Deadline = sale `business_date` + `windowDays` (store calendar days). Accepted when the return's store-day (F-4) ≤ the deadline. `0` = same business day only. | configurable | 1040; OD-272-4 |
| Legal floor | A System-locked minimum window. Applied at publish (a lower value → 422) **and** at evaluation, so the law protects old revisions too. | locked (System) | 1039; OD-272-5 |
| Receipt | Required: the sale must be identified (today's lookup). No-receipt returns are deferred (1071). | locked `required` | — |
| Non-returnable categories | A set of `tenant_product_categories` ids. A line whose product's category is in the set is refused. | configurable | 1041; OD-272-7 |
| Final Sale | Not in V1 (needs a sale-time line flag). | deferred | 1042; §6 |
| Reasons | A closed **system** catalogue of codes, line-level `reasonCode` + `reasonNote` (the note required for `other`). Optional on the wire in V1. | locked catalogue | 1043/1044; OD-272-8 |
| Approval | No threshold in V1: returns stay **manager/admin-session-only** (P-1), and a manager acts directly (RT-114 C6). The threshold design is ready for V1.1 (§5). | locked | 1045/1046; OD-272-9 |
| Refund tender | Original tender, cash, all-cash sales (RT-271 R-12). Not a policy field in V1. | locked | 1057/1058 |
| Scope | System default → Tenant. No store override in V1. | — | OD-272-2 |

**Effect on the pilot.** Compared with `main`, V1 adds exactly three refusals, all decided by Backend-Core: window expired, category excluded, and an invalid reason code. Everything else keeps today's behaviour.

## 3. Versioning and the frozen revision

**Storage (OD-272-1).** A narrow `return_policy_revisions` store, the F-7 pattern:

- immutable revisions, one linear chain per tenant;
- Apply Now (`effective_from = created_at`);
- publish with `expectedRevisionId` (stale → 409) and a required `reason`;
- excluded categories in an append-only child table with an FK, not an array;
- derived state (`current` / `superseded`);
- tenant RLS ENABLE+FORCE, append-only.

RT-284 PE-ABS absorbs it into the engine's tenant-wide `policy_version` later, with no wire change, as planned for AD-CASH-001.

**Where the revision freezes (OD-272-3, the central decision).**

1. **On the sale, by the server (1037).** At sale insert, Backend-Core stamps `sales.return_policy_revision_id`: the tenant revision effective at the sale's completion instant, `LEAST(occurred_at, received_at)`.
   - The clamp stops a fast POS clock from picking a revision published after the server received the sale.
   - An offline sale synced after a policy change gets the revision that was in force when it was sold (1038).
   - `NULL` means the System default applied, either because no tenant revision existed or because the sale predates the migration. **No backfill.** Because revisions are immutable, an as-of lookup at return time gives the same answer. The stamp exists so the fact says so itself (RT-284 P-E), not for correctness.
   - The stamp is server-derived and outside the sale's `payload_hash`, so sale replays are unchanged.
2. **On the return (1038, 1046).** `sale_returns` records the revision it was judged under (the sale's stamp), its `policySource` (`system` | `tenant`), the computed `windowEndsOn`, and the legal floor that applied. The response echoes these values.
3. **Not retroactive.** A later revision never changes the verdict for an earlier sale. The only exception is the legal floor (1039), which applies at evaluation time.

**Edge case, stated not solved.** Resolution is by instant, not by day. Two sales on the same business day around a publish can carry different revisions. This is accepted, because each sale's revision is the one in force when it completed.

**Enforcement.** Backend-Core evaluates the policy in `recordReturn` under the existing `sales` row lock. The evaluation runs after the void and credit checks and before line pricing, and a failure is a 422 that records nothing. A POS-only check would repeat RT-271's BC-5 gap. New codes:

- `return_window_expired`;
- `return_line_not_returnable` (carrying `lineRef` and `reason: category_excluded | category_unknown`);
- `return_reason_invalid`.

## 4. POS behaviour, offline and audit

**Eligibility before submit (OD-272-10).** V1 needs **no POS policy cache.** Returns are online-only (RT-114 C5), and the POS already makes an online `readSale` before every return (P-1).

- Backend-Core adds a read: `GET /api/pos/v1/sales/{saleRef}/return-eligibility`, with the same device and operator authentication as `readSale`.
- It answers the frozen revision, `windowEndsOn`, and a per-line returnable verdict with a reason.
- The POS shows it before line selection. Backend-Core still re-decides at submit.
- It is a new operation, so `readSale`'s response schema does not change (spec 040 Δ2, strict response validation).

**Offline (fail-closed).** In RT-284 terms the V1 policy is `online_only`.

- Offline, the POS keeps today's `offline` refusal (P-1).
- When the eligibility read is unreachable or returns 404 (an older Backend-Core), the POS refuses with `returns_unavailable`. It does not guess.
- A cached revision becomes necessary only with offline returns (1099, deferred). Those would use the RT-284 P-F device bundle under `deny_if_stale`, and fail closed when never fetched (Q10).

**POS local data.** If the POS stores the echoed `returnPolicyRevisionId` and the line reason codes on its journal, it needs a local migration that adds the columns to `return_journal` / `return_journal_lines`. This is `[GATED]` (RP-4). The request bytes already carry the reason codes, so the slip and audit could read them from there instead. RP-4 decides; the safe default is the migration.

**Audit.**

- Each publish writes one `audit_events` row: actor, old and new values, `reason`, revision id (the `policy-audit.ts` pattern), action `return_policy.published`.
- The eligibility read is `@Auditable("return_policy.eligibility_read")`.
- A 422 policy refusal stores nothing server-side; the POS audits it locally as it already audits refusals.
- The return fact itself carries the revision (§3).

**Admin-Console editing (later slice, OD-272-11).**

- Backend-Core ships the admin API with the runtime: read effective, publish, list revisions.
- Roles: `owner` and `tenant_admin`, with a session-only guard (the RT-383 / RT-387 posture).
- The Console UI is a later slice (RP-5). Until then the owner publishes the pilot tenant's revision through the API before returns are enabled.

## 5. Approval design for V1.1 (designed now, not built)

When cashier returns open, the work is:

- add the policy field `cashierReturnLimit` (an exact decimal plus `currencyCode`; `null` = cashiers cannot return);
- add the RT-114 action kind `return.approve` (reserved in the RT-114 reconciliation). It grows only by contract.

The C7 envelope widens per 1046. It binds the sale ref, each `(lineRef, quantity)`, the return total, the line reason codes, the refund method and the **return-policy revision id**. Any change to these forces a new approval. Backend-Core stores the approval evidence on `sale_returns` in the F-8 pattern, all-or-none and single-use per tenant. It keeps two version columns, `approval_policy_version` (RT-114) and `return_policy_revision_id` (this plan), because they are different things. The same mechanism serves "different-instrument refund" (1058).

## 6. Deferred (out of V1)

- Store overrides. When they come, they follow RT-284 Q5 `stricter_only`: a shorter window, more exclusions.
- Final Sale line flag (1042).
- A category snapshot on `sale_lines`.
- No-receipt returns (1071).
- Offline returns and the cached bundle (1099).
- Store credit and different-instrument refunds (1058, 1061).
- Exceptions and override by approval.
- Scheduled activation. Apply Now only, as DR-12.

## 7. Owner decisions (OD-272-n). Recommendation first

| # | Decision | Recommended | Alternatives |
|---|---|---|---|
| OD-272-1 | Where the policy lives | A narrow `return_policy_revisions` store now, in the F-7 pattern, absorbed by RT-284 PE-ABS later | Wait for the RT-284 engine (PE-BC1 onward not created): it blocks G5 for the pilot |
| OD-272-2 | Scope in V1 | System default → Tenant only | Add store overrides now, `stricter_only`, which needs a per-field "stricter" rule for a multi-field policy |
| OD-272-3 | Where the revision freezes | Backend-Core stamps the sale at insert as of `LEAST(occurred_at, received_at)`; the return records the revision it was judged under; legacy `NULL` = System default, no backfill (§3) | (a) The POS stamps it at capture: a POS cache, a sale-capture contract change, a POS migration and accept-and-flag. (c) Judge under the current revision: violates 1038 |
| OD-272-4 | Window anchor and unit | Store calendar days: return store-day ≤ sale `business_date` + `windowDays` | Elapsed hours from `occurred_at`: POS clock skew, DST, and harder for staff to explain |
| OD-272-5 | Legal floor (1039) | A System-locked minimum window, applied at publish and at evaluation. **The owner or legal supplies the value**; this plan proposes no number | No floor: the tenant is responsible for compliance |
| OD-272-6 | System default for a tenant that never published | `windowDays` = the legal floor, no excluded categories. Returns are not enabled in an environment until the floor value is set | Fail closed (`return_policy_not_configured`) until the tenant publishes. Sales sold before the first publish could then never be returned |
| OD-272-7 | How excluded categories are evaluated | The product's **current** category at return time. This is retroactive for a product moved between categories, and the plan says so. A line with no product or no category is refused (`category_unknown`) only when the excluded set is non-empty | Snapshot the category on `sale_lines` at sale insert, server-side: non-retroactive, but one more `[GATED]` column on a hot table and a change to the sale-capture runtime |
| OD-272-8 | Reasons | Closed system catalogue `defective`, `wrong_item`, `not_as_described`, `changed_mind`, `other` (note required). Line-level, optional on the wire in V1, validated when present; made required by a later contract bump once the POS sends it. The header `reason` stays | Tenant-defined codes (needs Console and versioning); required at once (needs the POS and Backend-Core released together) |
| OD-272-9 | Approval thresholds | None in V1. Returns stay manager/admin-only, and §5 is the V1.1 design | `cashierReturnLimit` + `return.approve` in V1: a new RT-114 kind, Backend-Core approval evidence, POS approval UI |
| OD-272-10 | POS eligibility channel | A new online `return-eligibility` read, no POS cache, fail-closed when unavailable | A device policy read plus a cache, as for the variance policy. Needed only for offline returns |
| OD-272-11 | Editing before the Console | The Backend-Core admin API ships with the runtime; the owner publishes via the API; Console UI later | The Console UI in the same wave: delays the pilot |

## 8. Slices, `[GATED]` markers and order

| Slice | Repo | Gate | Content | AC (summary) |
|---|---|---|---|---|
| **RP-1** | Backend-Core | **`[GATED]` OpenAPI contract** | **New `return-policy.openapi.yaml`:** admin read-effective, publish, list revisions; the device+operator `return-eligibility` read. **`pos-sales/sales.yaml`:** additive optional `lines[].reasonCode` / `reasonNote`; the three 422 codes; `SaleReturn` echoes `returnPolicy {revisionId, source, windowEndsOn, legalFloorDays}`. New operations are `x-runtime-status: contract-only` | oasdiff additive only; contract and route-conformance specs; legacy bodies stay valid; rollout note (Backend-Core before the POS) |
| **RP-2** | Backend-Core | **`[GATED]` migration** | `return_policy_revisions` + `return_policy_excluded_categories`; `sales.return_policy_revision_id` (nullable, metadata-only `ADD COLUMN`); `sale_returns.return_policy_revision_id`, `return_policy_source`, `window_ends_on`, `legal_floor_days`; `sale_return_lines.reason_code`, `reason_note` (CHECK on the catalogue; note required for `other`). Next free migration number at run time | RLS ENABLE+FORCE, append-only for every role; round trip; `lock_timeout` (the 0050 precedent); no backfill |
| **RP-3** | Backend-Core | runtime | Pure resolution; publish + audit; the stamp on sale insert; the evaluation in `SaleReturnsService` under the lock; the eligibility read; the admin API; flip `x-runtime-status` | A test per refusal; a concurrent publish → 409; an offline sale synced after a publish keeps the old revision; legacy `NULL` → System default; the legal floor overrides an old revision; replays byte-identical |
| **RP-4** | POS | **`[GATED]` local migration** | Call `return-eligibility` after `readSale`; show the verdicts; send line `reasonCode`s; journal columns for the echoed revision and the codes; `returns_unavailable` on 404 or unreachable | Old Backend-Core → refuse, no send; offline → `offline`; a refusal is audited locally; no policy material on the bridge beyond display |
| **RP-5** | Admin-Console | — (later) | Policy editor: read, publish with reason, revision history | Renders server values only (P-G) |
| **RP-V** | lab (rt9) | — | Window edge at store midnight; excluded category; legacy sale; publish between eligibility and submit | Evidence on RT-272 |

**Order:** RP-1 → RP-2 → RP-3 → RP-4 → enable `POS_RETURNS_ENABLED` in the lab → RP-V. RP-5 runs any time after RP-3.

**Sequencing with RT-271 F-1 (RT-490).** Both change `RecordReturnRequest` and bump `sales.yaml`. RP-1 lands after RT-490 or is folded into it. It never ships a competing version bump.

**Rollout gate.** The POS RP-4 build ships only after Backend-Core RP-3 is live, because a POS that sends `reasonCode` to an older Backend-Core fails its strict body with a 400. The POS treats a 404 on `return-eligibility` as "unavailable" and never sends the new fields.

## 9. Review focus (implied by the plan, not exercised by any test yet)

1. **Replay identity.** `payload_hash` is computed over the parsed body, so absent optional fields must stay absent. Never use `?? null` when building the hashed body (the spec 040 hash rule). A legacy return replay must stay byte-identical. RP-3 adds a legacy-replay test.
2. **The sale stamp outside the hash.** The stamp must not enter the sale's `payload_hash`, or every re-delivered sale after the migration becomes a 409. RP-3 adds a sale-replay test across the migration.
3. **The store-midnight boundary.** The window compares store-days in the store's timezone (RT-401). A return at 23:59 and at 00:01 on the deadline must differ by exactly one day. RP-3 adds a unit test with a non-UTC store.
4. **Strict responses on the POS.** Adding `returnPolicy` to the `SaleReturn` response is additive for oasdiff, but RP-1 must confirm the POS return client does not reject unknown response properties (spec 040 Δ2).
5. **Category drift.** A product's category changed or deleted (`SET NULL`) after the sale changes the verdict under OD-272-7. The eligibility read and the slip should show `category_unknown` plainly, not a generic error.

## 10. Risks and gaps

- **F-6:** Backend-Core's only role gate on returns is the generic manager-eligible set in the envelope re-verification, and the cashier-admission path was not traced. When cashier returns open (§5), `recordReturn` needs its own check that the approval is bound (the RT-530 void pattern). Until then V1 relies on the POS manager/admin rule plus that generic set.
- The legal floor value (OD-272-5) is unknown. Returns must not be enabled in production before it is set.
- RT-388 (the POS variance policy client) is not on POS `main`, so no POS cache precedent was verified.
- No tests were run; this is static reading at the baselines above.

## Next safe action

The owner rules on OD-272-1 to OD-272-11, at minimum OD-272-3, -5, -7 and -9. RP-1 (the `[GATED]` contract) is then created as the first implementation item, sequenced after RT-490.
