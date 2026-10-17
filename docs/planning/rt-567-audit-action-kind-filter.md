# RT-567 — `listAuditEvents`: filter out read-only actions (action kind)

> **Status:** planning and decision record (Work Mode: **Planning**, contract-first). **Jira holds the live
> status.** This file records the 2026-10-17 decision and the proposed contract. It is not a status tracker.
>
> No production code, OpenAPI, migration, package or CI change. The contract change below is
> **proposed**. It lands in a separate **[GATED]** Implementation item (§7).
>
> **Sources:** Jira RT-567 (parent RT-5, relates RT-559); Admin-Console `specs/009-rf-overview-dashboard/spec.md`
> (P-5, G-3, AC-10, BC-009-3, OD-009-3) at Admin-Console `909a714`; Backend-Core `origin/main` **`ff9e683`**
> (read-only inspection).

---

## 1. Problem

Backend-Core audits console and device **reads** as well as changes. A "recent activity" view built on
`listAuditEvents` therefore fills with read events. On the Admin-Console Overview, a single page load writes
several of them (`shift_closes.listed`, `erpnext_sync_ops.summary.read`, …). "Latest 10" would mostly echo
the operator's own visit. For that reason spec 009 deferred panel P-5 (OD-009-3). Dropping rows in the
browser is not a fix: it would misstate a 10-row page and break cursor paging.

The fix belongs in Backend-Core: the list must be able to return **only changes**. Reads stay audited.
This changes what the list returns, not what is recorded.

## 2. What `main` does today (`ff9e683`)

| # | Finding | Evidence | Bearing |
|---|---|---|---|
| F1 | `listAuditEvents` takes `action`, `actor_user_id`, `store_id`, `from`, `to`, `cursor`, `limit`. The query schema is `.strict()`, so an unknown param is a 400 today. | `packages/contracts/openapi/audit.openapi.yaml`; `apps/api/src/audit/audit.query.schema.ts` | A new param is additive for the contract, but older servers reject it. Consumers must wait for the deploy (§6). |
| F2 | `action` is a **prefix** match (`LIKE '<value>%'`), and the contract says so. The RT-567 ticket text says "exact"; the code and contract disagree with the ticket, not with each other. | `audit.repository.ts` `filterPredicates`; contract `action` description | Only one prefix can be passed. A prefix list can't express "everything except reads" (§3, option C). |
| F3 | Order is `occurred_at DESC, id DESC`, with keyset cursor `(occurred_at, id)` and the RT-211 µs anchor. The contract does not state the order (spec 009 BC-009-3). | `audit.repository.ts` `runQuery` | Stated in the contract as part of this change (§5). |
| F4 | Action codes have **no registry and no kind**. They are string literals spread across `@Auditable("…")` route decorators (56 codes) and direct emit sites in services (23 more: connector, POS device, settlement, reconciliation repair, unknown-item), plus constants such as `AUTH_AUDIT_ACTIONS`, `REPRINT_AUDIT_ACTION`, `inventory.movement.*`. | `grep '@Auditable(' apps/api/src`; `grep 'action: "' apps/api/src` | Classification needs one place to live (§4). |
| F5 | Read codes do not share a naming pattern: `.listed`, `.read`, `.detail_read`, `.impact_read`, `.device_read`, `.store_revisions_listed`, `.pulled`. | Inventory in Appendix A | Name-based (suffix/regex) classification would be wrong for some codes and silently wrong for future ones. |
| F6 | `audit_events` has no kind/category column. Indexes: `(tenant_id, occurred_at DESC)`, `(action, occurred_at DESC)`, plus retention indexes. | `packages/db/drizzle/0000_initial.sql:280-283` | A stored column means a [GATED] migration plus a backfill. A derived kind needs neither (§3). |
| F7 | `listAuditEvents` itself is not audited (no audit-of-audit). Roles `owner`, `tenant_admin` (403 otherwise); platform admins bypass the role check; explicit `tenant_id` predicate on top of RLS. | `audit.controller.ts` header | Unchanged by this plan. |

## 3. Options

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **A. Boolean `exclude_reads=true`** | One query flag. Server filters with a code-owned read list. | Smallest contract. | Not extensible: a second split (e.g. security vs business) needs another flag. The client can't render or count kind. |
| **B. Action kind, derived (Recommended)** | Code-owned registry maps each action code to a `kind` (`read` \| `change`). Additive response field `AuditEvent.kind`; additive query filter `kind`. SQL filter uses the registry's read list. No migration. | One source of truth for classification. Extensible enum. The /audit screen can show and filter the same kind. Historical rows are classified correctly at read time, with no backfill. | Needs a guard so new codes get classified (§4.3). The filter is a `NOT IN`-style predicate, not an indexed column (§8 R1). |
| **C. Action-prefix include/exclude list** | `action_exclude=shift_closes.,sale_history.,…` | No server classification. | Pushes classification to every client. Naming is inconsistent (F5), so a correct list is long and drifts. Rejected. |
| **D. Stored `kind` column** | Same as B, but persisted at write time, with a partial or composite index. | Indexable. | [GATED] migration, backfill of every existing row, and the insert path changes (queue producer, outbox, worker). Overkill before volume shows a need. **Deferred** as the escalation path for B (§8 R1). |

## 4. Decision

**D-1 — Mechanism: Option B, a code-owned action-kind registry with a derived `kind`.**
*Selected — recommended option, chosen by the coordinator under the owner's standing delegation of
2026-10-17; owner may revisit.*

### 4.1 Kind values

| `kind` | Meaning | Examples |
|---|---|---|
| `read` | The audited request only returned data. No business or session state changed. Includes machine pulls (`erpnext.postings.pulled`). | `shift_closes.listed`, `sale_history.detail_read`, `catalog.snapshot.read` |
| `change` | Anything else: a business-state change, a security or session event, a rejected attempt. | `sale.voided`, `shift.closed`, `auth.signin.failed`, `context.switch.store`, `pos.device.rotation_rejected` |

The enum is **open for extension**. Consumers must treat an unknown `kind` value as `change` for display,
and the contract says so (§5). A later split (e.g. `security`) is then an additive change, not a breaking one.

**D-2 — Default for an unregistered code is `change`.** An action missing from the registry is shown, not
hidden. Hiding an unclassified event from an audit view is the worse failure; showing a stray read is noise.
The guard in §4.3 keeps that case rare.

**D-3 — Retired codes stay in the registry.** Rows are append-only and never deleted (migration 0034), so a
code whose route is gone (for example the RT-421 `settlement.receivable.*` reads) still needs its kind.
Registry entries are never removed, only added.

### 4.2 Where the registry lives

One module in `apps/api/src/audit/` (proposed name `audit-action-kinds.ts`) that exports the set of `read`
codes and a `kindOf(action)` helper. Every code not in the read set is `change`, so the registry lists only
reads (29 codes today, Appendix A) plus a test-only list of known `change` codes for the guard.

### 4.3 Guard against drift (Implementation item, not this PR)

- A test enumerates every `@Auditable` handler through Nest's `DiscoveryService` / `Reflector` and fails if a
  handler on a `GET` route has a code that is not registered as `read`, or a code on a non-`GET` route is
  registered as `read`. GET-without-side-effects is the rule this repo follows today: both `.pulled` routes are
  `GET`.
- Direct emit sites (service-level `action: "…"`) are all changes today. The same test asserts the read set
  contains none of the known direct-emit codes.
- Interaction with **RT-548** (audit the POS `readSale`, planned in parallel): whatever code RT-548 picks
  (e.g. `pos_sales.detail_read`) is a `read` and must be added to the registry **in the same PR** that adds the
  `@Auditable`. The guard above fails that PR otherwise. RT-548 does not block RT-567, and RT-567 does not
  block RT-548. Whichever lands second adds the entry.

## 5. Proposed contract change (`audit.openapi.yaml`, [GATED], additive)

Version `1.0.0-draft` → `1.1.0-draft`. No removed or renamed field; no change to roles, RLS, store scope,
cursor format or error envelopes.

**New query parameter on `listAuditEvents`:**

```yaml
- in: query
  name: kind
  schema:
    type: string
    enum: [read, change]
  description: >
    Return only events of this action kind. `change` excludes read-only
    actions (list/read/pull requests that changed no state); `read` returns
    only those. Omitted: all events, as before. Read-only actions are still
    recorded; this filter changes what the list returns, not what is audited.
    Combines with every other filter (AND). An unknown value is a 400
    `validation_error`.
```

**New response field on `AuditEvent`:**

```yaml
kind:
  type: string
  description: >
    Action kind derived by the server from `action` (not stored). Known
    values: `read`, `change`. More values may be added; treat an unknown
    value as `change`. An action the server has not classified is `change`.
```

**Order and stability, stated on the operation (BC-009-3):**

```yaml
description: >
  Items are ordered newest first: `occurred_at` descending, then `id`
  descending as the tie-breaker. `next_cursor` continues that order and is
  stable under concurrent inserts. A cursor is valid only with the same
  filters (including `kind`) it was issued under.
```

Also correct the `action` description to match runtime: "Filter by action code **prefix** (e.g. `auth.`,
or a full code for an exact family)". It already says prefix; keep it, and drop any "exact" wording in
derived docs.

### 5.1 Runtime shape (for the Implementation item)

- `AuditQuerySchema`: add `kind: z.enum(["read", "change"]).optional()`.
- `filterPredicates`: `kind=change` → `action <> ALL($readCodes::text[])`; `kind=read` →
  `action = ANY($readCodes::text[])`. Applied through the shared `filterPredicates`, so the RT-211 cursor anchor
  sees the same filter (the anchor lookup must stay restricted to rows the same list could serve).
- `AuditService` / DTO mapping: `kind: kindOf(row.action)`.
- `listAuditEvents` stays un-audited.

## 6. Consumer impact

| Consumer | Impact |
|---|---|
| Admin-Console Overview P-5 (spec 009) | Can return with `GET /api/v1/audit/events?kind=change&limit=10` (+ `store_id` when a store is active). Order is now a contract fact. Needs a contract re-pin (`contracts/backend-core/PIN`) after the Implementation item merges and is deployed, because the server rejects unknown params until then (F1). The shared audit-action copy catalog (OD-009-3) is the console's own item. |
| Admin-Console `/audit` | Optional: a "hide reads" toggle (`kind=change`) and a kind badge. Not required. |
| POS, Connector | None. They do not call `listAuditEvents`. |
| Strict response validation | `AuditEvent` has no `additionalProperties: false`, so the new `kind` field is additive for tolerant clients. A client that validates strictly needs the re-pin first. |

## 7. Proposed follow-up items

| Item | Repo | Mode | Scope | Gate |
|---|---|---|---|---|
| **RT-567-I** — action-kind registry + `kind` filter/field | BC | Implementation | §4.2, §4.3, §5, §5.1 and tests §7.1 | **[GATED]**: `packages/contracts/openapi/audit.openapi.yaml`. No migration. |
| Overview P-5 return + shared audit-action copy catalog | CON | Planning → Implementation | Spec 009 OD-009-3 reversal, AC-10 rewrite, re-pin | After RT-567-I is merged and deployed |

### 7.1 Acceptance tests for RT-567-I

1. Contract test: with mixed read and change rows seeded, `kind=change` returns **no** row whose action is in
   the read set, and returns every change row (including an unregistered code, D-2).
2. `kind=read` returns only read-set rows. Omitted `kind` returns both (no behaviour change).
3. `kind=bogus` → 400 `validation_error`.
4. Paging: with `kind=change` and reads interleaved between changes, walking `next_cursor` with `limit=1`
   yields every change row exactly once, newest first (covers the RT-211 anchor with the new filter).
5. Isolation unchanged: tenant B never sees tenant A rows with `kind` set; `store_manager` still gets 403;
   platform admin still scoped to the active tenant.
6. Every item carries `kind`, and `kind === kindOf(action)`.
7. Drift guard (§4.3) passes on `main` and fails when a `GET` `@Auditable` code is unregistered.

## 8. Risks and gaps

- **R1 — Scan cost when reads dominate.** `kind=change` is a filter over the `(tenant_id, occurred_at DESC)`
  index, not an index condition. If a tenant's recent history is almost all reads, "latest 10 changes" walks
  many rows. Mitigation in RT-567-I: measure with `EXPLAIN ANALYZE` on a seeded ratio (e.g. 50 reads per change).
  Escalation path: Option D (stored `kind` + an index on `(tenant_id, occurred_at DESC) WHERE kind = 'change'`),
  as a separate [GATED] migration item. Not needed to start.
- **R2 — Classification is judgement.** `context.switch.*` and `auth.signin.*` are `change` (session/security
  events an operator should see). `erpnext.*.pulled` is `read`. Revisit if the Overview shows these as noise;
  the open enum allows a later `security` kind without breaking clients.
- **R3 — RT-548 ordering** (§4.3). Not a blocker either way.
- **Not verified:** runtime volumes per tenant; Admin-Console strict-vs-tolerant response validation for
  `AuditEvent` (the console spec only names the pin file).

## Appendix A — action inventory on `ff9e683`

**`read` (29, all `@Auditable` on `GET` routes):**
`cash_variance_policy.device_read`, `cash_variance_policy.store_read`, `cash_variance_policy.store_revisions_listed`,
`cash_variance_policy.tenant_read`, `cash_variance_policy.tenant_revisions_listed`, `catalog.deltas.read`,
`catalog.snapshot.read`, `console_sales.detail_read`, `console_sales.listed`, `devices.impact_read`,
`devices.listed`, `devices.read`, `erpnext.bin_view.pulled`, `erpnext.postings.pulled`,
`erpnext_reconciliation.backlog.listed`, `erpnext_sync_ops.posting_backlog.listed`,
`erpnext_sync_ops.reconciliation_runs.listed`, `erpnext_sync_ops.summary.read`, `pairing_codes.listed`,
`sale_history.detail_read`, `sale_history.listed`, `sale_sync_ops.audit_timeline.read`,
`sale_sync_ops.needs_repair.listed`, `sale_sync_ops.status.read`, `settlement.payer_account.listed`,
`settlement.receivable.listed`, `settlement.receivable.read`, `shift_closes.listed`, `shift_closes.read`.

**`change` (everything else), as found:**
`@Auditable`: `catalog.product.create`, `catalog.tracking_profile.set`, `context.clear.store`,
`context.switch.store`, `context.switch.tenant`, `erpnext.bin_view.reported`, `erpnext.posting.outcome.recorded`,
`erpnext_item_map.{suggested,confirmed,retired}`, `erpnext_warehouse_map.{set,retired}`,
`sale.{captured,credit_reversed,refunded,returned,voided}`, `sale_sync_ops.repair.requested`,
`settlement.payer_account.created`, `shift.{opened,closed,cash_movement.recorded}`,
`unknown_item.{captured,dismissed,resolved.created,resolved.linked}`.
Direct emit: `auth.signin.{ok,failed}`, `connector.credential.{issued,rotated,revoked}`,
`connector.registration.{created,disabled}`, `erpnext_product_reconciliation.{repaired,run.triggered}`,
`erpnext_reconciliation.posting.{repaired,re_resolved}`, `erpnext_reconciliation.stock.repaired`,
`inventory.movement.{create,backfill}`, `pos.device.{paired,retired,revoked,rotated,rotation_rejected}`,
`pos.device.pairing_code.{issued,cancelled}`, `sale.receipt.reprinted`,
`settlement.{intent.recorded,payment.applied,claim.submitted,remittance.reconciled}`,
`unknown_item.idempotency_mismatch_rejected`.

The inventory came from `grep` over `apps/api/src` and is a snapshot. RT-567-I's guard (§4.3), not this list,
is the source of truth.
