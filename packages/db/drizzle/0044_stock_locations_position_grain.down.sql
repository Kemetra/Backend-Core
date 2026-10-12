-- 0044_stock_locations_position_grain.down.sql — reverses
-- 0044_stock_locations_position_grain.sql (RT-432).
--
-- Drops the stock_movements position constraints, the stores trigger, the
-- stock_locations table and restores 0042's integration-state CHECK. Refuses
-- (the whole down rolls back) when a row carries data the pre-0044 schema
-- cannot represent: an effect that names a stock location (dropping the table
-- would leave its position pointing nowhere) or an `erp_neutral` integration
-- state (0042's CHECK does not allow it). Those are facts and are never
-- silently dropped (981). Effects written by the RT-432 write paths carry a
-- location, so once any exist this down refuses; that is intended.
--
-- The DO block reads under app.is_platform_admin and each tenant's
-- app.current_tenant (the 0038 / 0042 pattern), so the guard sees every row
-- even when the migration role is subject to FORCE ROW LEVEL SECURITY.

BEGIN;

DO $$
DECLARE
  t uuid;
  positioned bigint := 0;
  neutral bigint := 0;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    positioned := positioned + (
      SELECT count(*) FROM stock_movements
       WHERE tenant_id = t
         AND (stock_location_id IS NOT NULL
              OR inventory_status IS NOT NULL
              OR tracking_identity IS NOT NULL));
    neutral := neutral + (
      SELECT count(*) FROM inventory_effect_integration
       WHERE tenant_id = t AND state = 'erp_neutral');
  END LOOP;
  IF positioned > 0 THEN
    RAISE EXCEPTION
      '0044 down refused: % stock_movements row(s) carry a position the pre-0044 schema cannot resolve', positioned;
  END IF;
  IF neutral > 0 THEN
    RAISE EXCEPTION
      '0044 down refused: % inventory_effect_integration row(s) are erp_neutral', neutral;
  END IF;
END
$$;

ALTER TABLE inventory_effect_integration
  DROP CONSTRAINT inventory_effect_integration_erp_neutral_bare,
  DROP CONSTRAINT inventory_effect_integration_state_allowed;
ALTER TABLE inventory_effect_integration
  ADD CONSTRAINT inventory_effect_integration_state_allowed
    CHECK (state IN ('not_posted', 'pending', 'confirmed', 'rejected',
                     'reconciliation_required', 'external'));

ALTER TABLE stock_movements
  DROP CONSTRAINT fk_stock_movements_location_store_tenant,
  DROP CONSTRAINT stock_movements_tracking_none,
  DROP CONSTRAINT stock_movements_inventory_status_allowed,
  DROP CONSTRAINT stock_movements_position_required;

DROP TRIGGER stores_create_primary_location ON stores;
DROP FUNCTION stores_create_primary_location();

DROP TABLE stock_locations;
DROP FUNCTION stock_locations_guard_identity();

COMMIT;
