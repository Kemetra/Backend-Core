-- 0050_shift_variance_policy.down.sql
--
-- Rollback for 0050_shift_variance_policy.sql (RT-385). Drops, in order: the
-- approver verdict table, the shift_closes tri-states (their CHECKs and the
-- verdict FK target first), the policy revisions table (its triggers and
-- policies go with it) and the shifts frozen-policy columns, and restores the
-- 0036 bodies of shift_closes_require_open_shift and shifts_cash_up_guard
-- (copied verbatim from 0036_shift_cash_up.sql).
--
-- DATA LOSS once RT-387 has written data: every policy revision, every frozen
-- policy and its flags, every derived close value and every approver verdict
-- is LOST. Shift and close rows themselves are kept. Roll back RT-387 first,
-- and take a backup if the policy history matters.
--
-- Locks: as in the up migration (the 0047 precedent), lock_timeout = 2s per
-- lock request and every lock taken up front in the runtime's order (the FK
-- parents, then shifts before shift_closes, as the close path does), so the
-- drops below never acquire shift_closes before shifts and cannot deadlock
-- with an in-flight close. On a timeout the down rolls back with nothing
-- changed; retry when the blocking transaction has ended.

BEGIN;

SET LOCAL lock_timeout = '2s';

LOCK TABLE tenants, stores, users IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE shifts, shift_closes IN ACCESS EXCLUSIVE MODE;

DROP TABLE IF EXISTS shift_close_approver_checks;
DROP FUNCTION IF EXISTS shift_close_approver_checks_append_only();

CREATE OR REPLACE FUNCTION shift_closes_require_open_shift() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state text;
BEGIN
  SELECT s.lifecycle_state INTO v_state
    FROM public.shifts s
   WHERE s.shift_id = NEW.shift_id
     AND s.tenant_id = NEW.tenant_id
     FOR UPDATE;
  IF FOUND AND v_state <> 'open' THEN
    RAISE EXCEPTION 'shift % is not open: it cannot be closed again', NEW.shift_id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE shift_closes
  DROP CONSTRAINT IF EXISTS uq_shift_closes_approver_target,
  DROP CONSTRAINT IF EXISTS shift_closes_approval_missing_derived,
  DROP CONSTRAINT IF EXISTS shift_closes_approval_missing_valid,
  DROP CONSTRAINT IF EXISTS shift_closes_approval_required_valid;

ALTER TABLE shift_closes
  DROP COLUMN IF EXISTS approval_missing,
  DROP COLUMN IF EXISTS approval_required_by_policy;

DROP TABLE IF EXISTS cash_variance_policy_revisions;
DROP FUNCTION IF EXISTS cash_variance_policy_revisions_chain_guard();
DROP FUNCTION IF EXISTS cash_variance_policy_revisions_append_only();

CREATE OR REPLACE FUNCTION shifts_cash_up_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  cash_up_columns CONSTANT text[] := ARRAY['source', 'currency_code', 'opening_float',
    'business_date', 'received_at', 'recorded_by_user_id', 'payload_hash', 'updated_at'];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'shifts holds cash-up facts: TRUNCATE is not permitted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.source = 'cash_up' AND NEW.lifecycle_state <> 'open' THEN
      RAISE EXCEPTION 'a cash-up shift is recorded open; it closes with its close'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.source = 'cash_up' THEN
      RAISE EXCEPTION 'a cash-up shift is never deleted'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE of a legacy row.
  IF OLD.source = 'legacy' THEN
    IF NEW.source = 'legacy' THEN
      RETURN NEW;
    END IF;
    -- Adoption: open legacy → open cash_up, every cash-up column set, and
    -- nothing else changed (id, tenant, store, device, opened_at, opening
    -- user, lifecycle, created_at).
    IF OLD.lifecycle_state = 'open'
       AND NEW.lifecycle_state = 'open'
       AND NEW.currency_code IS NOT NULL AND NEW.opening_float IS NOT NULL
       AND NEW.business_date IS NOT NULL AND NEW.received_at IS NOT NULL
       AND NEW.recorded_by_user_id IS NOT NULL AND NEW.payload_hash IS NOT NULL
       AND (to_jsonb(NEW) - cash_up_columns) = (to_jsonb(OLD) - cash_up_columns) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a legacy shift is adopted only while open, setting the cash-up columns only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- UPDATE of a cash_up row.
  IF NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'a cash-up shift never becomes legacy'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.lifecycle_state = 'open'
     AND NEW.lifecycle_state IN ('closed', 'closed_forced')
     AND (to_jsonb(NEW) - 'lifecycle_state' - 'updated_at')
         = (to_jsonb(OLD) - 'lifecycle_state' - 'updated_at')
     AND EXISTS (
       SELECT 1 FROM public.shift_closes c
        WHERE c.shift_id = NEW.shift_id
          AND c.tenant_id = NEW.tenant_id
          AND c.close_kind = CASE NEW.lifecycle_state
                               WHEN 'closed' THEN 'normal'
                               ELSE 'forced' END) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'a cash-up shift only moves open → closed once, with its close recorded'
    USING ERRCODE = 'insufficient_privilege';
END
$$;

ALTER TABLE shifts
  DROP CONSTRAINT IF EXISTS shifts_frozen_policy_flags_valid,
  DROP CONSTRAINT IF EXISTS shifts_frozen_policy_currency_code_format,
  DROP CONSTRAINT IF EXISTS shifts_frozen_policy_limit_not_nan,
  DROP CONSTRAINT IF EXISTS shifts_frozen_policy_limit_non_negative,
  DROP CONSTRAINT IF EXISTS shifts_frozen_policy_value_shape,
  DROP CONSTRAINT IF EXISTS shifts_frozen_policy_revision_iff_source,
  DROP CONSTRAINT IF EXISTS shifts_frozen_policy_source_valid,
  DROP CONSTRAINT IF EXISTS shifts_frozen_policy_cash_up_only,
  DROP CONSTRAINT IF EXISTS shifts_frozen_policy_all_or_none;

ALTER TABLE shifts
  DROP COLUMN IF EXISTS frozen_policy_flags,
  DROP COLUMN IF EXISTS frozen_policy_currency_code,
  DROP COLUMN IF EXISTS frozen_policy_limit_amount,
  DROP COLUMN IF EXISTS frozen_policy_mode,
  DROP COLUMN IF EXISTS frozen_policy_revision_id,
  DROP COLUMN IF EXISTS frozen_policy_source;

COMMIT;
