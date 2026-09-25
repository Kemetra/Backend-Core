-- 0031_outbox_tenant_fk.down.sql
BEGIN;

ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_events_tenant_id_fk;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_id_not_nil;

-- Pre-0031 stored the nil UUID for platform-scoped rows. Put it back
-- before NOT NULL, and only after the FK is gone (nil is not a tenant).
UPDATE outbox_events
   SET tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 WHERE tenant_id IS NULL;

ALTER TABLE outbox_events
  ALTER COLUMN tenant_id SET NOT NULL;

COMMIT;
