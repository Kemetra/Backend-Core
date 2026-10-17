# RT-565 — Posting freshness read for the console: decision record and contract proposal

> **Status:** decision record + `[GATED]` contract proposal (Work Mode: **Planning**, contract-first).
> **Jira holds the live status.** This file records the 2026-10-17 planning pass and is not a status tracker.
>
> No production code, OpenAPI, migration, package or CI change. The contract in §4 is a **proposal**
> described here; it is applied to `packages/contracts/openapi/**` only by the build issue proposed in §7,
> under its own `[GATED]` approval.
>
> **Sources:** Jira RT-565 (this item), RT-560 (Admin-Console spec 016 Phase A, Done), RT-642 (AI D0 audit, Done);
> Backend-Core `origin/main` **`ff9e6833`** (read-only inspection); Admin-Console `origin/main` **`909a714`**
> (read-only: `specs/016-rf-connectors-settings/spec.md` §3 row "Last successful posting / sync", §5 A-5, §9 item 6;
> `src/erp-status/*`, `src/lib/erp-status-queries.ts`). ERPNext-Connector, POS and Orchestrator were **not inspected**.
> No runtime was exercised. Every row-volume and latency statement below is **NOT VERIFIED**.

---

## 1. The need, and what main serves today

Spec 016 asks one question Backend-Core cannot answer yet: **is ERP posting keeping up?** The operator wants
"when did posting last succeed" or "how old is the oldest pending posting", for the tenant or one store
(016 §9 item 6). RT-642 restates the rule: *no dead letters ≠ posting succeeded; unavailable ≠ healthy*.

What `main` serves (`packages/contracts/openapi/erpnext-sync-ops/console-sync-ops.yaml`, `1.0.0-draft`, spec 025):

| Read | What it answers | Why it is not freshness |
| --- | --- | --- |
| `consoleGetSyncOpsSummary` → `posting` `DomainSummary` | `headlineCount` = count of `permanently_rejected` rows; `status` `ok`/`attention`; fixed `detail` text | Counts what **failed**. A tenant whose connector stopped an hour ago reads `ok` with count 0. |
| `consoleListPostingBacklog` | dead-letter rows only | Same: failures, not progress. |
| `consoleListReconciliationRuns` | stock reconciliation runs | Stock, not posting. |
| C2 connector `lastSeenAt` (020) | connector liveness | Liveness, not posting. The Connector on main sends no heartbeat (016 A-2). |

The summary response carries **no `asOf`** either. Spec 016 A-5 wants "an as-of time from the read"; today the
console can only use its own fetch time.

### 1.1 The data already exists (no new table needed)

`erpnext_posting_status` (migration `0019`, plus `0037`/`0039`/`0042`) holds one row per posting intent
(`sale_post` / `reversal`), tenant RLS (`FORCE`), `store_id NOT NULL`:

| Column | Meaning for freshness | Evidence |
| --- | --- | --- |
| `status` | `pending` / `posted` / `permanently_rejected`. `failed_transient` is allowed by the CHECK but never stored: `applyTransient` resets to `pending` and re-heads `sequence`. | `0019` CHECK; `erpnext-posting.service.ts:377-379`, `:600-605` |
| `posted_at` | ERP confirmation time: server clock when the `posted` ack is applied, `COALESCE`d so it is written once. **NULL for every row posted before `0042`** (no backfill; the true time is unknown). | `0042` §3; `erpnext-posting.service.ts:505-515` |
| `created_at` | When the intent row was created (worker insert). Not changed by re-heads, transient retries, repair or re-resolution. | `0019`; no `UPDATE` of `erpnext_posting_status` sets `created_at` (grep of `apps/api/src`, `apps/worker/src`) |
| `updated_at` | Touched by every transition, re-head, repair and re-resolution. **Not** a posting time. | `erpnext-posting.service.ts`, `erpnext-reconciliation.service.ts:339-341`, `posting-re-resolution.service.ts:121-122` |
| `sequence` | Feed order. Re-drawn on every re-head, so it is **not** age. | `0019`; RT-456 |

Indexes: `idx_erpnext_posting_status_pending (tenant_id, sequence) WHERE status='pending'` exists.
There is **no** index over `posted_at`.

### 1.2 What a posting-row freshness signal cannot see

A posting row is created only once the worker materializes the intent. Work that is behind **before** that point
has no row, so a row-based signal cannot see it:

* sales stranded before their posting intent (the RT-457 re-drive sweep and its `worker.metrics.ts` signal);
* reversals deferred in the outbox while their sale's `sale_post` row does not exist yet, and their dead letters
  (RT-207, `erpnext_posting_reversal_deferred_dead_letter_total`).

Conversely, a `sale_post` row **held** by the RT-418 responsibilities feed gate (`responsibilities-feed-gate.ts`) is
`pending` but not offered to the Connector. It is genuinely not posted, so it counts as pending (see D3).

## 2. Decisions

Each decision lists the options, the one marked **Recommended**, and the selection.

### D1 — Surface: extend `consoleGetSyncOpsSummary` additively, or add a separate read?

| Option | For | Against |
| --- | --- | --- |
| **A. Additive extension of `consoleGetSyncOpsSummary` (Recommended)** | The console already fetches the summary for the same panel (`erpQueryKeys.summary`, keyed by tenant + store). One round trip; the freshness values and the dead-letter count share one transaction and the same store scope. Reuses the existing route, guards, scope assertion and 404 rules unchanged. | Grows one response; the summary query does a little more work. |
| B. New `GET /api/v1/catalog/erpnext-sync-ops/posting-freshness` | Independent caching and evolution. | A new route, new contract tests and new auth-boundary tests for the same scope; a second request whose as-of can disagree with the summary's dead-letter count. |
| C. New fields on the generic `DomainSummary` | No new object. | `DomainSummary` is one shape for four domains; posting-only fields would be null for the other three and blur the shape. |

**Selected: A** — recommended option, chosen by the coordinator under the owner's standing delegation of
2026-10-17; owner may revisit.

### D2 — Signals and their semantics

Three facts, all scoped by D4, all computed on read (no mirror, no counter table):

1. **Last successful posting** = `max(posted_at)` over `status='posted'` rows in scope.
   This is correct even with pre-`0042` rows present: every posting after `0042` sets `posted_at`, and every
   pre-`0042` posting happened before that deploy, so whenever any `posted_at` exists, the max **is** the latest.
2. **Oldest pending** = `min(created_at)` over `status = 'pending'` rows in scope, returned both as an instant and as whole seconds
   before `asOf`. Age is measured from the intent's creation, so a row that has been retried for an hour reads an
   hour old, not seconds old after its last re-head. `failed_transient` is **not** in the predicate: no writer
   stores it (§1.1), and adding it would stop the read from using the `status = 'pending'` partial index. If a
   future change starts storing `failed_transient`, that change must extend this read and its index together.
   A dead letter that an operator repairs (017 `repairPosting`:
   `permanently_rejected` → `pending`) keeps its `created_at`, so it re-enters as old as it truly is.
3. **Pending count** = count of the same rows. It distinguishes "one stuck row" from "a growing queue". It is
   one count over the pending rows in scope (D7).

Dead-lettered (`permanently_rejected`) rows are **not** pending: they stay in the existing `posting`
`headlineCount`.

**Selected:** as above — recommended option, chosen by the coordinator under the owner's standing delegation of
2026-10-17; owner may revisit.

### D3 — How "unknown" is expressed (never a fake value)

`lastPosted.state`:

| `state` | Condition | `at` |
| --- | --- | --- |
| `known` | some posted row in scope has `posted_at` | that `max(posted_at)` |
| `unknown` | posted rows exist in scope, but **all** predate `0042` (`posted_at` NULL) | `null` |
| `none` | no posted row in scope | `null` |

`updated_at` is **not** used as a fallback for `unknown`: it moves on repair and re-resolution and would invent a
posting time.

Oldest pending: `pendingCount = 0` ⇒ `oldestPendingAt = null` and `oldestPendingAgeSeconds = null`. Held
(RT-418) rows are included: they are not posted, and hiding them would understate the backlog.

`none` with `pendingCount = 0` is **not** "current": it is also what a tenant with no ERP integration, or a store
that never sold, reads. The contract text says so and the console must render it as "no posting activity", not
healthy (016 A-4/A-5 spirit).

**Selected:** as above — recommended option, chosen by the coordinator under the owner's standing delegation of
2026-10-17; owner may revisit.

### D4 — Scope, roles, isolation (unchanged)

* Same route guards: `DashboardAuthGuard` cookie session + `RolesGuard` `@Roles("owner", "tenant_admin")`.
  Machine credentials stay rejected.
* Tenant from the session; tenant RLS on `erpnext_posting_status` (fail-closed) via `runWithTenantContext`.
* Store scope: the **same** filters as the existing posting leg of `getSummary`
  (`$1 store_id` filter + `$2` membership store scope, RT-192), and the existing `assertStoreInScope` 404 for an
  out-of-scope `store_id`. No new scope rule.
* No `tenant_id`, store ids, sale ids or external ids in the new object: aggregates and timestamps only.

**Selected:** as above — recommended option, chosen by the coordinator under the owner's standing delegation of
2026-10-17; owner may revisit.

### D5 — Verdict or facts? (no "current/behind" status in v1)

| Option | |
| --- | --- |
| **A. Facts only (Recommended)** | Backend-Core returns timestamps, age and count. It does **not** change the `posting` `DomainSummary.status` rule (still dead-letter driven) and does not emit a "current"/"behind" verdict. |
| B. Add a threshold-based `behind` status | Needs a per-tenant SLA (trading hours, store closures, connector schedule) that no decision defines yet. A wrong threshold is exactly the false "posting is current" signal 016 forbids. |

**Selected: A** — recommended option, chosen by the coordinator under the owner's standing delegation of
2026-10-17; owner may revisit. A threshold is a later owner decision; it can be added additively.

### D6 — Response `asOf`

Add a required top-level `asOf` to `SyncOpsSummary`. It gives 016 A-5 its "as-of time from the read".

`asOf` is **not** the transaction's `now()`. `runWithTenantContext` runs at PostgreSQL's default `READ COMMITTED`,
so each statement takes its own snapshot. A row committed after the transaction started but before the freshness
statement can be visible with a `created_at` or `posted_at` later than the transaction's `now()`, which would give
a negative age or `lastPosted.at > asOf`. Instead:

* every freshness fact comes from **one statement** (§5), so all of them see one snapshot and cannot contradict each
  other (for example `pendingCount = 0` with a non-null `oldestPendingAt`, or `unknown` for a row that has
  `posted_at`);
* `asOf` is `clock_timestamp()` evaluated **inside that statement**. Every visible row was committed before the
  statement's snapshot, and its `created_at` / `posted_at` is the writing transaction's `now()`, which is no later
  than its commit. So every returned timestamp is at or before `asOf`, and the age is never negative;
* the age is additionally clamped with `GREATEST(0, …)` as a guard against clock adjustment.

The other summary legs (dead-letter count, reconciliation) remain separate statements, as today. `asOf` is the
instant of the freshness read; it is within the same request and transaction as those legs, not the same snapshot.

**Selected:** add it — recommended option, chosen by the coordinator under the owner's standing delegation of
2026-10-17; owner may revisit.

### D7 — Query cost: freshness indexes

Two costs, both on the console's polling path:

* **Last posted.** `max(posted_at)` has **no** index today and would scan the tenant's posted rows on every
  summary request, a cost that grows with sales volume. Both scopes must be bounded: tenant-wide, and
  store-filtered (`store_id`, or the RT-192 membership store list). A tenant-only index does not bound the store
  case: a quiet store would walk past every newer posting of the tenant's other stores.
* **Oldest pending / pending count.** The existing partial index `(tenant_id, sequence) WHERE status = 'pending'`
  restricts the read to pending rows, but `sequence` is not `created_at` and carries no `store_id`, so the oldest
  lookup is O(pending rows of the tenant). It is bounded by the backlog, which is exactly what grows during a
  connector outage. As with last posted, both scopes must be bounded: a store-first index cannot serve the
  tenant-wide `ORDER BY created_at LIMIT 1`, and a tenant-first index cannot serve a quiet store.

| Option | |
| --- | --- |
| **A. `[GATED]` additive index migration in the build issue (Recommended)** | Five partial indexes: a tenant-first and a store-first one for each lookup, plus one for the legacy-row existence probe. (1) `(tenant_id, posted_at DESC) WHERE posted_at IS NOT NULL`: tenant-wide last posting, one probe. (2) `(tenant_id, store_id, posted_at DESC) WHERE posted_at IS NOT NULL`: store-filtered last posting, one probe per store; for a membership scope, one probe per scoped store via `LATERAL … LIMIT 1`, then the max. (3) `(tenant_id, created_at) WHERE status = 'pending'`: tenant-wide oldest pending, one probe. (4) `(tenant_id, store_id, created_at) WHERE status = 'pending'`: per-store oldest pending, one probe per store. (5) `(tenant_id, store_id) WHERE status = 'posted' AND posted_at IS NULL`: the `unknown`-vs-`none` existence probe, tenant-wide (leading `tenant_id`) and per store. It holds only pre-`0042` posted rows. That set never grows, because every later posting sets `posted_at`, so the index stays small and fixed in size. The pending count stays O(pending rows in scope) on (3)/(4). The existing `(tenant_id, sequence)` pending index stays: the posting feed uses it. No data change. Lock mode and `CONCURRENTLY` follow the repo's migration convention, decided in the build issue. |
| B. Ship without an index and measure | Defers a known linear cost onto the console's polling path. |

**Selected: A** — recommended option, chosen by the coordinator under the owner's standing delegation of
2026-10-17; owner may revisit. The build issue must attach `EXPLAIN (ANALYZE)` evidence on a seeded volume for
each subquery in §5, in three scopes: tenant-wide, one `store_id`, and a multi-store membership scope, including
a quiet store inside a busy tenant, and a `none` / `unknown` scope (no `posted_at` in scope) so probe (b) is covered.

## 3. Interaction with existing semantics (what does **not** change)

* `posting` `DomainSummary` `status` / `headlineCount` / `detail`: unchanged.
* `consoleListPostingBacklog`, `consoleListReconciliationRuns`: unchanged.
* No posting-state transition, ack, feed, repair or Inventory Effect behavior changes. Read-only.
* No metric is added (the existing posting metrics are unlabeled by tenant by design).

## 4. `[GATED]` contract proposal — `console-sync-ops.yaml` `1.0.0-draft` → `1.1.0-draft`

Additive only. Shown as the intended YAML; it is **not** applied by this PR.

```yaml
    SyncOpsSummary:
      type: object
      additionalProperties: false
      required: [domains, asOf, postingFreshness]
      properties:
        domains:            # unchanged
          ...
        asOf:
          type: string
          format: date-time
          description: >
            Server instant of the posting-freshness read (taken inside the
            statement that reads it). Every timestamp in postingFreshness is at
            or before it, and every age is measured against it.
        postingFreshness:
          $ref: "#/components/schemas/PostingFreshness"

    PostingFreshness:
      type: object
      additionalProperties: false
      required: [lastPosted, pendingCount, oldestPendingAt, oldestPendingAgeSeconds]
      description: >
        Whether ERP posting is keeping up, for the tenant or the filtered store,
        within the caller's store scope. Facts only: there is no "current"
        verdict. Covers materialized posting intents only — sales not yet turned
        into a posting intent, and reversals deferred before their sale's
        posting row exists, are not visible here. `lastPosted.state = none` with
        `pendingCount = 0` means no posting activity, NOT that posting is current.
      properties:
        lastPosted:
          $ref: "#/components/schemas/LastPosted"
        pendingCount:
          type: integer
          minimum: 0
          description: >
            Posting intents not yet posted and not dead-lettered (includes rows
            held from the feed). Dead letters are the posting domain headlineCount.
        oldestPendingAt:
          type: [string, "null"]
          format: date-time
          description: >
            Creation time of the oldest pending posting intent (not its last
            retry). Null when pendingCount is 0.
        oldestPendingAgeSeconds:
          type: [integer, "null"]
          minimum: 0
          description: Whole seconds from oldestPendingAt to asOf. Null when pendingCount is 0.

    LastPosted:
      type: object
      additionalProperties: false
      required: [state, at]
      properties:
        state:
          type: string
          enum: [known, unknown, none]
          description: >
            known — `at` is the latest ERP confirmation time in scope.
            unknown — postings exist but all predate confirmation-time capture;
            the time is not recorded. none — no posting has succeeded in scope.
        at:
          type: [string, "null"]
          format: date-time
          description: Latest ERP confirmation (posted-ack) time. Non-null only when state is known.
```

**Compatibility.** Adding response properties is non-breaking for the Admin-Console generated client
(openapi-typescript types; unknown properties are ignored). The Console consumes `1.1.0-draft` only when it bumps
`contracts/backend-core/PIN` in a later 016 phase. No request parameter changes; `store_id` keeps its meaning.

**Error envelope / statuses:** unchanged (400 / 401 / 403 / 404 / 500).

## 5. Proposed SQL shape (for the build issue; illustrative)

Inside the existing `getSummary` transaction, with the same `$1` store filter and `$2` scope array as the posting leg.
It is **one statement** (one snapshot, D6). Each scalar subquery is shaped for one D7 index; there is no aggregate
over all of the tenant's rows. The tenant-wide form is shown. With a store filter or membership scope, the build issue
writes subqueries (a) and (c) as one `LATERAL … LIMIT 1` probe per scoped store on indexes (2) / (4), taking the
max / min.

```sql
SELECT clock_timestamp() AS as_of,                         -- after the snapshot (D6)
       (SELECT posted_at FROM erpnext_posting_status       -- (a) index (1)
         WHERE posted_at IS NOT NULL
         ORDER BY posted_at DESC LIMIT 1)                  AS last_posted_at,
       EXISTS (SELECT 1 FROM erpnext_posting_status        -- (b) unknown vs none, index (5)
                WHERE status = 'posted'
                  AND posted_at IS NULL)                   AS any_legacy_posted,
       (SELECT created_at FROM erpnext_posting_status      -- (c) index (3)
         WHERE status = 'pending'
         ORDER BY created_at LIMIT 1)                      AS oldest_pending_at,
       (SELECT count(*) FROM erpnext_posting_status        -- (d) O(pending in scope)
         WHERE status = 'pending')                         AS pending_count;
```

Every subquery also carries the `$1` / `$2` store predicates, and tenant RLS applies to all of them. Subquery (b)
only matters when (a) is null. Then no in-scope posted row has `posted_at`, so "any posted row" is the same as
"any posted row with `posted_at IS NULL`", which is what (b) probes on index (5). It runs on every poll of a
`none` / `unknown` scope, so it must be an index probe, not a scan. The build issue may also write it as
`CASE WHEN (a) IS NULL THEN EXISTS(…) END`. Age = `GREATEST(0, floor(extract(epoch FROM as_of - oldest_pending_at)))`.

`clock_timestamp()` is volatile, so the build issue must check that it is evaluated once per row of this
single-row statement (it is in the target list of a `FROM`-less `SELECT`) and must not move it into a subquery.

## 6. Required tests for the build issue

* Contract conformance (`erpnext-sync-ops.contract.spec.ts`) for the new shape, `additionalProperties: false`.
* `lastPosted.state`: `none` (no rows), `unknown` (posted rows with NULL `posted_at` only), `known` (mixed: max of
  the non-null).
* Pending: re-headed / transient-retried row keeps its original `created_at` age; dead-lettered rows excluded;
  RT-418-held row included; `pendingCount = 0` ⇒ both nulls.
* Isolation: cross-tenant rows invisible (RLS); store filter and membership scope (RT-192) honored; out-of-scope
  `store_id` → 404; store_manager / cashier → existing denial; machine credential rejected.
* `asOf` equals the instant the age is computed against; `lastPosted.at <= asOf` and `oldestPendingAt <= asOf`.
* Consistency: `pendingCount = 0` ⇔ `oldestPendingAt` is null; `lastPosted.state = unknown` never coexists with a
  visible `posted_at`. A concurrency test that commits an ack and a new intent between the summary's `BEGIN` and the
  freshness statement must still satisfy both rules and a non-negative age.
* `EXPLAIN (ANALYZE)` evidence per D7 (tenant-wide, single store, multi-store scope, quiet store in a busy tenant).

## 7. Proposed follow-up work (not created)

| # | Proposed item | Mode | Repo | Gate | Acceptance |
| --- | --- | --- | --- | --- | --- |
| 1 | BC — Posting freshness on `consoleGetSyncOpsSummary` (contract `1.1.0-draft` + read + D7 indexes) | Implementation | Backend-Core | `[GATED]` OpenAPI (`packages/contracts/openapi/**`) **and** `[GATED]` migration (D7) | §4 contract applied; §5 read; §6 tests green; `EXPLAIN` evidence attached |
| 2 | Admin-Console — 016: consume posting freshness | Implementation | Admin-Console | Depends on #1 merged; PIN bump | Renders `known`/`unknown`/`none` honestly; never shows "current" for `none` + 0 pending; uses `asOf` for A-5 |

Upstream lag before an intent exists (§1.2) is out of scope here. If the owner wants it on the console, it is a
separate planning item (it would read the RT-457 / RT-207 sources, not `erpnext_posting_status`).

## 8. Risks and assumptions

* **Pre-`0042` history:** tenants whose only postings predate `0042` read `unknown` until their next posting. Expected
  and honest.
* **`posted_at` is the ack-apply time, not the ERPNext document timestamp.** A lost-ack replay (RT-458) records the
  replay time. For "is posting keeping up" this is the right clock (Backend-Core's view of confirmation); it is not
  an accounting date.
* **Held rows inflate age by design** while `ERPNEXT_FEED_RESPONSIBILITIES_ENABLED` is off. The console copy should
  not call the oldest pending row "stuck in ERPNext".
* **Volume/latency NOT VERIFIED.** D7's `EXPLAIN` gate covers it.
* `runWithTenantContext` issues `BEGIN` at the default `READ COMMITTED` (`packages/db/src/middleware/tenant-context.ts`).
  The freshness facts therefore rely on being one statement (D6), not on the transaction. The dead-letter count is a
  separate statement and may be one commit apart from the freshness facts. That is acceptable for an operator view,
  and the same as the existing summary legs today.
