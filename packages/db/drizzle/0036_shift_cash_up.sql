-- 0036_shift_cash_up.sql
--
-- Thin, cash-only shift cash-up persistence (Jira RT-17 slice 2).
-- [GATED] migration — owner-authorized on RT-17: comment 10760 ("the SQL
-- migration needed for shift cash-up"), design record comment 10919 (this
-- migration, `0036_shift_cash_up`), owner confirmation comment 10920.
-- Contract: packages/contracts/openapi/pos-shifts.openapi.yaml 1.1.0-draft
-- (openShift, recordCashMovement, closeShift).
--
-- Model (10919). A cash-up shift is one drawer session on one terminal, at
-- most ONE open per device. The POS owns the offline lifecycle and the
-- cash-up arithmetic; Backend-Core records immutable facts and never rewrites
-- a POS total (Constitution §III). Every fact carries a client UUID (the
-- natural key) and a SHA-256 payload hash for replay / conflict detection.
--
-- Changes, in order:
--   1. shifts (0002) gains the cash-up columns: `source` ('legacy' for every
--      existing row and for the audit-ingest `shift.open` writer, 'cash_up'
--      for openShift), the shift currency, the opening float, the store-local
--      business date, the server receipt time, the recording actor and the
--      payload hash. A cash_up row must carry all of them; a legacy row none.
--      - uq_shifts_cash_up_open_device: at most one OPEN cash_up shift per
--        (tenant, device). Legacy rows never count: nothing closes them.
--      - Two UNIQUE targets for the child composite FKs, so a movement or a
--        close can only name a cash_up shift of the SAME tenant, store,
--        device and currency, and a close only with the float recorded at
--        open. Legacy rows (NULL currency) can never be referenced.
--      - shifts_cash_up_guard (row trigger):
--          * a cash_up row is INSERTed only as `open`;
--          * a cash_up row changes once, open → closed / closed_forced, with
--            every other column unchanged, and only when its matching
--            shift_closes row exists;
--          * ADOPTION (RT-17 review P2-1, option b): an OPEN legacy row may
--            become an open cash_up row once, setting only the cash-up
--            columns (all of them); its id, tenant, store, device, opened_at
--            and opening user stay unchanged. This lets openShift adopt the
--            row the audit-ingest `shift.open` writer already wrote for the
--            same shift. cash_up → legacy is refused;
--          * a cash_up row is never deleted; TRUNCATE is refused;
--          * legacy rows otherwise keep their pre-0036 behaviour (row UPDATE
--            / DELETE).
--   2. shift_closes — the ShiftClosed fact, one per shift (PK shift_id).
--      Arithmetic CHECKs in exact numeric:
--        expected_cash = opening_float + cash_sales_total − cash_refunds_total
--                        + pay_in_total − pay_out_total
--        variance      = counted_cash − expected_cash
--      forced_reason is present if and only if close_kind = 'forced'. A
--      close is inserted only while its shift is open (row trigger, which
--      locks the shift row FOR UPDATE).
--   3. shift_cash_movements — the CashMovement facts (pay_in / pay_out). A
--      movement can only be inserted while its shift is open (row trigger,
--      which locks the shift row FOR SHARE, so a movement racing a close
--      waits for it and re-checks).
--   4. shift_refund_claims — the close's cashRefundReturnRefs, one row per
--      return. return_id is the PK: a return is claimed by at most one
--      shift's close. Composite FKs keep the return and the close in the
--      claim's tenant and store.
--   5. idx_sales_tenant_device_occurred — sales (tenant_id, device_id,
--      occurred_at) for the RT-18 read-side recompute (10919).
--
-- Every cash amount column refuses 'NaN' (numeric NaN compares equal to
-- itself and greater than every number, so it would pass the >= 0 and
-- arithmetic CHECKs). Infinity cannot be stored in numeric(19,4).
-- Every trigger function pins `search_path = pg_catalog, public` and
-- schema-qualifies its table references.
--
-- The three new tables are append-only for every role, the owner included:
-- UPDATE, DELETE and TRUNCATE raise 42501 (the 0034 audit_events precedent).
-- They are RLS-enabled and FORCED with SELECT and INSERT policies only.
-- device_id stays a single-column FK to devices(id) (the 0033 / 0035
-- precedent: a composite one would need a new UNIQUE on devices); the
-- service always takes tenant, store and device from one devices row.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV)
-- ---------------------------------------------------------------------------
-- FINANCIAL-OPERATIONAL class: identifiers (tenant, store, device, users,
-- returns), POS-clock and server timestamps, exact-decimal cash amounts and
-- two short free-text fields — the movement `note` and the close's
-- `forced_reason` — documented "no PII" in the contract and never logged.
-- No PIN, secret, token, customer or contact datum is stored. Retained with
-- the sales they reconcile; never deleted (append-only).
--
-- Lock impact: the whole migration is ONE transaction, and every lock below
-- is held until its COMMIT, i.e. including the non-concurrent sales index
-- build at the end (CREATE INDEX CONCURRENTLY cannot run in a transaction).
--   - shifts: ACCESS EXCLUSIVE (ALTER TABLE: columns with a constant default
--     are metadata-only; the CHECKs scan the table once; three index builds;
--     the triggers). Every read and write of shifts waits until COMMIT.
--   - users, devices, stores, tenants, sale_returns: SHARE ROW EXCLUSIVE,
--     taken by the new FKs (shifts.recorded_by_user_id and the three new
--     tables). INSERT / UPDATE / DELETE on those tables wait until COMMIT —
--     including writes on devices during device authentication and new
--     sale returns; plain reads continue.
--   - sales: SHARE for the idx_sales_tenant_device_occurred build: sale
--     capture waits until COMMIT; reads continue.
-- Duration is dominated by the sales index build (one pass over sales).
-- Run it in a maintenance window (no POS sync in flight); at pilot volume
-- the whole migration is expected to take well under a second.
-- Grants: none here — runtime grants are provisioned outside migrations
-- (docs/operations/database-roles.md); the domain-role grant step for these
-- tables ships with the runtime routes (RT-17 slice 2b).
-- Reversible via 0036_shift_cash_up.down.sql.

BEGIN;

-- =============================================================================
-- 1. shifts — cash-up columns, invariants and the guard trigger
-- =============================================================================

ALTER TABLE shifts
  ADD COLUMN source              TEXT          NOT NULL DEFAULT 'legacy',
  ADD COLUMN currency_code       CHAR(3),
  ADD COLUMN opening_float       NUMERIC(19,4),
  -- The open's store-local day (store timezone at insert, RT-63 P2).
  ADD COLUMN business_date       DATE,
  -- Server clock; openShift's receivedAt.
  ADD COLUMN received_at         TIMESTAMPTZ,
  -- The verified actor that recorded the open: the device-path cashier or
  -- the envelope operator (repair path). opening_cashier_user_id is the
  -- opening user as stated.
  ADD COLUMN recorded_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  -- sha256 of the canonical open fact.
  ADD COLUMN payload_hash        BYTEA;

ALTER TABLE shifts
  ADD CONSTRAINT shifts_source_valid CHECK (source IN ('legacy', 'cash_up')),
  ADD CONSTRAINT shifts_cash_up_fields_present CHECK (
    source = 'legacy' OR (
      currency_code IS NOT NULL AND opening_float IS NOT NULL
      AND business_date IS NOT NULL AND received_at IS NOT NULL
      AND recorded_by_user_id IS NOT NULL AND payload_hash IS NOT NULL)),
  ADD CONSTRAINT shifts_legacy_fields_absent CHECK (
    source = 'cash_up' OR (
      currency_code IS NULL AND opening_float IS NULL
      AND business_date IS NULL AND received_at IS NULL
      AND recorded_by_user_id IS NULL AND payload_hash IS NULL)),
  ADD CONSTRAINT shifts_currency_code_format
    CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT shifts_opening_float_non_negative
    CHECK (opening_float IS NULL OR opening_float >= 0),
  ADD CONSTRAINT shifts_opening_float_not_nan
    CHECK (opening_float IS NULL OR opening_float <> 'NaN'::numeric),
  ADD CONSTRAINT shifts_payload_hash_len
    CHECK (payload_hash IS NULL OR octet_length(payload_hash) = 32),
  -- Composite FK targets (shift_id is the PK, so both are trivially unique).
  ADD CONSTRAINT uq_shifts_cash_up_movement_target
    UNIQUE (shift_id, tenant_id, store_id, opening_device_id, currency_code),
  ADD CONSTRAINT uq_shifts_cash_up_close_target
    UNIQUE (shift_id, tenant_id, store_id, opening_device_id, currency_code, opening_float);

-- One open drawer session per terminal (10919).
CREATE UNIQUE INDEX uq_shifts_cash_up_open_device
  ON shifts (tenant_id, opening_device_id)
  WHERE source = 'cash_up' AND lifecycle_state = 'open';

-- =============================================================================
-- 2. shift_closes — the ShiftClosed fact
-- =============================================================================

CREATE TABLE shift_closes (
  shift_id                      UUID          PRIMARY KEY,
  tenant_id                     UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id                      UUID          NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  device_id                     UUID          NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  currency_code                 CHAR(3)       NOT NULL,
  closed_at                     TIMESTAMPTZ   NOT NULL,
  closing_user_id               UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  close_kind                    TEXT          NOT NULL,
  forced_reason                 TEXT,
  opening_float                 NUMERIC(19,4) NOT NULL,
  cash_sales_total              NUMERIC(19,4) NOT NULL,
  cash_refunds_total            NUMERIC(19,4) NOT NULL,
  pay_in_total                  NUMERIC(19,4) NOT NULL,
  pay_out_total                 NUMERIC(19,4) NOT NULL,
  expected_cash                 NUMERIC(19,4) NOT NULL,
  counted_cash                  NUMERIC(19,4) NOT NULL,
  variance                      NUMERIC(19,4) NOT NULL,
  sale_count                    INTEGER       NOT NULL,
  variance_approved_by_user_id  UUID          REFERENCES users(id) ON DELETE RESTRICT,
  recorded_by_user_id           UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  received_at                   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  payload_hash                  BYTEA         NOT NULL,
  -- Same tenant, store, device and currency as the shift, and the float
  -- recorded at open.
  CONSTRAINT fk_shift_closes_shift
    FOREIGN KEY (shift_id, tenant_id, store_id, device_id, currency_code, opening_float)
    REFERENCES shifts (shift_id, tenant_id, store_id, opening_device_id, currency_code, opening_float)
    ON DELETE RESTRICT,
  -- Target of the claims' composite FK.
  CONSTRAINT uq_shift_closes_shift_tenant_store UNIQUE (shift_id, tenant_id, store_id),
  CONSTRAINT shift_closes_close_kind_valid CHECK (close_kind IN ('normal', 'forced')),
  CONSTRAINT shift_closes_forced_reason_iff_forced
    CHECK ((close_kind = 'forced') = (forced_reason IS NOT NULL)),
  CONSTRAINT shift_closes_forced_reason_length
    CHECK (forced_reason IS NULL OR char_length(forced_reason) BETWEEN 1 AND 200),
  CONSTRAINT shift_closes_currency_code_format CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT shift_closes_amounts_non_negative CHECK (
    opening_float >= 0 AND cash_sales_total >= 0 AND cash_refunds_total >= 0
    AND pay_in_total >= 0 AND pay_out_total >= 0 AND expected_cash >= 0
    AND counted_cash >= 0),
  CONSTRAINT shift_closes_amounts_not_nan CHECK (
    opening_float <> 'NaN'::numeric AND cash_sales_total <> 'NaN'::numeric
    AND cash_refunds_total <> 'NaN'::numeric AND pay_in_total <> 'NaN'::numeric
    AND pay_out_total <> 'NaN'::numeric AND expected_cash <> 'NaN'::numeric
    AND counted_cash <> 'NaN'::numeric AND variance <> 'NaN'::numeric),
  CONSTRAINT shift_closes_sale_count_non_negative CHECK (sale_count >= 0),
  CONSTRAINT shift_closes_expected_cash_arithmetic CHECK (
    expected_cash = opening_float + cash_sales_total - cash_refunds_total
                    + pay_in_total - pay_out_total),
  CONSTRAINT shift_closes_variance_arithmetic CHECK (variance = counted_cash - expected_cash),
  CONSTRAINT shift_closes_payload_hash_len CHECK (octet_length(payload_hash) = 32)
);

CREATE INDEX idx_shift_closes_tenant_store ON shift_closes (tenant_id, store_id);

-- =============================================================================
-- 3. shift_cash_movements — the CashMovement facts
-- =============================================================================

CREATE TABLE shift_cash_movements (
  -- movementId, client-generated.
  id                   UUID          PRIMARY KEY,
  shift_id             UUID          NOT NULL,
  tenant_id            UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id             UUID          NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  device_id            UUID          NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  -- The shift's currency (the body carries none).
  currency_code        CHAR(3)       NOT NULL,
  kind                 TEXT          NOT NULL,
  amount               NUMERIC(19,4) NOT NULL,
  reason_code          TEXT          NOT NULL,
  note                 TEXT,
  -- POS clock.
  occurred_at          TIMESTAMPTZ   NOT NULL,
  recorded_by_user_id  UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  received_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  payload_hash         BYTEA         NOT NULL,
  CONSTRAINT fk_shift_cash_movements_shift
    FOREIGN KEY (shift_id, tenant_id, store_id, device_id, currency_code)
    REFERENCES shifts (shift_id, tenant_id, store_id, opening_device_id, currency_code)
    ON DELETE RESTRICT,
  CONSTRAINT shift_cash_movements_kind_valid CHECK (kind IN ('pay_in', 'pay_out')),
  CONSTRAINT shift_cash_movements_amount_positive CHECK (amount > 0),
  CONSTRAINT shift_cash_movements_amount_not_nan CHECK (amount <> 'NaN'::numeric),
  CONSTRAINT shift_cash_movements_reason_code_valid
    CHECK (reason_code IN ('bank_drop', 'float_top_up', 'petty_expense', 'other')),
  CONSTRAINT shift_cash_movements_note_length
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 200),
  CONSTRAINT shift_cash_movements_currency_code_format CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT shift_cash_movements_payload_hash_len CHECK (octet_length(payload_hash) = 32)
);

CREATE INDEX idx_shift_cash_movements_shift
  ON shift_cash_movements (tenant_id, shift_id, occurred_at);

-- =============================================================================
-- 4. shift_refund_claims — cashRefundReturnRefs of a close
-- =============================================================================

CREATE TABLE shift_refund_claims (
  -- A return is claimed by at most one shift's close (10919).
  return_id  UUID     PRIMARY KEY,
  shift_id   UUID     NOT NULL,
  tenant_id  UUID     NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id   UUID     NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  -- Request order, so a replay echoes the refs in the order received.
  ordinal    INTEGER  NOT NULL,
  CONSTRAINT fk_shift_refund_claims_close
    FOREIGN KEY (shift_id, tenant_id, store_id)
    REFERENCES shift_closes (shift_id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT fk_shift_refund_claims_return
    FOREIGN KEY (return_id, tenant_id, store_id)
    REFERENCES sale_returns (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT shift_refund_claims_ordinal_non_negative CHECK (ordinal >= 0),
  CONSTRAINT uq_shift_refund_claims_shift_ordinal UNIQUE (shift_id, ordinal)
);

-- =============================================================================
-- RLS — FORCED, SELECT + INSERT only (append-only facts)
-- =============================================================================

ALTER TABLE shift_closes ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_closes FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_closes_tenant_select ON shift_closes
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY shift_closes_tenant_insert ON shift_closes
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

ALTER TABLE shift_cash_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_cash_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_cash_movements_tenant_select ON shift_cash_movements
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY shift_cash_movements_tenant_insert ON shift_cash_movements
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

ALTER TABLE shift_refund_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_refund_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_refund_claims_tenant_select ON shift_refund_claims
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY shift_refund_claims_tenant_insert ON shift_refund_claims
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- =============================================================================
-- Triggers
-- =============================================================================

-- Append-only for every role (the 0034 precedent): any UPDATE, DELETE or
-- TRUNCATE of a cash-up fact raises 42501. Break-glass is a deliberate DDL step.
CREATE FUNCTION shift_cash_up_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Shift cash-up facts can only be inserted (RT-17).';
END
$$;

CREATE TRIGGER shift_closes_append_only_row
  BEFORE UPDATE OR DELETE ON shift_closes
  FOR EACH ROW EXECUTE FUNCTION shift_cash_up_append_only();
CREATE TRIGGER shift_closes_append_only_truncate
  BEFORE TRUNCATE ON shift_closes
  FOR EACH STATEMENT EXECUTE FUNCTION shift_cash_up_append_only();

CREATE TRIGGER shift_cash_movements_append_only_row
  BEFORE UPDATE OR DELETE ON shift_cash_movements
  FOR EACH ROW EXECUTE FUNCTION shift_cash_up_append_only();
CREATE TRIGGER shift_cash_movements_append_only_truncate
  BEFORE TRUNCATE ON shift_cash_movements
  FOR EACH STATEMENT EXECUTE FUNCTION shift_cash_up_append_only();

CREATE TRIGGER shift_refund_claims_append_only_row
  BEFORE UPDATE OR DELETE ON shift_refund_claims
  FOR EACH ROW EXECUTE FUNCTION shift_cash_up_append_only();
CREATE TRIGGER shift_refund_claims_append_only_truncate
  BEFORE TRUNCATE ON shift_refund_claims
  FOR EACH STATEMENT EXECUTE FUNCTION shift_cash_up_append_only();

-- A movement is recorded only while its shift is open (the service checks
-- first under the shift row lock; this is the database backstop). 55000.
-- The shift row is locked FOR SHARE: a movement racing a close waits for the
-- close's row lock and then re-checks the committed state. Only a matching
-- shift that is no longer open is refused here: a shift of another tenant,
-- store, device or currency is left to the composite FK and the RLS WITH
-- CHECK, which run after BEFORE triggers.
CREATE FUNCTION shift_cash_movements_require_open_shift() RETURNS trigger
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
     FOR SHARE;
  IF FOUND AND v_state <> 'open' THEN
    RAISE EXCEPTION 'shift % is not open: a cash movement cannot be recorded', NEW.shift_id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shift_cash_movements_require_open_shift
  BEFORE INSERT ON shift_cash_movements
  FOR EACH ROW EXECUTE FUNCTION shift_cash_movements_require_open_shift();

-- A close is recorded only while its shift is open. The shift row is locked
-- FOR UPDATE (the close then updates it), so a second close or a movement
-- waits and re-checks. 55000. As above, a foreign shift is left to the FK /
-- RLS.
CREATE FUNCTION shift_closes_require_open_shift() RETURNS trigger
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

CREATE TRIGGER shift_closes_require_open_shift
  BEFORE INSERT ON shift_closes
  FOR EACH ROW EXECUTE FUNCTION shift_closes_require_open_shift();

-- shifts guard (see the header). The cash-up columns, as one list, for the
-- adoption shape check.
CREATE FUNCTION shifts_cash_up_guard() RETURNS trigger
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

CREATE TRIGGER shifts_cash_up_guard_row
  BEFORE INSERT OR UPDATE OR DELETE ON shifts
  FOR EACH ROW EXECUTE FUNCTION shifts_cash_up_guard();
CREATE TRIGGER shifts_cash_up_guard_truncate
  BEFORE TRUNCATE ON shifts
  FOR EACH STATEMENT EXECUTE FUNCTION shifts_cash_up_guard();

-- =============================================================================
-- 5. sales — the RT-18 read-side recompute index (10919)
-- =============================================================================

CREATE INDEX idx_sales_tenant_device_occurred
  ON sales (tenant_id, device_id, occurred_at);

COMMIT;
