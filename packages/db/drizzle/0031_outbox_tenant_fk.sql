-- 0031_outbox_tenant_fk.sql
--
-- #616 — outbox_events.tenant_id is NOT NULL but had no FK to tenants(id).
-- It was the only tenant-scoped table without that FK (constitution §II).
-- ON DELETE RESTRICT: a tenant with outbox history cannot be removed out
-- from under the ledger. Not CASCADE.
--
-- The nil UUID is the platform-admin GUC sentinel (tenant-context.ts).
-- No tenants row may use it.
--
-- Platform-scoped audit events stored that sentinel in
-- outbox_events.tenant_id because the column was NOT NULL
-- (outbox-audit-enqueuer). A foreign key to tenants(id) rejects it,
-- and so does the nil-tenant CHECK if a fake tenants row were added.
-- Those rows are platform scope, same as audit_events.tenant_id NULL:
-- drop NOT NULL, rewrite the sentinel to NULL, then add the FK.
-- NULL does not have to reference tenants. RLS WITH CHECK still
-- requires platform-admin (or a matching tenant GUC) to write the row.
--
-- Does not change nullability of roles, auth_tokens, or
-- audit_events.tenant_id. Those nulls are platform-scoped rows (ADR 0011).
BEGIN;

ALTER TABLE outbox_events
  ALTER COLUMN tenant_id DROP NOT NULL;

UPDATE outbox_events
   SET tenant_id = NULL
 WHERE tenant_id = '00000000-0000-0000-0000-000000000000'::uuid;

ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_tenant_id_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_id_not_nil
  CHECK (id <> '00000000-0000-0000-0000-000000000000'::uuid);

COMMIT;
