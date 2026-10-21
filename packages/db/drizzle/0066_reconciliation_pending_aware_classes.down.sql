-- 0066_reconciliation_pending_aware_classes.down.sql
--
-- Rollback for 0066_reconciliation_pending_aware_classes.sql (RT-428):
-- narrows erpnext_reconciliation_result_class_valid back to the 0020
-- vocabulary.
--
-- Refuses while any result carries one of the 0066 classes: a reconciliation
-- result is evidence and is never deleted or rewritten to fit a narrower
-- CHECK (Reconciliation is non-destructive, 926–942). Supports the
-- UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0066-reconciliation-pending-aware-classes.spec.ts.

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM erpnext_reconciliation_result
   WHERE mismatch_class IN ('expected_pending_erp', 'expected_pending_retail',
                            'erp_snapshot_stale', 'uom_mismatch');
  IF n > 0 THEN
    RAISE EXCEPTION '0066 down refused: % erpnext_reconciliation_result row(s) carry a 0066 class', n;
  END IF;
END
$$;

ALTER TABLE erpnext_reconciliation_result
  DROP CONSTRAINT erpnext_reconciliation_result_class_valid;

ALTER TABLE erpnext_reconciliation_result
  ADD CONSTRAINT erpnext_reconciliation_result_class_valid
    CHECK (mismatch_class IN (
      'match', 'quantity_divergence', 'unmapped_store', 'unmapped_item',
      'dp2_only', 'erpnext_only', 'negative_balance_flagged'
    ));

COMMIT;
