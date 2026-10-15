# Plan 040 — Shift variance policy (a limit, or none), per tenant with store override

Jira RT-236 (Planning). This plan feeds the `[GATED]` contract issue RT-384. `spec.md` and the contract draft are written in RT-384, not here.

**The decision of record is [AD-CASH-001](https://github.com/Kemetra/Orchestrator/blob/main/docs/decisions/AD-CASH-001-shift-variance-approval-policy.md)** in Kemetra/Orchestrator. Its status is **Accepted** on Orchestrator `main` (`420db8b`):

- reviewed head `e73362b`, merged through PR #218 as `3218e8b` on 2026-10-11. The PR title still says "(Proposed)", but the merged file's status line reads "Accepted";
- decisions DR-1 to DR-13 ratified in RT-236 comment 11539, with the owner rulings on DR-4, DR-6 and DR-10 in comment 11543.

This plan **does not re-decide** anything in that record. It does three things:

1. answers RT-236's numbered questions by pointing to the ratified decision (§1);
2. lists what changed on Backend-Core `main` since the record's baseline. That drift shapes the RT-384 contract (§2);
3. gives the `[GATED]` checklist for RT-384, and the owner decisions its contract PR must settle (§3, §4).

No OpenAPI, migration, package or CI file is changed by this plan.

## Baselines

| Repo | Ref | Note |
|---|---|---|
| Backend-Core | `origin/main` `ddae78a7` | re-verified for this plan |
| Orchestrator | `origin/main` `420db8b` | AD-CASH-001 read from here |
| POS, Admin-Console | not re-verified | Their facts below come from AD-CASH-001 (POS `543688ff`, Admin-Console `08b67b4`). The POS shift-service line numbers have since moved; the RT-284 comment 11873 cites `shift-cashup-service.ts:293,736-751`. Treat the record's POS line numbers as historical. |

Confluence pages *Shift & Cash Management* (24674305), *Policy, Permissions …* (23134209) and *Organization & Store Management* (23625729) were last modified on 2026-10-07, which is before the record. Nothing new to reconcile.

## 1. RT-236's questions → ratified answers

| # | RT-236 question | Answer | Where |
|---|---|---|---|
| 1 | **Where it lives and its shape** | Backend-Core owns a narrow, single-key policy store, `cash.variance_approval_threshold`, shaped so the RT-284 engine can absorb it (DR-1). The value is an explicit mode, `none` or `limit`. A `limit` carries `limitAmount` and `currencyCode`. Approval is required exactly when `mode = limit` and `\|variance\| > limitAmount`. The never-set System default is `none` (DR-2), and a tenant may choose "no limit" (DR-3). Store Group is deferred (DR-13). | D-1, D-2, D-4 |
| 1a | **Store override** | Allowed. A `reason` is always required. An override **with** an `effectiveUntil` needs only the reason. An override **without** one, or with one beyond a maximum horizon, also needs **owner approval** (DR-4, comment 11543). The horizon value is set in RT-384 (§4). An expiry writes an audit event. Not decided: whether an override may be looser than the tenant default (§4). | D-2, D-9 |
| 1b | **Validation and revisions** | Every change is an immutable revision. Writes use optimistic concurrency with the revision they replace, and a stale write is a 409. Rollback is a new revision. Only Apply Now (DR-12), and it takes effect at the next cash-session open. | D-3 |
| 2 | **Admin-Console, and who may change it** | `owner` and `tenant_admin` only (DR-10). The separation-of-duties gap is accepted until RT-284, because both roles can also approve a variance. The mitigation is the attributed revision and audit row. The tenant and store detail pages host the sections; the Console renders server-resolved values only. | D-8, D-10 |
| 3 | **POS delivery** | A dedicated device-authenticated read of the **resolved** policy (DR-5). The POS reads it after pairing, at each online sign-in (including the first one after the upgrade) and before an online open. It caches the value with no maximum age (DR-7). A terminal that never fetched it **fails closed** to `limit 0` with `policySource = fallback` (DR-6). **Rollout gate:** no POS that applies the policy ships before the device read is live. | D-5, D-6 |
| 3a | **When a change takes effect** | Threshold **values are frozen per Cash Session** at open. Authority (closer, approver, force-seal) is **revalidated at close**. An offline close can only *detect* a revoked approver, not refuse it (DR-9). | K-2, K-3, D-8 |
| 4 | **Currency and unit** | **This answer overrides the issue text.** The issue asks for "EGP minor units". The wire format is instead an **exact-decimal string plus `currencyCode`**, like all Backend-Core money (DR-11). The POS converts to minor units internally, as it does today. V1 is EGP only (K-5). A frozen `currencyCode` that differs from the shift currency is accepted and flagged `policy_value_mismatch`. | D-1 |
| 5 | **Existing settings pattern** | There is still no tenant or store settings table on `main` (re-verified: `tenants.ts`, `stores.ts`, schema directory). A generic settings JSON was rejected: it has no revision id to freeze and no per-key audit. **New on main:** the `stores.timezone` column (RT-401) and the tenant-branding contract (RT-473 S1). Both are useful *conventions* (§2) but not a settings store. | Alternatives; §2 |
| — | **Audit** | One `audit_events` row per revision, carrying the actor, scope, old/new value, `reason`, revision id and effective window. One more event is written when a store override expires. The exact action names are settled in RT-384 or RT-387. | D-9 |
| — | **`policyRevisionId`** | `openShift` gains three optional, all-or-none fields: `policySource`, `policyRevisionId` (null for `system` and `fallback`) and the frozen value. The close request gains nothing. Backend-Core never refuses an open or a close on policy grounds. It records the frozen fields and derives `approvalRequiredByPolicy` and `approvalMissing` from them (`unknown` for legacy shifts). It also derives the flags `policy_revision_unknown`, `policy_revision_superseded` and `policy_value_mismatch`, and persists `approverCheck`. **Hash rule:** an absent field is omitted from `openHash`, and a present `null` is hashed as `null`. Never use `?? null` on these fields. | D-6, D-7 |

## 2. Drift on Backend-Core `main` since the record (`d36fcbd` → `ddae78a7`)

| # | Change | Consequence for RT-384 |
|---|---|---|
| Δ1 | **`shift-closes.openapi.yaml` 1.0.0-draft exists and is implemented** (RT-383: #737 `ccc8b14`, #740 `9fa13b5`). `ShiftCloseSummary` (`:329-331`) and `ShiftCloseDetail` (`:446-448`) are `additionalProperties: false`. Its description (`:70-77`) defers the D-7 values, `approverCheck` and their filters to RT-384 / RT-385. The `approval` filter (`:256-267`) says verified-ness is "not filterable until the persisted `approverCheck` exists". | **A second contract file is in RT-384 scope.** The record's contract table predates it. RT-384 adds the D-7 fields and `approverCheck` to both projections, and the matching filters (`approverCheck ≠ verified`, `approvalMissing`). |
| Δ2 | Strict **response** schemas in `pos-shifts.openapi.yaml`: `Shift` (`:935-937`) and `ShiftClose` (`:977-979`) are `additionalProperties: false`. | Adding the "echo" fields to the open response and the D-7 fields to the close response changes a strict response schema. oasdiff treats an added response property as non-breaking. A consumer that validates responses strictly would still reject it, the same question spec 033 raised. **RT-384 confirms how POS (shift sync client) and Admin-Console (RT-18 client) validate responses before the change merges.** Not verified here. |
| Δ3 | **Auth precedent.** RT-383 shipped `SessionOnlyAdminGuard` (`apps/api/src/auth/session-only-admin.guard.ts`) after a Codex P2 finding: a bearer token, `dashboard_api` included, was wrongly admitted. tenant-branding is also `cookieAuth` only, roles `owner` / `tenant_admin`. The record's contract table says `DashboardAuthGuard`. | Convention input, not a re-decision. The admin policy endpoints should follow the RT-383 / RT-473 session-only posture unless the owner wants `dashboard_api` bearers to change cash policy. RT-384 states it. |
| Δ4 | **Concurrency and path conventions now have precedents.** tenant-branding uses `expected_revision` and `409 logo_changed_concurrently`, with the tenant in the path (`/api/v1/tenants/{tenant_id}/logo`). The stores contract uses `expected_current_timezone` and `409 timezone_changed_concurrently`. The record writes `expectedRevisionId`. | RT-384 picks one naming style and documents it. **G4** ("scope comes from the credential only") must still hold with a `{tenant_id}` path: the path must match the session's tenant, else the non-disclosing 404. |
| Δ5 | **Device-read precedent:** `GET /api/pos/v1/tenant/branding` (`tenant-branding.openapi.yaml:66`): `device` bearer, tenant from the device row, `ETag` / `If-None-Match` → `304`, monotonic revision. | A natural model for the D-5 read, for example `GET /api/pos/v1/store/cash-variance-policy`, with the store also taken from the device row. A 304 keeps the frequent reads (each sign-in, each open) cheap. The path name is RT-384's choice. |
| Δ6 | **Migration numbering.** The latest migration on `main` is `0045_tracking_foundation`. RT-473 S2 has claimed `0046`. | RT-385 takes the next free number when it runs. It does not pre-claim one. |
| Δ7 | **Still true on `main`.** The stale "threshold, default 0" text is at `pos-shifts.openapi.yaml:432-434`. `OpenShiftRequest` (`:703-705`) and `CloseShiftRequest` (`:801-803`) are strict. `openHash` (`shift-cash-up.service.ts:91-99`) hashes `shiftId`, `openedAt`, `openingUserId`, `currencyCode` and `openingFloat`. The `?? null` idiom is at `shift-close.ts:35,39`. The approver role set is at `shift-close-approver.ts:38`. | The record's Backend-Core citations still hold. The RT-384 contract fix and the D-7 hash rule apply unchanged. |
| Δ8 | **RT-284 planning record (comment 11873, 2026-10-15, PROPOSED, not ratified).** It proposes a tenant-wide `policy_version`, a per-entry `override_direction` (`stricter_only` by default for sensitive entries) and a device "policy bundle". It states that RT-236 / RT-384–389 are **not blocked**, and that absorption needs "no RT-384 wire change". | Pending input only. RT-384 keeps the ratified per-key `policyRevisionId`. If the owner ratifies RT-284 P-C before RT-384 merges, the "looser override" question (§4.3) should follow it. |

## 3. `[GATED]` contract items for RT-384

Each item is a contract change needing owner approval. None is implemented here.

**`pos-shifts.openapi.yaml`** (version bump from 1.1.0-draft)

1. Add the device read of the resolved policy (D-5). Its response carries the D-1 value, `policySource` (`system` | `tenant` | `store`), `policyRevisionId` (null for `system`) and `serverTime`. Scope comes from the device row only, with no parameters. ETag/304 per Δ5 (optional). This is the operation the rollout gate depends on. It may instead live in its own file, as tenant-branding does; RT-384 decides.
2. Add three **optional, all-or-none** fields to `OpenShiftRequest`: `policySource` (`system` | `tenant` | `store` | `fallback`), `policyRevisionId` (nullable) and the frozen value.
   - Structural 400s only (D-6): a partial set; a null id with `tenant` / `store`; a non-null id with `system` / `fallback`; or `limit` without an amount or currency.
   - Every policy-ground mismatch is accept-and-flag, never a 400.
3. Document the `openHash` rule in the contract: absent means omitted, and a present null is hashed as null. Legacy replays stay byte-identical, so they never become a 409 `shift_payload_conflict`.
4. Echo the frozen fields on `Shift` (the open response). Add to `ShiftClose` (the close response): `policySource`, `policyRevisionId`, the frozen value, `approvalRequiredByPolicy`, `approvalMissing` (`true` | `false` | `unknown`), `approverCheck` (`not_applicable` | `verified` | `unverified` + reason) and the policy flags. These are strict response schemas, so see Δ2.
5. Replace the "threshold, default 0" text (`:432-434`). The POS asks according to the frozen session policy, and the system default is `none`. The server still never refuses on the approver's role.

**`shift-closes.openapi.yaml`** (version bump from 1.0.0-draft; Δ1)

6. Add the same D-7 fields and `approverCheck` to `ShiftCloseSummary` and `ShiftCloseDetail`. Legacy rows return `unknown`, never "no exception".
7. Extend the filters: `approver_check` (for example `unverified`) and `approval_missing`. Update the `approval` filter prose.

**New admin policy contract** (new file, or a section of `tenants` / `stores`; RT-384 decides)

8. Read the effective policy for a store (value, source, revision). Roles `owner` and `tenant_admin` (any store in membership scope) and `store_manager` (own stores). The auth posture follows Δ3.
9. Read the tenant default, and set it (`owner` / `tenant_admin`, `Idempotency-Key`, `reason`, expected-revision → 409).
10. Set or clear a store override. A `reason` is required and `effectiveUntil` is optional. An override with no expiry, or with one beyond the horizon, needs owner approval; the mechanism is §4.2.
11. List revisions per scope, newest first, cursor-paginated.
12. Error envelope, status codes and naming follow existing conventions (Δ4). The tenant comes from the session; a mismatched path tenant is a 404.

**Cross-cutting**

13. Name the audit actions in the contract prose: the change event and the override-expiry event (D-9).
14. Rollout warning in the contract: Backend-Core must accept the new open fields **before** any POS sends them, and a Backend-Core rollback after that dead-letters opens. The POS send ships behind a flag or after the rollback window.
15. Gate evidence: an oasdiff run (additive only), contract spec and route-conformance registration, and `x-runtime-status: contract-only` on new operations until RT-387.

## 4. Owner decisions the RT-384 contract PR must settle

These do not block *starting* RT-384. They block merging its contract PR.

1. **DR-4 maximum horizon:** the `effectiveUntil` distance beyond which an override counts as permanent and needs owner approval. This plan proposes no value; the owner sets it.
2. **The owner-approval mechanism for permanent overrides:**
   - (a) only an `owner` may publish such an override: a single call, no pending state;
   - (b) a `tenant_admin` requests it and an `owner` approves: a pending revision, a new state and an extra endpoint.

   (a) is simpler and needs no workflow state that RT-284 would later replace.
3. **May a store override be looser than the tenant default** (for example `none` under a tenant `limit`)? The record leaves this to RT-284 guardrails. The RT-284 proposal (unratified) recommends `stricter_only` for sensitive entries. The wire validation needs a position now: either "any value" (and RT-284 tightens later, a possible breaking change) or "stricter only" (and RT-284 may loosen later, additive).
4. **Conventions:** session-only versus `dashboard_api` bearer for the admin writes (Δ3); naming style and path shape (Δ4); and whether the device read sits in `pos-shifts` or its own file.

## 5. Follow-up order (unchanged from the record)

RT-384 (contract, `[GATED]`) → RT-385 (migration, `[GATED]`) → RT-387 (implementation) → RT-388 (POS, `[GATED]` local migration, rollout gate) and RT-389 (Admin-Console). RT-383 is Done, and RT-18 can already use its read. This plan adds no new follow-up issue.

## 6. Risks and gaps

- **Δ2 strict response validation** in POS and Admin-Console is not verified. It could turn an additive change into a runtime break.
- The **POS and Admin-Console facts** are not re-verified here (see Baselines).
- The **separation-of-duties gap** (DR-10) remains accepted until RT-284 and RT-114 deliver.
- **Fail-closed fleet window** (DR-6): safe only if the rollout gate is enforced at POS release time. Nothing in CI enforces it.
- **Mixed-version hashing:** any `?? null` on the new open fields breaks legacy replays. RT-387 needs a byte-identical legacy-hash test.
