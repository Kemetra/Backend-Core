-- 0064_stock_movements_store_occurred_idx.down.sql - reverses 0064_stock_movements_store_occurred_idx.sql (RT-735).
--
-- One statement, for the same reason as the up file: DROP INDEX CONCURRENTLY
-- cannot run inside a transaction block, and the runner wraps a multi-statement
-- file in one. The drop takes no lock that blocks movement reads or writes. IF
-- EXISTS so a rollback after a failed (invalid, then manually dropped) build
-- still completes.

DROP INDEX CONCURRENTLY IF EXISTS idx_stock_movements_tenant_store_occurred;
