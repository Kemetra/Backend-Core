-- 0037_erpnext_posting_resolution.down.sql
--
-- Rollback for 0037_erpnext_posting_resolution.sql (RT-330). Drops the frozen
-- resolution history and current_resolution_version; the feed falls back to
-- the live item-map join for every intent. Resolution history is LOST on
-- rollback; take a backup first.

BEGIN;

ALTER TABLE erpnext_posting_status
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_resolution_version_positive;
ALTER TABLE erpnext_posting_status DROP COLUMN IF EXISTS current_resolution_version;

DROP TABLE IF EXISTS erpnext_posting_resolution;

DROP INDEX IF EXISTS "UQ_idx_erpnext_posting_status_id_tenant";

COMMIT;
