-- 0054_sale_credit_reversals.down.sql
--
-- Rollback for 0054_sale_credit_reversals.sql (RT-577). Drops the credit
-- reversal tables, the shared approval-use ledger and its sale_voids trigger.
-- A credit reversal's allocation, payer adjustment, actor, reason and second
-- approval would be LOST (its sale_voids / sale_returns row would remain and
-- read as an ordinary reversal), and a credit return's approval id would
-- become reusable, so the rollback REFUSES while any credit reversal or any
-- credit-return approval use exists: back up, decide, and delete them
-- explicitly first. The void-sourced ledger rows are derived from sale_voids
-- and are rebuilt by up. The tables are FORCE ROW LEVEL SECURITY and the
-- production migration owner is not a superuser
-- (docs/operations/database-roles.md), so the guard reads under
-- app.is_platform_admin and each tenant's app.current_tenant (the 0051
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
      + (SELECT count(*) FROM sale_credit_reversals WHERE tenant_id = t)
      + (SELECT count(*) FROM sale_approval_uses WHERE tenant_id = t AND source = 'credit_return');
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0054 down refused: % credit reversal row(s) or credit-return approval use(s) exist; back up and delete them explicitly first', rows_found;
  END IF;
END
$$;

DROP TABLE IF EXISTS sale_credit_reversal_tenders;
DROP TABLE IF EXISTS sale_credit_reversals;
DROP TRIGGER IF EXISTS sale_voids_record_approval_use ON sale_voids;
DROP FUNCTION IF EXISTS sale_voids_record_approval_use();
DROP TABLE IF EXISTS sale_approval_uses;
DROP INDEX IF EXISTS uq_sale_returns_id_sale;
DROP INDEX IF EXISTS uq_sale_voids_id_sale;

COMMIT;
