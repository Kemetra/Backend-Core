-- 0047_sale_history_capture.down.sql — reverses 0047_sale_history_capture.sql (RT-538).
--
-- Drops sale_reprints (and every reprint record in it), the receipt snapshot
-- columns on sales and line_seq on sale_lines. Any snapshot or line sequence a
-- capture stored is lost with them; the sale and line rows themselves are
-- untouched. Roll back 0048 first (the runner's one-step `down` does).
--
-- Valid only while no runtime uses these objects (before RT-539 is deployed);
-- after that, roll back the runtime first.
--
-- Lock impact: heavier than the up. DROP TABLE sale_reprints takes ACCESS
-- EXCLUSIVE on sale_reprints and on every table its FKs reference (tenants,
-- stores, devices, sales), so reads of those tables, device-auth lookups
-- included, wait for this short transaction; sales and sale_lines also take
-- ACCESS EXCLUSIVE for the column drops (metadata-only, no rewrite).
-- lock_timeout bounds each wait at 2s.

BEGIN;

SET LOCAL lock_timeout = '2s';

DROP TABLE sale_reprints;

ALTER TABLE sale_lines DROP CONSTRAINT sale_lines_line_seq_positive;
ALTER TABLE sale_lines DROP COLUMN line_seq;

ALTER TABLE sales DROP CONSTRAINT sales_receipt_change_given_non_negative;
ALTER TABLE sales DROP CONSTRAINT sales_receipt_snapshot_all_or_none;
ALTER TABLE sales
  DROP COLUMN receipt_change_given,
  DROP COLUMN receipt_tax_registration_id,
  DROP COLUMN receipt_branch_address,
  DROP COLUMN receipt_branch_name,
  DROP COLUMN receipt_settled_at,
  DROP COLUMN receipt_operator_display_name,
  DROP COLUMN receipt_terminal_label,
  DROP COLUMN receipt_number,
  DROP COLUMN receipt_sale_number;

COMMIT;
