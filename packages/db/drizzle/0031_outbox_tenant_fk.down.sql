-- 0031_outbox_tenant_fk.down.sql
BEGIN;

ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_events_tenant_id_fk;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_id_not_nil;

COMMIT;
