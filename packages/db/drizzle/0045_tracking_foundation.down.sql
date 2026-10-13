-- 0045_tracking_foundation.down.sql — reverses 0045_tracking_foundation.sql
-- (RT-448).
--
-- Drops the stock_movements tracking reference, the edge map, the identities
-- table and the tenant_products Tracking Profile. Refuses (the whole down
-- rolls back) while any row carries data the pre-0045 schema cannot represent:
-- a tracking identity, an edge-map row, an effect that names an identity, or a
-- product whose profile is not the default (none, no expiry). Those are facts
-- and are never silently dropped (981).
--
-- The DO block reads under app.is_platform_admin and each tenant's
-- app.current_tenant (the 0038 / 0042 / 0044 pattern), so the guard sees every
-- row even when the migration role is subject to FORCE ROW LEVEL SECURITY.

BEGIN;

DO $$
DECLARE
  t uuid;
  identities bigint := 0;
  mappings bigint := 0;
  tracked_effects bigint := 0;
  profiled bigint := 0;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    identities := identities + (
      SELECT count(*) FROM tracking_identities WHERE tenant_id = t);
    mappings := mappings + (
      SELECT count(*) FROM erpnext_tracking_map WHERE tenant_id = t);
    tracked_effects := tracked_effects + (
      SELECT count(*) FROM stock_movements
       WHERE tenant_id = t AND tracking_identity_id IS NOT NULL);
    profiled := profiled + (
      SELECT count(*) FROM tenant_products
       WHERE tenant_id = t AND (tracking_mode <> 'none' OR expiry_required));
  END LOOP;
  IF tracked_effects > 0 THEN
    RAISE EXCEPTION
      '0045 down refused: % stock_movements row(s) name a tracking identity', tracked_effects;
  END IF;
  IF identities > 0 OR mappings > 0 THEN
    RAISE EXCEPTION
      '0045 down refused: % tracking identit(ies) and % ERPNext tracking mapping(s) exist', identities, mappings;
  END IF;
  IF profiled > 0 THEN
    RAISE EXCEPTION
      '0045 down refused: % tenant_products row(s) carry a non-default tracking profile', profiled;
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_stock_movements_tracking_identity;
ALTER TABLE stock_movements
  DROP CONSTRAINT stock_movements_tracking_identity_needs_product,
  DROP CONSTRAINT fk_stock_movements_tracking_identity;
ALTER TABLE stock_movements
  DROP COLUMN tracking_identity_id;

DROP TABLE erpnext_tracking_map;

DROP TABLE tracking_identities;
DROP FUNCTION tracking_identities_guard_identity();

DROP TRIGGER tenant_products_guard_tracking_profile ON tenant_products;
DROP FUNCTION tenant_products_guard_tracking_profile();
DROP INDEX IF EXISTS uq_tenant_products_id_tenant;
ALTER TABLE tenant_products
  DROP CONSTRAINT tenant_products_expiry_requires_batch,
  DROP CONSTRAINT tenant_products_tracking_mode_allowed;
ALTER TABLE tenant_products
  DROP COLUMN expiry_required,
  DROP COLUMN tracking_mode;

COMMIT;
