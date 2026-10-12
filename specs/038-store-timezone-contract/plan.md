# Plan 038 — Store time zone in the Store contract

Jira RT-401. Read `spec.md` first. The contract of record is `packages/contracts/openapi/stores.openapi.yaml`. It was first drafted under this folder, then copied over the contract of record once the owner approved the decisions below.

## 1. Design

### 1.1 Read shape

`Store` gains `timezone: string`, which is required in responses. The controller's `toBody` and `StoreRecord` carry it. No migration is needed because the column already exists.

### 1.2 Validation (FR-003)

PostgreSQL is the authority, because every business date is computed with `AT TIME ZONE` in SQL. A name that Node's `Intl` accepts but PostgreSQL does not would break sale capture. A name that PostgreSQL accepts can still be wrong: PostgreSQL reads POSIX strings such as `UTC+2` with the sign inverted.

The rule is applied in two stages:

1. **Shape check in Zod (no database):** the value is `UTC`, or it matches `^[A-Z][A-Za-z_]+(/[A-Za-z0-9_+\-]+){1,2}$`. It must also not start with `posix/`, `right/` or `Etc/GMT`. Anything else returns `400 validation_error`.
2. **Existence check inside the write transaction:** `SELECT 1 FROM pg_timezone_names WHERE name = $1`. A miss returns `400 invalid_timezone`.

The value is stored exactly as supplied. The match is case-sensitive, so `africa/cairo` is rejected.

### 1.3 Create (FR-002)

`timezone` is optional. When it is missing, the column default `UTC` applies. This is additive: today's Admin-Console create call (`{code, name}`) keeps working. When `timezone` is supplied, it goes through the same two-stage validation. Create is not blocked by shifts, because a new store has none.

### 1.4 Impact preview (FR-004)

```
GET /api/v1/stores/{store_id}/timezone-change-preview?timezone=Africa%2FCairo
→ 200 StoreTimezoneChangePreview
```

The roles are `owner` and `tenant_admin`, with `denyAs: 404`, the same as `PATCH`. The preview runs in one read-only tenant transaction:

| Field | Source |
|---|---|
| `current_timezone`, `proposed_timezone` | the store row and the query |
| `no_op` | `current === proposed` |
| `now`, `utc_offset_minutes_current`, `utc_offset_minutes_proposed` | `now()` and `pg_timezone_names.utc_offset` |
| `business_date_current`, `business_date_proposed` | `(now() AT TIME ZONE tz)::date` for each zone |
| `business_date_changes_now` | the two dates differ |
| `open_shift_count` | `count(*) FROM shifts WHERE store_id = $1 AND lifecycle_state = 'open'` |
| `blockers[]` | `[{code: "store_has_open_shift", count}]` when `open_shift_count > 0` |
| `can_apply` | `!no_op && blockers.length === 0` |
| `caveats[]` | fixed codes, always returned: `offline_shifts_not_visible`, `uncaptured_sales_use_new_zone` (see §3) |

A `GET` is used because the preview writes nothing and issues no token (see OD-2).

### 1.5 Change (FR-005 to FR-008, FR-010)

`PATCH /api/v1/stores/{store_id}` accepts three new optional fields:

```json
{ "timezone": "Africa/Cairo",
  "expected_current_timezone": "UTC",
  "timezone_impact_reviewed": true }
```

- `timezone` requires `expected_current_timezone` and `timezone_impact_reviewed: true`. Sending either of the other two without `timezone` is a `400`. This is checked in Zod.
- The service runs one tenant transaction:
  1. `SELECT … FROM stores WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`. A miss returns `404`.
  2. If `timezone === current`, treat it as a no-op for the zone (FR-010) and apply the other fields as today.
  3. If `expected_current_timezone !== current`, return `409 timezone_changed_concurrently`.
  4. If `pg_timezone_names` has no such zone, return `400 invalid_timezone`.
  5. If `shifts` has an open shift for the store, return `409 store_has_open_shift`.
  6. `UPDATE stores SET timezone, name?, is_active?, updated_at = now()`.
  7. Insert the audit event `store.timezone.changed` with `{store_id, from, to}` through the existing in-transaction audit writer (the `settlement/transactional-audit.ts` pattern). It is not written through `@Auditable`, because the event must commit or roll back with the change.

### 1.6 Race with shift open (FR-007)

The shift-open insert and the legacy adoption read the store zone with an unlocked sub-select. Without a lock, this sequence breaks the open-shift rule:

1. The zone change checks for open shifts and finds none.
2. A shift opens and computes its business date with the old zone.
3. The zone change commits.

The fix is to add `FOR SHARE` to the store sub-select in `INSERT_SHIFT_SQL` and `ADOPT_LEGACY_SHIFT_SQL`, in `shift-cash-up.repository.ts`. A shift open that runs during a change then waits and reads the new zone. A change that runs during a shift open then sees the open shift and returns `409`. This is a one-line change in each of the two statements. It is in scope because FR-006 cannot be guaranteed without it.

### 1.7 Errors

| Status | `error.code` | When |
|---|---|---|
| 400 | `validation_error` | Shape check failed, or the field combination is wrong. |
| 400 | `invalid_timezone` | The name is well formed but unknown to PostgreSQL. |
| 404 | `not_found` | Wrong role, another tenant's store, an unknown store, or a soft-deleted store. Non-disclosing. |
| 409 | `timezone_changed_concurrently` | `expected_current_timezone` is stale. |
| 409 | `store_has_open_shift` | A server-known shift is open at the store. |

## 2. Owner decisions

**Resolved 2026-10-12:** the owner approved every recommendation (A for OD-1 to OD-5). The contract and runtime implement those answers. F1 (time zone history) is not built. It needs its own Jira issue when G1 matters.

**OD-1 Is `timezone` required on create?**
- A (recommended): optional, defaulting to `UTC`. This is additive and matches decision 213. Admin-Console sends the zone from its form, and readiness flags `UTC` later.
- B: required. This is a breaking change for current `POST /stores` callers.

**OD-2 How is "impact review before it applies" enforced?**
- A (recommended): the `PATCH` carries `timezone_impact_reviewed: true` and `expected_current_timezone`. The server re-checks every blocker at write time, so the preview is advisory and the blockers are enforced. It needs no new secret or configuration.
- B: the preview issues a short-lived signed token, and the `PATCH` must present it. This proves the client fetched the preview. It adds a server signing secret, which is a production configuration change. It still cannot prove a human read the preview.

**OD-3 Which zone names are accepted?**
- A (recommended): canonical IANA `Area/Location` names known to PostgreSQL, plus `UTC`. Reject abbreviations, POSIX strings, `posix/*`, `right/*` and `Etc/GMT±N`, because `Etc/GMT-2` means UTC+2, which is an easy mistake to make.
- B: anything in `pg_timezone_names`.

**OD-4 Decision 215 has a gap (see §3, gap G1). Accept it for v1?**
- A (recommended): accept it for v1, and track the durable fix in a follow-up Jira issue. The durable fix is an effective-dated `store_timezone_history` table, with business dates computed using the zone in force at the transaction's `occurred_at`. That needs a `[GATED]` migration and changes to the capture paths for sales, returns and shifts.
- B: build the history now. This widens RT-401 into migration and capture-path work.

**OD-5 What does "scheduled" in decision 214 mean for v1?**
- A (recommended): option A as reconciled. The operator applies the change at a time they choose. The open-shift block and the impact review stand in for scheduling. A future-dated `effective_at` is deferred, and it would naturally arrive with OD-4 B.
- B: support a future-dated `effective_at` now. This needs a migration and a worker or lazy-apply path.

## 3. Known gaps (shown in the preview `caveats[]`)

- **G1 `uncaptured_sales_use_new_zone`.** Sales, returns and shifts compute `business_date` at server insert, using the zone in force at that moment. A sale that happened before the change but reaches the server afterwards gets a business date under the new zone. This breaks decision 215 at the day boundary. The open-shift block narrows the gap, because sales happen inside shifts, but it does not close it. A closed shift's sales can still be in a POS outbox. OD-4 decides how this is handled.
- **G2 `offline_shifts_not_visible`.** Backend-Core sees only shifts it has received. A shift opened offline on a POS that has not synced is invisible to the block. The preview says so, and the Admin UI should show it.

## 4. Slices

| Slice | Repository | Scope | Gate |
|---|---|---|---|
| **S0** this plan | Backend-Core | `specs/038-store-timezone-contract/**` | Done: owner approved OD-1 to OD-5 = A |
| **S1** contract | Backend-Core | `packages/contracts/openapi/stores.openapi.yaml` | Done. `[GATED]` contract path, authorised by RT-401 deliverable 1 and the owner's approval |
| **S2** runtime | Backend-Core | `apps/api/src/stores/{dto,stores.controller,stores.service,stores.repository}.ts`, a new `stores/timezone.ts` (validation and preview), `FOR SHARE` in `pos-shifts/shift-cash-up.repository.ts`, unit tests and Testcontainers integration tests | Done. No migration, dependency or CI change |
| **S3** Admin types | Admin-Console | Regenerate the Store types and add the form field | Separate Jira slice (RT-400 or a child) |
| **F1** (only if OD-4 B or OD-5 B is chosen) | Backend-Core | Time zone history migration and capture-path change | Its own `[GATED]` Jira issue |

### S2 test plan

- **Unit tests (`apps/api`):**
  - Zod shape accept and reject tables: `UTC`, `Africa/Cairo` and `America/Argentina/Buenos_Aires` are accepted. `EET`, `UTC+2`, `+02:00`, `Etc/GMT-2`, `posix/Africa/Cairo` and `africa/cairo` are rejected.
  - Field-combination refinements.
  - `toBody` includes `timezone`.
- **Integration tests (Testcontainers, `db-integration`):**
  - create with and without `timezone`;
  - a `PATCH` change commits, and the audit row is written;
  - the no-op path;
  - a stale `expected_current_timezone` returns `409`;
  - an open shift returns `409` and nothing is written;
  - an unknown zone returns `400` and nothing is written;
  - another tenant's store returns `404`;
  - the preview fields, using a zone pair whose dates differ at a pinned `now()`;
  - an existing sale's and shift's `business_date` are unchanged after a change (FR-009);
  - the concurrent shift-open and change test for FR-007, using two clients.
