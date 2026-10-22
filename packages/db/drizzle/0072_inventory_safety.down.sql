-- 0072_inventory_safety.down.sql
--
-- Rollback for 0072_inventory_safety.sql (RT-449). Drops the safety
-- revisions, the change log, recalls, tracking holds and the expiry
-- correction history, the tracking_identities UPDATE policy and the
-- tenant_inventory_settings.safety_ttl_seconds column, and restores 0045's
-- tracking_identities guard body. Every hold (a safety block on selling a
-- lot), every recall, every correction history row and a tenant's Safety TTL
-- would be LOST, so the rollback REFUSES while any of them exists: back up,
-- decide, and delete them explicitly first. The tables are FORCE ROW LEVEL
-- SECURITY and the production migration owner is not a superuser
-- (docs/operations/database-roles.md), so the guard reads under
-- app.is_platform_admin and each tenant's app.current_tenant (the 0051 /
-- 0054 / 0067 pattern); a bare SELECT would see no rows and drop them.

BEGIN;

DO $$
DECLARE
  t uuid;
  rows_found bigint := 0;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    rows_found := rows_found
      + (SELECT count(*) FROM tenant_inventory_safety_revisions WHERE tenant_id = t)
      + (SELECT count(*) FROM inventory_safety_changes WHERE tenant_id = t)
      + (SELECT count(*) FROM inventory_recalls WHERE tenant_id = t)
      + (SELECT count(*) FROM tracking_holds WHERE tenant_id = t)
      + (SELECT count(*) FROM tracking_identity_expiry_corrections WHERE tenant_id = t)
      + (SELECT count(*) FROM tenant_inventory_settings
          WHERE tenant_id = t AND safety_ttl_seconds IS NOT NULL);
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0072 down refused: % safety revision(s), change(s), recall(s), hold(s), expiry correction(s) or Safety TTL setting(s) exist; back up and delete them explicitly first', rows_found;
  END IF;
END
$$;

ALTER TABLE tenant_inventory_settings
  DROP CONSTRAINT IF EXISTS tenant_inventory_settings_safety_ttl_range,
  DROP COLUMN IF EXISTS safety_ttl_seconds;

DROP POLICY IF EXISTS tracking_identities_tenant_update ON tracking_identities;

-- The 0045 body, verbatim.
CREATE OR REPLACE FUNCTION tracking_identities_guard_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.tenant_product_ref <> OLD.tenant_product_ref
     OR NEW.kind <> OLD.kind
     OR NEW.code <> OLD.code
     OR NEW.origin <> OLD.origin THEN
    RAISE EXCEPTION
      'tracking_identities % : tenant, product, kind, code and origin are immutable', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TABLE IF EXISTS inventory_safety_changes;
DROP TABLE IF EXISTS tracking_identity_expiry_corrections;
DROP TABLE IF EXISTS tracking_holds;
DROP TABLE IF EXISTS inventory_recalls;
DROP TABLE IF EXISTS tenant_inventory_safety_revisions;
DROP FUNCTION IF EXISTS tracking_holds_guard_release();
DROP FUNCTION IF EXISTS tenant_inventory_safety_revisions_guard();

COMMIT;
