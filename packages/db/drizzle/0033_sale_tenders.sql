-- 0033_sale_tenders.sql
--
-- Sale tenders + sale device attribution (Jira RT-77).
-- [GATED] migration — owner-authorized on RT-77 (comment 10509).
--
-- Source-of-truth decisions:
--   - RT-10 decision 10394 (D1 optional tenders on captureSale, Σ = posTotal;
--     D2 cash + card_external only; D7(i) the server-resolved device on the
--     sale; D8 no backfill, never derived from posTotal)
--   - RT-77 comment 10509 (amount >= 0 per the contract's
--     NonNegativeDecimalAmount; sales.tender_count as the feed's visibility
--     guard)
--   - packages/contracts/openapi/pos-sales/sales.yaml (SaleTender)
--
-- Changes, in order:
--   1. sales.device_id UUID NULL → devices(id). Set at capture from the
--      envelope guard's bound device, never from the body. NULL for every
--      pre-RT-77 sale (no backfill) and for a writer that predates RT-77.
--   2. sales.tender_count SMALLINT NOT NULL DEFAULT 0 — how many sale_tenders
--      rows capture wrote, in the same transaction. The posting feed refuses
--      to offer a sale whose VISIBLE tender rows differ from it: a sale posted
--      without its tenders is posted unpaid, terminally (RT-76 INVARIANT), and
--      zero visible rows is otherwise indistinguishable from a tender-unknown
--      sale (the RT-86 lesson). The constant default makes the ADD COLUMN
--      metadata-only (no table rewrite) and keeps old writers valid.
--   3. sale_tenders — append-only, tenant-RLS-forced, SELECT + INSERT
--      policies only; a child of the immutable sale fact.
--
-- Tenders are part of the sale FACT (how it was paid, net of change), NOT a
-- payment-allocation ledger (ADR-0005), and are unrelated to the 035
-- receivables. No existing row is modified.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV) — re-reviewed for RT-77
-- ---------------------------------------------------------------------------
-- sale_tenders is BUSINESS-CLASS with a payment-method attribute. RT-10 adds
-- the first non-cash method, `card_external` (a card paid on a separate
-- terminal), which re-triggers SI-012 as 0032 recorded. `reference` is the
-- card terminal's short approval/receipt code only, constrained to
-- ^[A-Z0-9]{1,6}$ so no PAN (13-19 digits), expiry, track data or customer
-- identifier fits in it; there is no card, account or customer column. The
-- method and amount are sale facts. sales.device_id is a terminal identifier
-- (BUSINESS-CLASS, no PII). Retention inherits the 001 long-horizon
-- insert-only posture; erasure tombstones, never deletes.
--
-- Lock duration: sales takes ACCESS EXCLUSIVE for the two ADD COLUMNs, which
-- are metadata-only (a nullable column and a constant default). The FK and the
-- CHECK are added NOT VALID, so no existing row is scanned under that lock —
-- existing rows satisfy both by construction (device_id all NULL, tender_count
-- all 0) and every new or updated row is checked. The new table takes only
-- catalog locks.
-- Grants: none here — production grants the domain role SELECT + INSERT on
-- sale_tenders outside migrations (see 0006 / the RT-77 PR).
-- Reversible via 0033_sale_tenders.down.sql.

BEGIN;

-- =============================================================================
-- 1–2. sales: the bound device and the tender count
-- =============================================================================

ALTER TABLE sales
  ADD COLUMN device_id    UUID,
  ADD COLUMN tender_count SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE sales
  ADD CONSTRAINT fk_sales_device
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT NOT VALID,
  -- One entry per D2 method at most (uq_sale_tenders_sale_method).
  ADD CONSTRAINT sales_tender_count_range CHECK (tender_count BETWEEN 0 AND 2) NOT VALID;

-- =============================================================================
-- 3. sale_tenders — how the sale was paid (RT-10 D1/D2)
-- =============================================================================

CREATE TABLE sale_tenders (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id        UUID          NOT NULL,
  tenant_id      UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id       UUID          NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  method         TEXT          NOT NULL,
  -- NET of change (cash = tendered − change), in the sale's currency.
  amount         NUMERIC(19,4) NOT NULL,
  -- Copied from the sale at capture; never a request field.
  currency_code  CHAR(3)       NOT NULL,
  reference      TEXT,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- D2 pilot methods; vouchers are excluded. A new method re-triggers SI-012.
  CONSTRAINT sale_tenders_method_valid CHECK (method IN ('cash', 'card_external')),
  CONSTRAINT sale_tenders_amount_non_negative CHECK (amount >= 0),
  CONSTRAINT sale_tenders_currency_code_format CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT sale_tenders_reference_card_only CHECK (
    reference IS NULL
    OR (method = 'card_external' AND reference ~ '^[A-Z0-9]{1,6}$')
  ),
  CONSTRAINT fk_sale_tenders_sale_tenant_store
    FOREIGN KEY (sale_id, tenant_id, store_id)
    REFERENCES sales (id, tenant_id, store_id) ON DELETE RESTRICT,
  -- At most one entry per method (contract: else 400).
  CONSTRAINT uq_sale_tenders_sale_method UNIQUE (sale_id, method)
);

CREATE INDEX idx_sale_tenders_tenant_store ON sale_tenders (tenant_id, store_id);

ALTER TABLE sale_tenders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_tenders FORCE ROW LEVEL SECURITY;

CREATE POLICY sale_tenders_tenant_read ON sale_tenders
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY sale_tenders_tenant_insert ON sale_tenders
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

COMMIT;
