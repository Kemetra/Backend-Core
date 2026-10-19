-- 0055_inventory_position_events.down.sql — reverses
-- 0055_inventory_position_events.sql (RT-435).
--
-- Drops tenant_inventory_settings and inventory_position_events. Refuses (the
-- whole down rolls back) when either holds a fact the pre-0055 schema cannot
-- represent: a status-move or relocation event record (its effects name it
-- through event_ref_id, and dropping it would leave them pointing nowhere), or
-- a tenant whose return landing status is not the default. Those are never
-- silently dropped (981).
--
-- The DO block reads under app.is_platform_admin and each tenant's
-- app.current_tenant (the 0051 / 0054 pattern), so the guard sees every
-- row even when the migration role is subject to FORCE ROW LEVEL SECURITY.

BEGIN;

DO $$
DECLARE
  t uuid;
  events bigint := 0;
  policies bigint := 0;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  -- A uuid-shaped tenant before the loop: the tenants policy casts it.
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    events := events + (
      SELECT count(*) FROM inventory_position_events WHERE tenant_id = t);
    policies := policies + (
      SELECT count(*) FROM tenant_inventory_settings
       WHERE tenant_id = t AND return_landing_status <> 'sellable');
  END LOOP;
  IF events > 0 THEN
    RAISE EXCEPTION
      '0055 down refused: % inventory_position_events row(s) own effects', events;
  END IF;
  IF policies > 0 THEN
    RAISE EXCEPTION
      '0055 down refused: % tenant(s) have a non-default return landing status', policies;
  END IF;
END
$$;

DROP TABLE tenant_inventory_settings;
DROP TABLE inventory_position_events;

COMMIT;
