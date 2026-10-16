-- 0049_sale_responsibilities.down.sql
--
-- Rollback for 0049_sale_responsibilities.sql (RT-418). Drops the payer
-- responsibilities, sales.responsibility_count, the frozen
-- payer_external_ref and the payer composite FK target, and restores
-- payer_account.credit_terms (empty: its values are not recoverable).
-- Responsibility facts would be LOST, and a credit sale would then read as a
-- cash or tender-unknown sale, so the rollback REFUSES while any
-- responsibility row exists (the 0041 precedent): back up, decide, and delete
-- them explicitly first.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM sale_responsibilities) THEN
    RAISE EXCEPTION '0049 down refused: sale_responsibilities has rows; back up and delete them explicitly first';
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
