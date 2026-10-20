-- 0060_posting_status_pending_created_store_idx.down.sql — reverses 0060_posting_status_pending_created_store_idx.sql (RT-565).
--
-- One statement, for the same reason as the up file: DROP INDEX CONCURRENTLY
-- cannot run inside a transaction block, and the runner wraps a multi-statement
-- file in one. The drop takes no lock that blocks posting reads or writes. IF
-- EXISTS so a rollback after a failed (invalid, then manually dropped) build
-- still completes.

DROP INDEX CONCURRENTLY IF EXISTS idx_erpnext_posting_status_pending_created_store;
