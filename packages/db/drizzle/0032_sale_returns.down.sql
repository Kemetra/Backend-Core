-- 0032_sale_returns.down.sql
--
-- Rollback for 0032_sale_returns.sql (RT-73). Drops the three return tables
-- (children first), the one-void-per-sale index and sale_voids.business_date.
-- Recorded returns are LOST on rollback; take a backup first if any exist.

BEGIN;

DROP TABLE IF EXISTS sale_return_tenders;
DROP TABLE IF EXISTS sale_return_lines;
DROP TABLE IF EXISTS sale_returns;

DROP TRIGGER IF EXISTS sale_voids_business_date_fill ON sale_voids;
DROP FUNCTION IF EXISTS sale_voids_fill_business_date();
DROP INDEX IF EXISTS uq_sale_voids_one_per_sale;

ALTER TABLE sale_voids DROP COLUMN IF EXISTS business_date;

COMMIT;
