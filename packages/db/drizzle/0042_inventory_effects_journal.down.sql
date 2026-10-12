-- 0042_inventory_effects_journal.down.sql — reverses
-- 0042_inventory_effects_journal.sql (RT-425).
--
-- Drops the integration table, the posted_at column and the stock_movements
-- effect columns. Refuses (the whole down rolls back) when a row carries data
-- the pre-0042 schema cannot hold: an effect with a non-retail origin, an
-- owning event, a compensation link or a position placeholder value, or a
-- posting intent with an ERP confirmation time (posted_at). Those are facts
-- and are never silently dropped. Rows written by the RT-425 write paths carry
-- an owning event, so once any exist this down refuses; that is intended
-- (981: rollback preserves historical inventory effects).
--
-- The DO block reads stock_movements under app.is_platform_admin and each
-- tenant's app.current_tenant (the 0038 pattern), so the guard sees every row
-- even when the migration role is subject to FORCE ROW LEVEL SECURITY.

BEGIN;

DO $$
DECLARE
  t uuid;
  n bigint := 0;
  posted bigint := 0;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    n := n + (
      SELECT count(*) FROM stock_movements
       WHERE tenant_id = t
         AND (origin <> 'retail'
              OR event_type IS NOT NULL
              OR compensates_effect_id IS NOT NULL
              OR stock_location_id IS NOT NULL
              OR inventory_status IS NOT NULL
              OR tracking_identity IS NOT NULL));
    posted := posted + (
      SELECT count(*) FROM erpnext_posting_status
       WHERE tenant_id = t AND posted_at IS NOT NULL);
  END LOOP;
  IF n > 0 THEN
    RAISE EXCEPTION
      '0042 down refused: % stock_movements row(s) carry effect data the pre-0042 schema cannot hold', n;
  END IF;
  IF posted > 0 THEN
    RAISE EXCEPTION
      '0042 down refused: % erpnext_posting_status row(s) carry an ERP confirmation time (posted_at)', posted;
  END IF;
END
$$;

ALTER TABLE erpnext_posting_status
  DROP CONSTRAINT erpnext_posting_status_posted_at_when_posted;
ALTER TABLE erpnext_posting_status DROP COLUMN posted_at;

DROP TABLE inventory_effect_integration;

DROP INDEX idx_stock_movements_tenant_event;
ALTER TABLE stock_movements DROP CONSTRAINT fk_stock_movements_compensates_tenant;
DROP INDEX uq_stock_movements_id_tenant;

ALTER TABLE stock_movements
  DROP CONSTRAINT stock_movements_compensates_not_self,
  DROP CONSTRAINT stock_movements_event_origin_consistent,
  DROP CONSTRAINT stock_movements_event_pair,
  DROP CONSTRAINT stock_movements_event_type_allowed,
  DROP CONSTRAINT stock_movements_origin_allowed;

ALTER TABLE stock_movements
  DROP COLUMN tracking_identity,
  DROP COLUMN inventory_status,
  DROP COLUMN stock_location_id,
  DROP COLUMN compensates_effect_id,
  DROP COLUMN event_ref_id,
  DROP COLUMN event_type,
  DROP COLUMN origin;

COMMIT;
