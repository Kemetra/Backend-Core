-- 0063_inventory_effects_activation.down.sql — reverses
-- 0063_inventory_effects_activation.sql (RT-427).
--
-- Drops inventory_anchor_lines, inventory_anchors and the two activation
-- columns of tenant_inventory_settings. Refuses (the whole down rolls back)
-- when a tenant was ever activated or an anchor exists: the effects written
-- since activation are measured against that anchor, and dropping it would
-- silently lose the baseline they need (981).
--
-- The DO block reads under app.is_platform_admin and each tenant's
-- app.current_tenant (the 0056 pattern), so the guard sees every row even
-- when the migration role is subject to FORCE ROW LEVEL SECURITY.

BEGIN;

DO $$
DECLARE
  t uuid;
  anchors bigint := 0;
  activated bigint := 0;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  -- A uuid-shaped tenant before the loop: the tenants policy casts it.
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    anchors := anchors + (SELECT count(*) FROM inventory_anchors WHERE tenant_id = t);
    activated := activated + (
      SELECT count(*) FROM tenant_inventory_settings
       WHERE tenant_id = t AND sale_effects_activated_at IS NOT NULL);
  END LOOP;
  IF anchors > 0 THEN
    RAISE EXCEPTION '0063 down refused: % inventory_anchors row(s) exist', anchors;
  END IF;
  IF activated > 0 THEN
    RAISE EXCEPTION '0063 down refused: % tenant(s) have sale effects activated', activated;
  END IF;
END
$$;

DROP TABLE inventory_anchor_lines;
DROP TABLE inventory_anchors;

ALTER TABLE tenant_inventory_settings
  DROP CONSTRAINT tenant_inventory_settings_activation_pair,
  DROP COLUMN sale_effects_activated_by,
  DROP COLUMN sale_effects_activated_at;

COMMIT;
