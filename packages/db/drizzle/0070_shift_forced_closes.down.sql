-- 0070_shift_forced_closes.down.sql
--
-- Rollback for 0070_shift_forced_closes.sql (RT-742). Drops the force-close
-- table, its trigger function and the two composite FK targets, and restores
-- the 0050 shifts_cash_up_guard.
--
-- A force close is evidence: its shift would remain `closed_forced` with no
-- close of any kind, and the closing manager, the calling terminal and the
-- reason would be LOST. So the rollback REFUSES while any force close is
-- recorded: back up, decide, and delete them explicitly first (the table is
-- append-only, so that is a deliberate break-glass step). The table is FORCE
-- ROW LEVEL SECURITY and the production migration owner is not a superuser
-- (docs/operations/database-roles.md), so the guard reads under each tenant's
-- app.current_tenant (the 0051 / 0054 pattern); a bare SELECT would see no
-- rows and drop them. Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0070-shift-forced-closes.spec.ts.

BEGIN;

DO $$
DECLARE
  t uuid;
  rows_found bigint := 0;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    rows_found := rows_found + (SELECT count(*) FROM shift_forced_closes WHERE tenant_id = t);
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0070 down refused: % force close(s) recorded; back up and delete them explicitly first', rows_found;
  END IF;
END
$$;

-- The 0050 guard, verbatim.
CREATE OR REPLACE FUNCTION shifts_cash_up_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  cash_up_columns CONSTANT text[] := ARRAY['source', 'currency_code', 'opening_float',
    'business_date', 'received_at', 'recorded_by_user_id', 'payload_hash', 'updated_at',
    'frozen_policy_source', 'frozen_policy_revision_id', 'frozen_policy_mode',
    'frozen_policy_limit_amount', 'frozen_policy_currency_code', 'frozen_policy_flags'];
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

DROP TABLE IF EXISTS shift_forced_closes;
DROP FUNCTION IF EXISTS shift_forced_closes_require_open_shift();
ALTER TABLE devices DROP CONSTRAINT IF EXISTS uq_devices_tenant_store_target;
ALTER TABLE shifts DROP CONSTRAINT IF EXISTS uq_shifts_force_close_target;

COMMIT;
