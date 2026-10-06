-- 0036_shift_cash_up.down.sql
--
-- Rollback for 0036_shift_cash_up.sql (RT-17 slice 2). Drops, in order: the
-- sales recompute index, the three append-only fact tables (claims → closes
-- → movements; their triggers and policies go with them), the shifts guard
-- triggers and the trigger functions, then the shifts cash-up indexes,
-- constraints and columns.
--
-- DATA LOSS: every recorded cash movement, close and refund claim is LOST,
-- and each cash-up shift row is kept only as a lifecycle row (its currency,
-- float, business date, receipt time, actor and payload hash are dropped;
-- a closed one keeps its lifecycle_state). Take a backup first if the
-- cash-up history matters.

BEGIN;

DROP INDEX IF EXISTS idx_sales_tenant_device_occurred;

DROP TABLE IF EXISTS shift_refund_claims;
DROP TABLE IF EXISTS shift_closes;
DROP TABLE IF EXISTS shift_cash_movements;

DROP TRIGGER IF EXISTS shifts_cash_up_guard_row ON shifts;
DROP TRIGGER IF EXISTS shifts_cash_up_guard_truncate ON shifts;
DROP FUNCTION IF EXISTS shifts_cash_up_guard();
DROP FUNCTION IF EXISTS shift_closes_require_open_shift();
DROP FUNCTION IF EXISTS shift_cash_movements_require_open_shift();
DROP FUNCTION IF EXISTS shift_cash_up_append_only();

DROP INDEX IF EXISTS uq_shifts_cash_up_open_device;

ALTER TABLE shifts
  DROP CONSTRAINT IF EXISTS uq_shifts_cash_up_close_target,
  DROP CONSTRAINT IF EXISTS uq_shifts_cash_up_movement_target,
  DROP CONSTRAINT IF EXISTS shifts_payload_hash_len,
  DROP CONSTRAINT IF EXISTS shifts_opening_float_non_negative,
  DROP CONSTRAINT IF EXISTS shifts_currency_code_format,
  DROP CONSTRAINT IF EXISTS shifts_legacy_fields_absent,
  DROP CONSTRAINT IF EXISTS shifts_cash_up_fields_present,
  DROP CONSTRAINT IF EXISTS shifts_source_valid;

ALTER TABLE shifts
  DROP COLUMN IF EXISTS payload_hash,
  DROP COLUMN IF EXISTS recorded_by_user_id,
  DROP COLUMN IF EXISTS received_at,
  DROP COLUMN IF EXISTS business_date,
  DROP COLUMN IF EXISTS opening_float,
  DROP COLUMN IF EXISTS currency_code,
  DROP COLUMN IF EXISTS source;

COMMIT;
