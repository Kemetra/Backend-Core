-- 0048_sales_store_business_date_idx.down.sql — reverses
-- 0048_sales_store_business_date_idx.sql (RT-538).
--
-- One statement, for the same reason as the up file: DROP INDEX CONCURRENTLY
-- cannot run inside a transaction block, and the runner wraps a multi-statement
-- file in one. The drop takes no lock that blocks sale reads or writes. IF
-- EXISTS so a rollback after a failed (invalid, then manually dropped) build
-- still completes.

DROP INDEX CONCURRENTLY IF EXISTS idx_sales_tenant_store_business_date;
