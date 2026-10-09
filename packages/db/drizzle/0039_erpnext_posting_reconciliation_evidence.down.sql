-- 0039_erpnext_posting_reconciliation_evidence.down.sql
--
-- Rollback for 0039_erpnext_posting_reconciliation_evidence.sql (RT-332). Drops
-- the reconciliation evidence column; the rejection category stays, so affected
-- rows remain reconciliation dead-letters. The recorded document references are
-- LOST on rollback; take a backup first.

BEGIN;

ALTER TABLE erpnext_posting_status
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_reconciliation_ref_when_rejected;
ALTER TABLE erpnext_posting_status DROP COLUMN IF EXISTS reconciliation_document_ref;

COMMIT;
