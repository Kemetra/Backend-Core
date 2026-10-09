-- 0038_erpnext_posting_resolution_backfill.down.sql
--
-- Rollback for 0038_erpnext_posting_resolution_backfill.sql (RT-330). A no-op:
-- the backfilled resolution rows are append-only history (the table has no
-- DELETE policy) and stay valid if 0038 is re-applied, which skips intents
-- that already carry a version. Rolling back 0037 drops them with the table.

BEGIN;
COMMIT;
