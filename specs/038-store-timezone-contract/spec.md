# Spec 038 — Store time zone in the Store contract

| | |
|---|---|
| **Jira** | RT-401 (relates RT-279 Org & Store decomposition, RT-399, RT-400, RT-257) |
| **Work Mode** | Planning, then Implementation. This document is the Planning deliverable. |
| **Repository** | `Kemetra/Backend-Core` |
| **Baseline** | `origin/main` @ `2dc4b8e1` (2026-10-12) |
| **Status** | IMPLEMENTED (S1 contract + S2 runtime). The owner approved every recommendation (OD-1 to OD-5 = A) on 2026-10-12. Contract of record: `packages/contracts/openapi/stores.openapi.yaml`. |

## Objective

Let the Admin Console set a Store's IANA time zone when the store is created, and change it afterwards.

## Owner decisions this spec honours

From Confluence RETAIL page 23625729 (Organization & Store Management Product Architecture, 2026-10-07), section E:

| # | Decision |
|---|---|
| 212 | A valid IANA time zone is mandatory before production. |
| 213 | `UTC` may remain a draft technical default. It is not evidence of production readiness. |
| 214 | A time zone change is scheduled and impact-reviewed. It must not happen silently during an open shift or across a sensitive boundary. |
| 215 | Completed transactions keep the business date computed under the time configuration that applied when they happened. |
| 216 | Keep a seam for non-midnight business-day cutoffs (for example 04:00). Not built here. |

RT-401 owner reconciliation, 2026-10-11 (option A): the time zone stays editable after creation, under two conditions:

1. Never during an open shift. The change is blocked while any shift at that store is open.
2. An impact review happens before the change applies.

Completed transactions keep their original business date (215).

## What exists on `main` today

- `stores.timezone TEXT NOT NULL DEFAULT 'UTC'` was added by migration `0013_store_timezone.sql`. It has no CHECK constraint. That migration says IANA validation belongs to the future store-management surface, which is this spec.
- No API path writes the column. Every store is `UTC`.
- The Store OpenAPI (`packages/contracts/openapi/stores.openapi.yaml`) does not expose the column. `StoreCreate` is `{code, name}` and `StoreUpdate` is `{name?, is_active?}`. Both are `additionalProperties: false`.
- Three paths read the column inside SQL with `AT TIME ZONE`, and each persists the result at insert:
  - sale capture `business_date` (`apps/api/src/catalog/sales/sales.service.ts`);
  - sale return `business_date` (`sale-returns.service.ts`);
  - shift open and legacy-shift adoption `business_date` (`apps/api/src/pos-shifts/shift-cash-up.repository.ts`).
- Shifts live in `shifts`, with `lifecycle_state IN ('open','closed','closed_forced')`.
- Store writes (`POST` / `PATCH`) are limited to `owner` and `tenant_admin`. Today they emit no audit event.

## Functional requirements

- **FR-001** `Store` (the read shape for list, read, create and update responses) exposes `timezone`.
- **FR-002** `StoreCreate` accepts an optional `timezone`. When it is missing, the store is created with `UTC` (decision 213). See OD-1.
- **FR-003** A time zone is accepted only when it is a valid IANA zone name that PostgreSQL can resolve, because PostgreSQL computes every business date. Abbreviations (`EET`), POSIX offset strings (`UTC+2`, `+02:00`) and the `posix/` and `right/` trees are rejected. See OD-3.
- **FR-004** A dedicated read-only impact preview reports, for a proposed zone: the current and proposed zones, the store's UTC offset now under each zone, today's business date under each zone, whether the change is a no-op, and the blockers (server-known open shifts). The preview writes nothing.
- **FR-005** `StoreUpdate` accepts `timezone`. A change requires proof that the impact was reviewed (see OD-2) and an `expected_current_timezone` that still matches. A mismatch is a `409`.
- **FR-006** A change is refused with `409 store_has_open_shift` while any shift at that store has `lifecycle_state = 'open'`. The check runs in the same transaction as the write, with the store row locked.
- **FR-007** Shift open and legacy adoption must not race a time zone change. The store row is read with a lock so that a shift opened while a change is committing waits, then takes the new zone.
- **FR-008** A successful change writes one audit event `store.timezone.changed` in the same transaction, with `store_id`, `from` and `to`. Actor and tenant come from the request context.
- **FR-009** Business dates already persisted on sales, returns and shifts are never rewritten (decision 215).
- **FR-010** A `PATCH` that sets `timezone` to the current value is a no-op for the zone. It is not blocked by an open shift and writes no `store.timezone.changed` audit.
- **FR-011** The tenant isolation and role rules for `PATCH` are unchanged: `owner` and `tenant_admin`, wrong role or cross-tenant returns `404`. The preview uses the same rule.

## Out of scope

- Store readiness evaluation (decisions 212 and 213 as a gate). This spec only exposes the data that readiness needs.
- A business-day cutoff (216).
- Future-dated scheduled changes (see OD-5).
- An effective-dated time zone history (see OD-4).
- Admin-Console screens and type regeneration. That is a separate Admin slice (RT-400).
- Operating hours, address or relocation (208 to 211, 217).
