# ADR 0011 — Outbox tenant FK, nil tenant id, and nullable tenant_id

**Status**: Accepted
**Date**: 2026-09-26
**Owner**: Issue #616 (audit epic #605)
**Constitution version**: v3.0.1
**Feature / Ref**: GitHub #616 · constitution §II

---

## Context

`outbox_events.tenant_id` has been `NOT NULL` since `0006_outbox_events.sql` and is covered by a FORCE RLS policy, but it had no foreign key to `tenants(id)`. Every other tenant-scoped table uses `REFERENCES tenants(id) ON DELETE RESTRICT`. A mistyped or stale id was accepted and became an orphan row no tenant could see, and deleting a tenant did not have to account for live outbox rows. Outbox payloads are replayed by workers, so that orphan is a durable poison pill rather than an immediate read leak.

`packages/db/src/middleware/tenant-context.ts` documents that the nil UUID `00000000-0000-0000-0000-000000000000` is only a GUC sentinel for platform-admin work (an empty `app.current_tenant` throws `22P02` before the platform-admin branch of an RLS predicate). The comment says no tenant may be created with that id. Nothing in the schema enforced it. A real tenant with that id would match the sentinel GUC when `is_platform_admin` is false.

`roles.tenant_id`, `auth_tokens.tenant_id`, and `audit_events.tenant_id` are nullable on purpose (`0000_initial.sql`, data-model.md §§6, 10, 12). Null means a platform-scoped row: a global role, a non-tenant token, or a platform audit event. Their RLS policies do not treat null as "visible to the current tenant."

`pairing_codes` (0024) and `external_identity_links` (0025) exist in SQL. Neither has a file under `packages/db/src/schema/`.

---

## Decisions

### D1. Add `outbox_events.tenant_id` → `tenants(id)` ON DELETE RESTRICT in migration 0031

The foreign key is added in a new migration. `0006_outbox_events.sql` is not edited. `ON DELETE CASCADE` is rejected: outbox history must not disappear because a tenant row was deleted. `RESTRICT` matches the other tenant-scoped foreign keys (for example `auth_tokens_device_fk` in `0001_pos_operator_identity.sql`). The constraint is validated immediately, not `NOT VALID`, because this schema is early-stage and an orphan `tenant_id` should fail the migration rather than be skipped.

The Drizzle table `outboxEvents.tenantId` records the same `references(() => tenants.id, { onDelete: "restrict" })`. That mirror does not change runtime SQL; producers still insert through the existing statement in `packages/db/src/outbox/producer.ts`.

| Alternative considered | Ruled out because |
|---|---|
| Edit `0006_outbox_events.sql` in place | Already-shipped migrations are immutable. |
| `ON DELETE CASCADE` | Would delete the replay ledger with the tenant. |
| `NOT VALID` plus a later `VALIDATE` | Other added foreign keys in this repo are validated at `ADD CONSTRAINT`. An orphan should fail closed. |

- **Tradeoff**: platform-scoped audit events used to store the nil UUID on `outbox_events.tenant_id` because the column was `NOT NULL` (`apps/api/src/audit/outbox-audit-enqueuer.ts`). That value is not a `tenants.id`. 0031 drops `NOT NULL`, rewrites those rows to SQL NULL, then adds the foreign key. NULL is allowed by a foreign key and matches `audit_events.tenant_id` for platform events. The session GUC is still the nil UUID via `runWithTenantContext`. The claim and dead-letter readers present NULL as the nil UUID so existing consumers keep a `string` tenant id. A tenant caller still cannot insert NULL: RLS `WITH CHECK` requires either a matching tenant GUC or `is_platform_admin`.

### D2. Reject the nil UUID on `tenants.id` with a CHECK, in the same migration

```sql
CONSTRAINT tenants_id_not_nil
  CHECK (id <> '00000000-0000-0000-0000-000000000000'::uuid)
```

Schema only. No backfill and no application guard added here. The Drizzle `tenants` table does not declare the older `tenants_slug_format` / `tenants_status_valid` checks either, so this CHECK stays in SQL only.

### D3. Do not make `roles`, `auth_tokens`, or `audit_events.tenant_id` NOT NULL

Null on these three columns is the platform scope, not a missing tenant:

- `roles`: `tenant_id IS NULL` is a global role. The read policy is `tenant_id IS NULL OR tenant_id = current tenant`, so every tenant can read global roles. `WITH CHECK` still requires `tenant_id IS NOT NULL` and a matching tenant, so a tenant cannot write a global role (`0000_initial.sql`).
- `auth_tokens`: null covers tokens that are not tenant-scoped. The policy shows a row to a tenant only when `tenant_id IS NOT NULL` and it matches the GUC; otherwise only a platform admin sees it.
- `audit_events`: null is a platform audit event. Same shape as `auth_tokens`. `insertAuditEvent` writes SQL NULL for that path and uses the nil UUID only as the session GUC, not as the stored `tenant_id`.

Forcing `NOT NULL` would either reject those rows or require a fake tenant, which D2 forbids. The policies are the isolation control. This ADR is the record so a later change does not "fix" the nulls.

### D4. Do not add unused Drizzle schema files for `pairing_codes` or `external_identity_links`

No test fails when a SQL table has no Drizzle schema file. Searched `packages/db/__tests__` and the rest of the repo. The catalog schema specs assert named exports only. They do not inventory `information_schema.tables` against `pgTable` definitions.

`pairing_codes` is read and updated with raw SQL in `apps/api/src/pos-terminal-pairing/pairing.repository.ts`. `external_identity_links` is not referenced from `packages/db/src`. Adding schema files nothing imports would not change runtime behavior and would not be enforced. The drift is recorded here instead.

`external_identity_links` is tenant-agnostic on purpose (migration 0025): the resolver reads it before a tenant GUC exists. It is not a missing `tenant_id`.

---

## Hard out-of-scope

- Editing `0006_outbox_events.sql` or any earlier migration.
- Changing nullability, RLS, or policies on `roles`, `auth_tokens`, or `audit_events`.
- Drizzle schema files for `pairing_codes` and `external_identity_links`.
- A CHECK or foreign key on any column other than `outbox_events.tenant_id` and `tenants.id`.

---

## Constitution Alignment

| Principle | Relationship |
|---|---|
| II. Multi-Tenant SaaS by Default | strengthened — outbox `tenant_id` now has the required foreign key, and the nil sentinel cannot be inserted as a tenant |
| II. Multi-Tenant SaaS by Default | constrained — three nullable `tenant_id` columns stay; isolation is the RLS predicate, not `NOT NULL` |
| III. Backend Authority & Data Integrity | strengthened — a tenant delete cannot drop outbox history (`ON DELETE RESTRICT`) |

The §II tension on nullable `tenant_id` is resolved by D3: null is a distinct platform scope, and the policies never expose that row to a tenant caller. It is not an unscoped tenant row.

---

## Open Questions

1. Platform-scoped audit outbox rows still store the nil UUID in `outbox_events.tenant_id`. D1 makes that insert invalid and D2 forbids a sentinel tenant. What should replace that write (skip the outbox row, allow NULL on this table for platform events, or another approach) is not decided here.

---

## References

- [Constitution §II](../constitution.md)
- [0000_initial.sql](../../../packages/db/drizzle/0000_initial.sql) — nullable `tenant_id` and the three RLS policies
- [0006_outbox_events.sql](../../../packages/db/drizzle/0006_outbox_events.sql) — `tenant_id UUID NOT NULL` with no FK
- [0031_outbox_tenant_fk.sql](../../../packages/db/drizzle/0031_outbox_tenant_fk.sql)
- [tenant-context.ts](../../../packages/db/src/middleware/tenant-context.ts) — nil UUID is a GUC sentinel
- [outbox-audit-enqueuer.ts](../../../apps/api/src/audit/outbox-audit-enqueuer.ts) — nil UUID stored on platform outbox rows
- [data-model.md](../../../specs/001-foundation-auth-tenant-store/data-model.md) §§6, 10, 12
- GitHub issue #616
