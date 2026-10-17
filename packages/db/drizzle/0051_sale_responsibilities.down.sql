-- 0051_sale_responsibilities.down.sql
--
-- Rollback for 0051_sale_responsibilities.sql (RT-418). Drops the payer
-- responsibilities, sales.responsibility_count, the frozen
-- payer_external_ref and the payer composite FK target, and restores
-- payer_account.credit_terms (empty: its values are not recoverable).
-- Responsibility facts would be LOST, and a credit sale would then read as a
-- cash or tender-unknown sale, so the rollback REFUSES while any
-- responsibility row exists: back up, decide, and delete them explicitly
-- first. The table is FORCE ROW LEVEL SECURITY and the production migration
-- owner is not a superuser (docs/operations/database-roles.md), so the guard
-- reads under app.is_platform_admin and each tenant's app.current_tenant
-- (the 0042 / 0045 pattern); a bare SELECT would see no rows and drop them.

BEGIN;

DO $$
DECLARE
  t uuid;
  rows_found bigint := 0;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  -- A session that set app.current_tenant before holds '' (not NULL) after
  -- that transaction, and the tenants policy casts it to uuid: start from a
  -- valid nil uuid so the policy evaluates (is_platform_admin admits all).
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    rows_found := rows_found + (SELECT count(*) FROM sale_responsibilities WHERE tenant_id = t);
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0051 down refused: sale_responsibilities has % row(s); back up and delete them explicitly first', rows_found;
  END IF;
END
$$;

ALTER TABLE erpnext_posting_resolution DROP COLUMN IF EXISTS payer_external_ref;

DROP TABLE IF EXISTS sale_responsibilities;

ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_responsibility_count_range;
ALTER TABLE sales DROP COLUMN IF EXISTS responsibility_count;

DROP INDEX IF EXISTS "UQ_idx_payer_account_id_tenant";

ALTER TABLE payer_account ADD COLUMN IF NOT EXISTS credit_terms JSONB;

COMMIT;
