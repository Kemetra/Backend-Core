-- 0049_sale_responsibilities.sql
--
-- Sale payer responsibilities (Jira RT-418, migration A of the 035 Option B
-- narrowing). [GATED] migration: authored under the coordinator's delegation
-- from the owner (2026-10-16); owner approval is required on the PR before
-- merge (RT-418, G3 human gate).
--
-- Source-of-truth decisions:
--   - owner decision R-1 (RT-413 comment 11669): a credit / third-party sale
--     records who owes how much as part of the immutable sale fact;
--   - RT-417 contracts (PR #779): `pos-sales/sales.yaml` 1.10.0-draft
--     `SaleResponsibility`, `erpnext-connector/posting-feed.yaml` 1.8.0-draft
--     (`payerExternalRef` frozen with the RT-332 resolution, never in
--     `payloadHash`), `settlement/settlement.yaml` 2.0.0 (`creditTerms`
--     removed); decision record 035 amendment A2.
--
-- Changes, in order:
--   1. payer_account: DROP credit_terms (ERPNext owns terms and credit limits;
--      no runtime ever wrote it), and a UNIQUE (id, tenant_id) target so a
--      responsibility can only name a payer of its own tenant.
--   2. sales.responsibility_count SMALLINT NOT NULL DEFAULT 0 — how many
--      sale_responsibilities rows capture wrote, in the same transaction. The
--      posting feed keys its holds on it and refuses to offer a sale whose
--      VISIBLE responsibility rows differ from it: zero visible rows is
--      otherwise indistinguishable from a cash sale, which would post the
--      payer's share to the store Customer, terminally (the tender_count /
--      RT-86 precedent). 0..1: one payer per sale in this version
--      (`maxItems: 1`).
--   3. sale_responsibilities — append-only, tenant-RLS-forced, SELECT +
--      INSERT policies only; a child of the immutable sale fact. NOT a
--      receivable: no balance, no state.
--   4. erpnext_posting_resolution.payer_external_ref TEXT NULL — the payer's
--      ERPNext Customer link frozen with each resolution version (RT-332), so
--      every re-pull of a work item is identical. One payer per sale, so the
--      value repeats on every line of a version, as warehouse_ref does. NULL
--      for a sale without responsibilities and for every pre-0049 row.
--
-- No existing row is modified except by the credit_terms drop (always NULL
-- in practice: no route wrote it).
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV)
-- ---------------------------------------------------------------------------
-- sale_responsibilities is BUSINESS-CLASS: a payer id (an opaque reference to
-- payer_account), an amount and a position. No PII column: the payer's
-- display name stays on payer_account. payer_external_ref is an ERPNext
-- Customer identifier (BUSINESS-CLASS). Retention inherits the 001
-- long-horizon insert-only posture of the sale fact; erasure tombstones,
-- never deletes.
--
-- Lock duration: `lock_timeout` is 5s (fail fast, re-run). sales takes
-- ACCESS EXCLUSIVE for one metadata-only ADD COLUMN (a constant default) and
-- a NOT VALID CHECK, then SHARE UPDATE EXCLUSIVE to VALIDATE it (a scan that
-- blocks no reads or writes; every existing row is 0). payer_account takes
-- ACCESS EXCLUSIVE for the DROP COLUMN (metadata-only) and SHARE for the
-- unique index build over a small table. erpnext_posting_resolution takes
-- ACCESS EXCLUSIVE for one metadata-only nullable ADD COLUMN. The new table
-- takes only catalog locks.
-- Grants: none here — production grants the domain role SELECT + INSERT on
-- sale_responsibilities outside migrations
-- (docs/operations/sql/sale-responsibilities-domain-grants.sql).
-- Reversible via 0049_sale_responsibilities.down.sql.

BEGIN;

-- Fail fast instead of queueing behind a long transaction on `sales` (every
-- later sale read and write would queue behind this ACCESS EXCLUSIVE request).
-- A timeout aborts the whole migration; re-run it.
SET LOCAL lock_timeout = '5s';

-- =============================================================================
-- 1. payer_account: drop credit_terms, add the composite FK target
-- =============================================================================

ALTER TABLE payer_account DROP COLUMN IF EXISTS credit_terms;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_idx_payer_account_id_tenant"
  ON payer_account (id, tenant_id);

-- =============================================================================
-- 2. sales.responsibility_count
-- =============================================================================

ALTER TABLE sales
  ADD COLUMN responsibility_count SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE sales
  ADD CONSTRAINT sales_responsibility_count_range
    CHECK (responsibility_count BETWEEN 0 AND 1) NOT VALID;

-- Every existing row is 0 by construction (the column was just added with a
-- constant default), so validate now: the scan holds only SHARE UPDATE
-- EXCLUSIVE, which does not block reads or writes of sales.
ALTER TABLE sales VALIDATE CONSTRAINT sales_responsibility_count_range;

-- =============================================================================
-- 3. sale_responsibilities — who owes how much of the sale (R-1)
-- =============================================================================

CREATE TABLE sale_responsibilities (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id    UUID          NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  sale_id     UUID          NOT NULL,
  payer_id    UUID          NOT NULL,
  -- The payer's gross share of posTotal, in the sale's currency.
  amount      NUMERIC(19,4) NOT NULL,
  -- 1-based position among the sale's responsibilities.
  sequence    SMALLINT      NOT NULL,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT sale_responsibilities_amount_positive CHECK (amount > 0),
  CONSTRAINT sale_responsibilities_sequence_positive CHECK (sequence >= 1),
  CONSTRAINT fk_sale_responsibilities_sale_tenant_store
    FOREIGN KEY (sale_id, tenant_id, store_id)
    REFERENCES sales (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT fk_sale_responsibilities_payer_tenant
    FOREIGN KEY (payer_id, tenant_id)
    REFERENCES payer_account (id, tenant_id) ON DELETE RESTRICT,
  -- payerRef and sequence are unique within the sale (contract: else 400).
  CONSTRAINT uq_sale_responsibilities_sale_payer UNIQUE (sale_id, payer_id),
  CONSTRAINT uq_sale_responsibilities_sale_sequence UNIQUE (sale_id, sequence)
);

CREATE INDEX idx_sale_responsibilities_tenant_store ON sale_responsibilities (tenant_id, store_id);
-- The payer FK's referencing side (RESTRICT checks, future per-payer reads).
CREATE INDEX idx_sale_responsibilities_payer ON sale_responsibilities (payer_id);

ALTER TABLE sale_responsibilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_responsibilities FORCE ROW LEVEL SECURITY;

CREATE POLICY sale_responsibilities_tenant_read ON sale_responsibilities
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT-only: part of the immutable sale fact (no UPDATE / DELETE policy).
CREATE POLICY sale_responsibilities_tenant_insert ON sale_responsibilities
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 4. erpnext_posting_resolution.payer_external_ref
-- =============================================================================

ALTER TABLE erpnext_posting_resolution
  ADD COLUMN IF NOT EXISTS payer_external_ref TEXT;

COMMIT;
