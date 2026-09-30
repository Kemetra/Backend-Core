-- 0033_sale_tenders.down.sql
--
-- Rollback for 0033_sale_tenders.sql (RT-77). Drops sale_tenders and the two
-- sales columns (with their constraints). Recorded tenders and device
-- attribution are LOST on rollback; take a backup first if any exist.

BEGIN;

DROP TABLE IF EXISTS sale_tenders;

ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_tender_count_range;
ALTER TABLE sales DROP CONSTRAINT IF EXISTS fk_sales_device;
ALTER TABLE sales DROP COLUMN IF EXISTS tender_count;
ALTER TABLE sales DROP COLUMN IF EXISTS device_id;

COMMIT;
