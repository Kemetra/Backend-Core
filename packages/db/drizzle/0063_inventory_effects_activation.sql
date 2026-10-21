-- 0063_inventory_effects_activation.sql
--
-- Sale / void / return Inventory Effects activation: the per-tenant flag and
-- the Inventory Anchor taken at activation, additive (Jira RT-427).
-- [GATED] migration — owner-authorized on RT-427 (2026-10-21: migration 0063
-- as proposed, decisions 1–6 as recommended) within RT-289 (comment 11685:
-- Q3, Q4, DC-8) and RT-290 Gate 4 (M-8).
--
-- Source-of-truth decisions (Confluence RETAIL "Inventory Operations"
-- baseline):
--   - Q4 / 977 / 980: sale effects activate per tenant behind a flag that
--     defaults to OFF.
--   - DC-8 / Q3: activation never backfills historical sales. An Inventory
--     Anchor is taken from ERP-confirmed state at activation and absorbs the
--     earlier manual movements as coverage provenance.
--   - 778 / 779: the anchor is a metadata / projection baseline, never an
--     inventory movement (it is NOT a stock_movements row).
--   - 780 / 781: it records quantity, UOM, the mapped location / ERP
--     reference and the as-of provenance, plus the coverage it represents.
--   - 786: a new baseline is a new generation; earlier anchors stay history.
--   - M-8: the anchor lands at the bucket's inbound position, primary /
--     sellable in V1.
--   - 788: no valuation here; ERPNext stays the valuation authority.
--
-- Changes, in order:
--   1. tenant_inventory_settings gains sale_effects_activated_at and
--      sale_effects_activated_by, both NULL (OFF) or both set (ON). A tenant
--      without a settings row is OFF.
--   2. inventory_anchors — one row per (tenant, store, generation): the store's
--      primary location and status, the stock reconciliation run whose Bin
--      snapshot it was taken from, the snapshot's read / recorded times, the
--      ERPNext warehouse reference of that snapshot, the activation watermark
--      and a JSON coverage object. FORCE RLS with SELECT + INSERT tenant
--      policies and NO UPDATE / DELETE policy: an anchor is immutable.
--   3. inventory_anchor_lines — one row per (anchor, product): the Bin
--      quantity exactly as ERPNext reported it (NUMERIC(21,6), the contract's
--      quantity pattern), its ERPNext stock UOM and Item reference. Same RLS
--      posture as the anchor.
--
-- Nothing here changes stock_movements, inventory_effect_integration or any
-- posting table. With every flag OFF (the state after this migration) no
-- runtime path behaves differently.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS. Opaque UUIDs, an enumerated status, exact-decimal
-- quantities and their units, opaque ERPNext references (warehouse and Item
-- names), timestamps and a coverage object of counts and timestamps. No PII,
-- no money. Anchors live as long as the effects they baseline (the
-- insert-only, long-horizon posture of stock_movements).
--
-- Grants: none here. Production grants the domain role SELECT and INSERT on
-- both tables outside migrations:
-- docs/operations/sql/inventory-anchors-domain-grants.sql
-- (deploy/README.md step 2). The API refuses to boot without them
-- (DOMAIN_REQUIRED_GRANTS, apps/api/src/auth/database-pools.ts, RT-212).
--
-- Deploy window: none. The settings columns are nullable with no default
-- rewrite; both tables are new and only the activation CLI writes them.
--
-- Lock impact: ONE transaction. ALTER TABLE tenant_inventory_settings takes
-- ACCESS EXCLUSIVE on that small table (one row per tenant) for the ADD
-- COLUMN / ADD CONSTRAINT; existing rows are all NULL, so the CHECK validates
-- instantly. The new tables are created empty. At pilot volume it takes well
-- under a second. Reversible via 0063_inventory_effects_activation.down.sql.

BEGIN;

-- =============================================================================
-- 1. tenant_inventory_settings: the activation flag
-- =============================================================================

ALTER TABLE tenant_inventory_settings
  ADD COLUMN IF NOT EXISTS sale_effects_activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sale_effects_activated_by UUID;

ALTER TABLE tenant_inventory_settings
  ADD CONSTRAINT tenant_inventory_settings_activation_pair
    CHECK ((sale_effects_activated_at IS NULL) = (sale_effects_activated_by IS NULL));

-- =============================================================================
-- 2. inventory_anchors
-- =============================================================================

CREATE TABLE IF NOT EXISTS inventory_anchors (
  id                     UUID         PRIMARY KEY,
  tenant_id              UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id               UUID         NOT NULL,
  -- M-8: the bucket's inbound position (primary / sellable in V1).
  stock_location_id      UUID         NOT NULL,
  inventory_status       TEXT         NOT NULL DEFAULT 'sellable',
  -- 786: 1 at the first activation; a re-baseline adds the next generation.
  generation             INTEGER      NOT NULL,
  -- 780: as-of provenance — the stock run whose Bin snapshot this is.
  source_run_id          UUID         NOT NULL REFERENCES erpnext_reconciliation_run(id) ON DELETE RESTRICT,
  snapshot_read_at       TIMESTAMPTZ  NOT NULL,
  snapshot_recorded_at   TIMESTAMPTZ  NOT NULL,
  -- M-9: the opaque ERPNext Warehouse reference of the snapshot (edge only).
  erpnext_warehouse_ref  TEXT         NOT NULL,
  -- The activation watermark: effects recorded from here on count on top of
  -- the anchor; earlier movements are covered by it (Q3).
  activated_at           TIMESTAMPTZ  NOT NULL,
  -- 781: what the anchor covers (absorbed movements, unmapped Bin items).
  coverage               JSONB        NOT NULL,
  created_by             UUID         NOT NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- 0044's composite target: the location belongs to the anchor's store and
  -- tenant (G4-4).
  CONSTRAINT fk_inventory_anchors_location
    FOREIGN KEY (stock_location_id, store_id, tenant_id)
    REFERENCES stock_locations (id, store_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_anchors_status_allowed
    CHECK (inventory_status IN ('sellable', 'return_inspection', 'quality_hold', 'damaged',
                                'expired', 'recall_hold')),
  CONSTRAINT inventory_anchors_generation_positive
    CHECK (generation >= 1),
  CONSTRAINT inventory_anchors_warehouse_ref_length
    CHECK (char_length(erpnext_warehouse_ref) BETWEEN 1 AND 140),
  CONSTRAINT inventory_anchors_coverage_object
    CHECK (jsonb_typeof(coverage) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_anchors_store_generation
  ON inventory_anchors (tenant_id, store_id, generation);

-- Composite target for the lines' same-tenant FK.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_anchors_id_tenant
  ON inventory_anchors (id, tenant_id);

ALTER TABLE inventory_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_anchors FORCE ROW LEVEL SECURITY;

CREATE POLICY inventory_anchors_tenant_read ON inventory_anchors
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT only: an anchor is never changed or removed (786).
CREATE POLICY inventory_anchors_tenant_insert ON inventory_anchors
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 3. inventory_anchor_lines
-- =============================================================================

CREATE TABLE IF NOT EXISTS inventory_anchor_lines (
  id                  UUID           PRIMARY KEY,
  anchor_id           UUID           NOT NULL,
  tenant_id           UUID           NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tenant_product_ref  UUID           NOT NULL,
  -- The Bin quantity as ERPNext reported it (stock-view quantity pattern:
  -- up to 15 integer and 6 decimal digits). Exact, never rounded (756).
  quantity            NUMERIC(21,6)  NOT NULL,
  -- ERPNext's stock UOM for the Item (780). A unit that differs from the
  -- operational unit is a UOM-mismatch finding, never a divergence (M-6).
  erp_stock_uom       TEXT           NOT NULL,
  erpnext_item_ref    TEXT           NOT NULL,
  CONSTRAINT fk_inventory_anchor_lines_anchor
    FOREIGN KEY (anchor_id, tenant_id)
    REFERENCES inventory_anchors (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_anchor_lines_product
    FOREIGN KEY (tenant_product_ref, tenant_id)
    REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_anchor_lines_uom_length
    CHECK (char_length(erp_stock_uom) BETWEEN 1 AND 140),
  CONSTRAINT inventory_anchor_lines_item_ref_length
    CHECK (char_length(erpnext_item_ref) BETWEEN 1 AND 140)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_anchor_lines_anchor_product
  ON inventory_anchor_lines (anchor_id, tenant_product_ref);

ALTER TABLE inventory_anchor_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_anchor_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY inventory_anchor_lines_tenant_read ON inventory_anchor_lines
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY inventory_anchor_lines_tenant_insert ON inventory_anchor_lines
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

COMMIT;
