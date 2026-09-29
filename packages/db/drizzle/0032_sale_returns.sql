-- 0032_sale_returns.sql
--
-- Line-aware returns (Jira RT-73) + the reversal business date (RT-63).
-- [GATED] migration — owner-authorized on RT-73 (comment 10406).
--
-- Source-of-truth decisions:
--   - RT-14 decision 10343 (D1 line-aware return, D2 void/return exclusivity
--     and at most one void per sale, D3 refund tender recorded as a fact)
--   - RT-63 decision 10348 (P2: the reversal's own business date, persisted
--     at insert, never recomputed)
--   - RT-73 comment 10406 (option (a): cumulative-difference pricing)
--   - packages/contracts/openapi/pos-sales/sales.yaml (recordReturn)
--
-- Changes, in order:
--   1. GUARD: refuse to run when any sale already has more than one void
--      (RT-14 F2 made that possible). Voids are append-only facts; this
--      migration never deletes one. The operator resolves the duplicates
--      (a finance decision) and re-runs.
--   2. sale_voids.business_date DATE NOT NULL — backfilled from voided_at in
--      each store's CURRENT timezone (RT-63 P2), then NOT NULL. New voids
--      compute it at insert (SalesService.recordVoid). A BEFORE INSERT
--      trigger fills it for any writer that omits it — the pre-RT-73 API
--      replicas still running during a rolling deploy (expand/contract) —
--      so migrating first never turns an old void into a 23502 / 500.
--   3. uq_sale_voids_one_per_sale — at most one void per sale (D2).
--   4. sale_returns / sale_return_lines / sale_return_tenders — append-only,
--      tenant-RLS-forced, SELECT + INSERT policies only.
--
-- Existing-table DDL is limited to the authorized sale_voids column + index,
-- plus the business_date fill trigger that keeps old writers compatible.
--
-- ---------------------------------------------------------------------------
-- RLS AND THE BACKFILL
-- ---------------------------------------------------------------------------
-- sale_voids is FORCE ROW LEVEL SECURITY and has no UPDATE policy, so an
-- owner that is not a superuser would update ZERO rows — silently. The
-- migration therefore lifts FORCE on sale_voids (the ADD COLUMN already holds
-- its ACCESS EXCLUSIVE lock) and restores it before COMMIT. stores is read
-- under its own policy via `SET LOCAL app.is_platform_admin = 'true'`
-- (stores_tenant_isolation honours it), so stores is NOT altered or locked
-- beyond a read. `SET NOT NULL` is the tripwire: if the backfill skipped a
-- row for any reason, the migration fails instead of committing NULLs.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV) — re-reviewed for RT-73
-- ---------------------------------------------------------------------------
-- sale_returns and sale_return_lines are BUSINESS-CLASS (quantities, amounts,
-- provenance, timestamps; the acting POS principal in created_by). `reason`
-- is operator free text for the return and must not carry customer PII.
-- sale_return_tenders records the refund payout METHOD ('cash' only) and
-- AMOUNT as a fact (RT-14 D3). It is the first tender-shaped table: it holds
-- no card, account or instrument data and no customer reference, so it is
-- classified BUSINESS-CLASS with a payment-method attribute. Any later
-- non-cash method (RT-10) re-triggers SI-012. Retention inherits the 001
-- long-horizon insert-only posture; erasure tombstones, never deletes.
--
-- Lock duration: sale_voids takes ACCESS EXCLUSIVE for the ADD COLUMN,
-- backfill, SET NOT NULL and unique-index build (proportional to its row
-- count; small before the pilot). The new tables take only catalog locks.
-- Grants: none here — production grants the domain role SELECT + INSERT on
-- the three new tables outside migrations (see 0006 / the RT-73 PR).
-- Reversible via 0032_sale_returns.down.sql.

BEGIN;

-- =============================================================================
-- 1–3. sale_voids: duplicate guard, business_date backfill, one void per sale
-- =============================================================================

ALTER TABLE sale_voids NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  duplicated integer;
BEGIN
  SELECT count(*) INTO duplicated
    FROM (SELECT sale_id FROM sale_voids GROUP BY sale_id HAVING count(*) > 1) d;
  IF duplicated > 0 THEN
    RAISE EXCEPTION
      '0032_sale_returns: % sale(s) have more than one void; at most one void per sale is required (RT-14 D2)',
      duplicated
      USING HINT = 'List them with: SELECT sale_id, count(*) FROM sale_voids GROUP BY sale_id HAVING count(*) > 1. Resolve each case with finance, then re-run. The migration never deletes a void.';
  END IF;
END
$$;

ALTER TABLE sale_voids ADD COLUMN business_date DATE;

SET LOCAL app.is_platform_admin = 'true';
UPDATE sale_voids v
   SET business_date = (v.voided_at AT TIME ZONE s.timezone)::date
  FROM stores s
 WHERE s.id = v.store_id;
SET LOCAL app.is_platform_admin = 'false';

ALTER TABLE sale_voids ALTER COLUMN business_date SET NOT NULL;

CREATE UNIQUE INDEX uq_sale_voids_one_per_sale ON sale_voids (sale_id);

-- Rollout compatibility + backstop: derive business_date when a writer omits
-- it. Column defaults (voided_at = now()) are applied before BEFORE ROW
-- triggers, so NEW.voided_at is the server stamp. SECURITY INVOKER: the
-- store is read under the writer's own tenant GUC; if it is not visible the
-- column stays NULL and the NOT NULL constraint fails loudly.
CREATE FUNCTION sale_voids_fill_business_date() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.business_date IS NULL THEN
    SELECT (NEW.voided_at AT TIME ZONE s.timezone)::date
      INTO NEW.business_date
      FROM stores s WHERE s.id = NEW.store_id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER sale_voids_business_date_fill
  BEFORE INSERT ON sale_voids
  FOR EACH ROW EXECUTE FUNCTION sale_voids_fill_business_date();

ALTER TABLE sale_voids FORCE ROW LEVEL SECURITY;

-- =============================================================================
-- 4a. sale_returns — one row per line-aware return (RT-14 D1)
-- =============================================================================

CREATE TABLE sale_returns (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id        UUID          NOT NULL,
  tenant_id      UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id       UUID          NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  -- Per-sale order, assigned under the sales row lock. Ordering by
  -- returned_at is NOT safe: now() is the transaction start, so a return
  -- that waited on the lock can carry an earlier stamp than the winner.
  return_seq     INTEGER       NOT NULL,
  returned_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- The return's own business day, store timezone at insert (RT-63 P2).
  business_date  DATE          NOT NULL,
  currency_code  CHAR(3)       NOT NULL,
  return_total   NUMERIC(19,4) NOT NULL,
  reason         TEXT,
  source_system  TEXT          NOT NULL,
  external_id    TEXT          NOT NULL,
  payload_hash   TEXT          NOT NULL,
  created_by     UUID          NOT NULL,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT sale_returns_return_seq_positive CHECK (return_seq > 0),
  CONSTRAINT sale_returns_currency_code_format CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT sale_returns_return_total_non_negative CHECK (return_total >= 0),
  CONSTRAINT sale_returns_reason_length
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT fk_sale_returns_sale_tenant_store
    FOREIGN KEY (sale_id, tenant_id, store_id)
    REFERENCES sales (id, tenant_id, store_id) ON DELETE RESTRICT,
  -- Backs the composite FK from the two child tables.
  CONSTRAINT uq_sale_returns_id_tenant_store UNIQUE (id, tenant_id, store_id),
  CONSTRAINT uq_sale_returns_sale_seq UNIQUE (sale_id, return_seq)
);

CREATE UNIQUE INDEX uq_sale_returns_tenant_source_external
  ON sale_returns (tenant_id, source_system, external_id);

CREATE INDEX idx_sale_returns_tenant_store ON sale_returns (tenant_id, store_id);

ALTER TABLE sale_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_returns FORCE ROW LEVEL SECURITY;

CREATE POLICY sale_returns_tenant_read ON sale_returns
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY sale_returns_tenant_insert ON sale_returns
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 4b. sale_return_lines — the returned quantity and its server-computed price
-- =============================================================================

CREATE TABLE sale_return_lines (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id                UUID          NOT NULL,
  -- Membership of the line in the return's sale is checked by the service
  -- under the sales row lock; the FK guarantees the line exists.
  sale_line_id             UUID          NOT NULL REFERENCES sale_lines(id) ON DELETE RESTRICT,
  tenant_id                UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id                 UUID          NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  quantity                 NUMERIC(19,6) NOT NULL,
  line_amount              NUMERIC(19,4) NOT NULL,
  tax_amount               NUMERIC(19,4),
  -- Cumulative quantity returned on the line INCLUDING this return, frozen at
  -- insert so a replay returns the identical returnability snapshot.
  returned_quantity_after  NUMERIC(19,6) NOT NULL,
  CONSTRAINT sale_return_lines_quantity_positive CHECK (quantity > 0),
  CONSTRAINT sale_return_lines_line_amount_non_negative CHECK (line_amount >= 0),
  CONSTRAINT sale_return_lines_tax_amount_non_negative
    CHECK (tax_amount IS NULL OR tax_amount >= 0),
  CONSTRAINT sale_return_lines_cumulative_covers_quantity
    CHECK (returned_quantity_after >= quantity),
  CONSTRAINT fk_sale_return_lines_return_tenant_store
    FOREIGN KEY (return_id, tenant_id, store_id)
    REFERENCES sale_returns (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT uq_sale_return_lines_return_line UNIQUE (return_id, sale_line_id)
);

CREATE INDEX idx_sale_return_lines_sale_line ON sale_return_lines (sale_line_id);
CREATE INDEX idx_sale_return_lines_tenant_store ON sale_return_lines (tenant_id, store_id);

ALTER TABLE sale_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_return_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY sale_return_lines_tenant_read ON sale_return_lines
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY sale_return_lines_tenant_insert ON sale_return_lines
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 4c. sale_return_tenders — the refund payout, recorded as a fact (RT-14 D3)
-- =============================================================================

CREATE TABLE sale_return_tenders (
  id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id  UUID          NOT NULL,
  tenant_id  UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id   UUID          NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  -- Request order, so a replay echoes the tenders in the order received.
  ordinal    INTEGER       NOT NULL,
  method     TEXT          NOT NULL,
  amount     NUMERIC(19,4) NOT NULL,
  CONSTRAINT sale_return_tenders_ordinal_non_negative CHECK (ordinal >= 0),
  -- Cash only for the pilot (D3); RT-10 widens this and re-triggers SI-012.
  CONSTRAINT sale_return_tenders_method_valid CHECK (method IN ('cash')),
  CONSTRAINT sale_return_tenders_amount_non_negative CHECK (amount >= 0),
  CONSTRAINT fk_sale_return_tenders_return_tenant_store
    FOREIGN KEY (return_id, tenant_id, store_id)
    REFERENCES sale_returns (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT uq_sale_return_tenders_return_ordinal UNIQUE (return_id, ordinal)
);

CREATE INDEX idx_sale_return_tenders_tenant_store ON sale_return_tenders (tenant_id, store_id);

ALTER TABLE sale_return_tenders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_return_tenders FORCE ROW LEVEL SECURITY;

CREATE POLICY sale_return_tenders_tenant_read ON sale_return_tenders
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY sale_return_tenders_tenant_insert ON sale_return_tenders
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

COMMIT;
