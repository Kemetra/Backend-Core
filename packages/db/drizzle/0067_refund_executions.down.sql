-- 0067_refund_executions.down.sql
--
-- Rollback for 0067_refund_executions.sql (RT-787). Drops refund_executions,
-- the allocation columns of sale_return_tenders, their trigger and indexes,
-- and sale_returns.posting_deferred. Every refund execution (proof that cash
-- left the drawer), every allocation identity and every deferred-posting mark
-- would be LOST, and a deferred return would then never be posted, so the
-- rollback REFUSES while any of them exists: back up, decide, and delete them
-- explicitly first. The tables are FORCE ROW LEVEL SECURITY and the
-- production migration owner is not a superuser
-- (docs/operations/database-roles.md), so the guard reads under
-- app.is_platform_admin and each tenant's app.current_tenant (the 0051 / 0054
-- pattern); a bare SELECT would see no rows and drop them.

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
      + (SELECT count(*) FROM refund_executions WHERE tenant_id = t)
      + (SELECT count(*) FROM sale_return_tenders
          WHERE tenant_id = t
            AND (allocation_ref IS NOT NULL OR original_tender_ref IS NOT NULL OR instrument IS NOT NULL))
      + (SELECT count(*) FROM sale_returns WHERE tenant_id = t AND posting_deferred);
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0067 down refused: % refund execution(s), allocation(s) or deferred return(s) exist; back up and delete them explicitly first', rows_found;
  END IF;
END
$$;

DROP TABLE IF EXISTS refund_executions;
DROP TRIGGER IF EXISTS sale_return_tenders_original_tender_check ON sale_return_tenders;
DROP FUNCTION IF EXISTS sale_return_tenders_original_tender_check();
DROP INDEX IF EXISTS uq_sale_return_tenders_id_return_allocation;
DROP INDEX IF EXISTS uq_sale_return_tenders_return_allocation;
ALTER TABLE sale_return_tenders
  DROP CONSTRAINT IF EXISTS sale_return_tenders_instrument_valid,
  DROP COLUMN IF EXISTS instrument,
  DROP COLUMN IF EXISTS original_tender_ref,
  DROP COLUMN IF EXISTS allocation_ref;
ALTER TABLE sale_returns DROP COLUMN IF EXISTS posting_deferred;

COMMIT;
