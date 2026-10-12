-- 0043_inventory_effect_integration_backfill.down.sql — reverses
-- 0043_inventory_effect_integration_backfill.sql (RT-425).
--
-- A no-op, like 0038's down: the backfilled `not_posted` rows are kept here,
-- and 0042's down drops inventory_effect_integration with them.

BEGIN;
COMMIT;
