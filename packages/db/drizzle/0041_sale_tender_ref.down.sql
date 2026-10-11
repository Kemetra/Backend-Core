-- 0041_sale_tender_ref.down.sql — reverses 0041_sale_tender_ref.sql (RT-360).
--
-- Restores one tender per method per sale. Re-adding uq_sale_tenders_sale_method
-- fails (and the whole down rolls back) while any sale holds same-method
-- tenders: those rows are sale facts and are never silently dropped. Re-adding
-- the 0..2 tender_count bound is NOT VALID, like 0033's original.

BEGIN;

ALTER TABLE sales DROP CONSTRAINT sales_tender_count_range;
ALTER TABLE sales
  ADD CONSTRAINT sales_tender_count_range CHECK (tender_count BETWEEN 0 AND 2) NOT VALID;

ALTER TABLE sale_tenders
  ADD CONSTRAINT uq_sale_tenders_sale_method UNIQUE (sale_id, method);

DROP INDEX uq_sale_tenders_sale_sequence;
DROP INDEX uq_sale_tenders_sale_tender_ref;
DROP INDEX uq_sale_tenders_sale_method_legacy;

ALTER TABLE sale_tenders DROP CONSTRAINT sale_tenders_sequence_positive;

ALTER TABLE sale_tenders
  DROP COLUMN sequence,
  DROP COLUMN tender_ref;

COMMIT;
