-- 0070_shift_forced_closes.sql
--
-- A manager's force close of a stuck shift, recorded as NOT COUNTED (Jira
-- RT-742; contract `pos-shifts.openapi.yaml` 1.4.0-draft `forceCloseShift`,
-- PR #884). [GATED] migration: owner authorization on RT-742 (comment 13358:
-- the runtime step's migration, PR + CI only; owner decision relayed by the
-- wave-1 coordinator 2026-10-22). Storage shape and number 0070: coordinator
-- decision of 2026-10-22 under the owner's delegation, which supersedes the
-- "shift_closes nullable totals" shape of comments 13237 / 13358 / 13385.
-- Applying it to the lab, a live database or any deploy is NOT authorized by
-- those decisions.
--
-- Why a table of its own, not nullable `shift_closes` totals: the manager's
-- terminal holds neither the drawer's totals nor the POS cash-up, and the
-- server never computes one (Constitution §III), so a force close carries no
-- counted cash, expected cash, variance or other total, is never a counted
-- zero and is not a `ShiftClose` (contract: Not counted). Nullable
-- `shift_closes` columns would leave the 0036 composite FK
-- `fk_shift_closes_shift` (MATCH SIMPLE) unenforced for a legacy shift (NULL
-- currency and float), so the row's tenant, store and device would no longer
-- be pinned, and the 0050 close trigger would derive 'no' approval for a NULL
-- variance. A separate fact leaves every `shift_closes` reader, CHECK and
-- trigger exactly as it is.
--
-- The shift's state is the existing `closed_forced` (0002): a force close
-- moves it open → closed_forced like a counted forced close does; the
-- `shift_forced_closes` row is what says "not counted" (no `shift_closes`
-- row exists for it). No new lifecycle value.
--
-- Changes, in order:
--   1. shifts: UNIQUE (shift_id, tenant_id, store_id, opening_device_id), the
--      composite FK target that pins a force close to its shift's tenant,
--      store and opening terminal, legacy rows included (the 0036 targets
--      carry the currency, which a legacy row lacks). shift_id is the primary
--      key, so no existing row can violate it.
--   2. devices: UNIQUE (id, tenant_id, store_id), the composite FK target that
--      pins the CALLING terminal to the same tenant and store. id is the
--      primary key, so no existing row can violate it.
--   3. shift_forced_closes — one per shift (PK shift_id): the closing manager,
--      the calling terminal, the server clock, the reason (1..200, never
--      logged) and the natural-key payload hash.
--   4. RLS ENABLED and FORCED, SELECT + INSERT policies only; append-only for
--      every role (the 0036 shift_cash_up_append_only()); a force close is
--      inserted only while its shift is open (row trigger, shift row locked
--      FOR UPDATE, 55000).
--   5. shifts_cash_up_guard (the 0050 body): a cash_up row may also move
--      open → closed_forced with its shift_forced_closes row instead of a
--      `forced` shift_closes row. Every other rule is unchanged. A legacy row
--      keeps its 0036 freedom; a force-closed legacy row is pinned by the FK
--      (RESTRICT), and the audit-ingest writer only INSERTs (ON CONFLICT DO
--      NOTHING), so nothing re-opens it.
--
-- Both UNIQUEs are built inside the transaction, not CONCURRENTLY: the FKs of
-- step 3 need them in the same migration, and CREATE INDEX CONCURRENTLY needs
-- a file of its own (the 0064 rule). `shifts` (one row per shift) and
-- `devices` (one row per terminal) are small, and 0036 built two UNIQUEs on
-- `shifts` the same way.
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): FINANCIAL-OPERATIONAL class.
-- Identifiers (tenant, store, terminals, user), the server timestamp and one
-- short free-text field, `forced_reason`, documented "no PII" in the contract
-- and never logged. No PIN, secret, token, customer or contact datum, and no
-- money. Retained with the shift it closes; never deleted (append-only).
--
-- Lock impact: ONE transaction; every lock is held until COMMIT.
--   - shifts: SHARE (UNIQUE build: shift writes wait, reads continue), then
--     SHARE ROW EXCLUSIVE (the new FK), then the guard function is replaced.
--     Every shift open, movement and close waits until COMMIT.
--   - devices: SHARE (UNIQUE build) and SHARE ROW EXCLUSIVE (the new FKs):
--     device writes (last-seen touch, revoke, rotation) wait until COMMIT;
--     device authentication reads continue.
--   - tenants, stores, users: SHARE ROW EXCLUSIVE for the new FKs; writes on
--     them wait until COMMIT, reads continue.
-- At pilot volume the migration is expected to take well under a second; run
-- it with no POS sync in flight.
-- Grants: none here. The domain role's SELECT + INSERT on shift_forced_closes
-- is granted by docs/operations/sql/shift-forced-closes-domain-grants.sql,
-- run after this migration and before the API starts (deploy/README.md step
-- 2); DOMAIN_REQUIRED_GRANTS refuses to boot without it.
-- Reversible via 0070_shift_forced_closes.down.sql (refused while any force
-- close is recorded).

BEGIN;

-- =============================================================================
-- 1-2. The composite FK targets
-- =============================================================================

ALTER TABLE shifts
  ADD CONSTRAINT uq_shifts_force_close_target
    UNIQUE (shift_id, tenant_id, store_id, opening_device_id);

ALTER TABLE devices
  ADD CONSTRAINT uq_devices_tenant_store_target
    UNIQUE (id, tenant_id, store_id);

-- =============================================================================
-- 3. shift_forced_closes — the not-counted force close
-- =============================================================================

CREATE TABLE shift_forced_closes (
  shift_id               UUID         PRIMARY KEY,
  tenant_id              UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id               UUID         NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  -- The terminal that opened the shift (the shift's opening_device_id).
  opening_device_id      UUID         NOT NULL,
  -- The terminal the force-close request came from (the envelope's device).
  closed_from_device_id  UUID         NOT NULL,
  -- The closing manager (the envelope operator).
  closed_by_user_id      UUID         NOT NULL REFERENCES users(id)   ON DELETE RESTRICT,
  -- Server clock.
  closed_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  forced_reason          TEXT         NOT NULL,
  -- sha256 of the natural key (the shift and the reason).
  payload_hash           BYTEA        NOT NULL,
  -- The shift of the same tenant, store and opening terminal.
  CONSTRAINT fk_shift_forced_closes_shift
    FOREIGN KEY (shift_id, tenant_id, store_id, opening_device_id)
    REFERENCES shifts (shift_id, tenant_id, store_id, opening_device_id)
    ON DELETE RESTRICT,
  -- The calling terminal of the same tenant and store.
  CONSTRAINT fk_shift_forced_closes_closed_from_device
    FOREIGN KEY (closed_from_device_id, tenant_id, store_id)
    REFERENCES devices (id, tenant_id, store_id)
    ON DELETE RESTRICT,
  CONSTRAINT shift_forced_closes_reason_length
    CHECK (char_length(forced_reason) BETWEEN 1 AND 200),
  CONSTRAINT shift_forced_closes_payload_hash_len
    CHECK (octet_length(payload_hash) = 32)
);

CREATE INDEX idx_shift_forced_closes_tenant_store ON shift_forced_closes (tenant_id, store_id);

-- =============================================================================
-- 4. RLS (FORCED, SELECT + INSERT only), append-only, close only while open
-- =============================================================================

ALTER TABLE shift_forced_closes ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_forced_closes FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_forced_closes_tenant_select ON shift_forced_closes
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY shift_forced_closes_tenant_insert ON shift_forced_closes
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE TRIGGER shift_forced_closes_append_only_row
  BEFORE UPDATE OR DELETE ON shift_forced_closes
  FOR EACH ROW EXECUTE FUNCTION shift_cash_up_append_only();
CREATE TRIGGER shift_forced_closes_append_only_truncate
  BEFORE TRUNCATE ON shift_forced_closes
  FOR EACH STATEMENT EXECUTE FUNCTION shift_cash_up_append_only();

-- A force close is recorded only while its shift is open (the service checks
-- first under the shift row lock; this is the database backstop). The shift
-- row is locked FOR UPDATE (the force close then updates it), so a close, a
-- movement or a second force close waits and re-checks. 55000. A shift of
-- another tenant, store or terminal is left to the composite FK and the RLS
-- WITH CHECK, which run after BEFORE triggers.
CREATE FUNCTION shift_forced_closes_require_open_shift() RETURNS trigger
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
    RAISE EXCEPTION 'shift % is not open: it cannot be force-closed', NEW.shift_id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shift_forced_closes_require_open_shift
  BEFORE INSERT ON shift_forced_closes
  FOR EACH ROW EXECUTE FUNCTION shift_forced_closes_require_open_shift();

-- =============================================================================
-- 5. shifts_cash_up_guard — open → closed_forced with a force close too
-- =============================================================================

-- The 0050 body; the only change is the close transition's evidence: a
-- `closed_forced` move may be backed by a shift_forced_closes row (RT-742)
-- instead of a `forced` shift_closes row.
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
     AND (EXISTS (
           SELECT 1 FROM public.shift_closes c
            WHERE c.shift_id = NEW.shift_id
              AND c.tenant_id = NEW.tenant_id
              AND c.close_kind = CASE NEW.lifecycle_state
                                   WHEN 'closed' THEN 'normal'
                                   ELSE 'forced' END)
          OR (NEW.lifecycle_state = 'closed_forced'
              AND EXISTS (
                SELECT 1 FROM public.shift_forced_closes f
                 WHERE f.shift_id = NEW.shift_id
                   AND f.tenant_id = NEW.tenant_id))) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'a cash-up shift only moves open → closed once, with its close recorded'
    USING ERRCODE = 'insufficient_privilege';
END
$$;

COMMIT;
