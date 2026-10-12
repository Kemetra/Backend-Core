-- 0043_inventory_effect_integration_backfill.sql
--
-- Backfill for 0042_inventory_effects_journal (Jira RT-425). [GATED] under the
-- same owner authorization as 0042 (RT-289 comments 11682 / 11685).
--
-- Every stock_movements row that exists when this runs gets one
-- inventory_effect_integration row in state `not_posted` (RT-289 Q2): no ERP
-- posting intent represents any of them. On main, the only writers are the
-- manual movement, transfer and count paths, none of which posts to ERPNext
-- (an ERPNext sale decrement comes from the Sales Invoice itself, not from a
-- 009 movement). Divergence stays explicit and observable (730).
--
-- Split from 0042 (the 0037/0038 precedent): 0042's DDL takes ACCESS
-- EXCLUSIVE on stock_movements until its COMMIT; this bulk insert runs in its
-- own migration and only reads stock_movements.
--
-- RLS: stock_movements and inventory_effect_integration are FORCE ROW LEVEL
-- SECURITY with tenant-GUC policies. The loop reads tenants under
-- app.is_platform_admin (which tenants_tenant_isolation honours) and sets
-- app.current_tenant per tenant, so the backfill runs under the existing
-- policies without lifting FORCE on any table. Explicit tenant predicates
-- keep the result identical when the migration runs as a superuser.
-- Idempotent: ON CONFLICT (effect_id) DO NOTHING skips rows already present.
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): unchanged from 0042.
-- Reversible via 0043_inventory_effect_integration_backfill.down.sql (a no-op:
-- the backfilled rows are kept; 0042's down drops the table).

BEGIN;

DO $$
DECLARE
  t uuid;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    INSERT INTO inventory_effect_integration (effect_id, tenant_id, state)
    SELECT sm.id, sm.tenant_id, 'not_posted'
      FROM stock_movements sm
     WHERE sm.tenant_id = t
    ON CONFLICT (effect_id) DO NOTHING;
  END LOOP;
END
$$;

COMMIT;
