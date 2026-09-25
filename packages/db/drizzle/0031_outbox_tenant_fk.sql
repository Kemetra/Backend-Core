-- 0031_outbox_tenant_fk.sql
--
-- #616 — outbox_events.tenant_id is NOT NULL but had no FK to tenants(id).
-- It was the only tenant-scoped table without that FK (constitution §II).
-- ON DELETE RESTRICT: a tenant with outbox history cannot be removed out
-- from under the ledger. Not CASCADE.
--
-- The nil UUID is the platform-admin GUC sentinel (tenant-context.ts).
-- No tenants row may use it. Schema only — no data backfill.
--
-- Does not change nullability of roles, auth_tokens, or
-- audit_events.tenant_id. Those nulls are platform-scoped rows (ADR 0011).
BEGIN;

ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_tenant_id_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_id_not_nil
  CHECK (id <> '00000000-0000-0000-0000-000000000000'::uuid);

COMMIT;
