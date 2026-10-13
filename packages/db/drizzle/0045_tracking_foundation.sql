-- 0045_tracking_foundation.sql
--
-- Tracking foundation, additive (Jira RT-448). [GATED] migration, approved by
-- the owner on RT-448 (comment 11783, 2026-10-13) within the RT-50 Gate 7
-- decision (planning record comments 11763/11764, owner verdict comment 11765).
--
-- Source-of-truth decisions (Confluence RETAIL "Inventory Operations" baseline,
-- section "Gate 7 — Tracked inventory safety (RT-50)"):
--   - G7-1: Catalog declares the Tracking Profile per product (852, 384, 386):
--     tracking_mode none | batch | serial, plus expiry_required (batch only).
--     It may change only while the product has no inventory effect and no
--     captured sale line (387); after that a change is refused.
--   - G7-2: Tracking Identity is typed and Inventory-owned (749, 853, 385, 454;
--     RT-290 Q7). A tracking_identities row is a batch or a serial of one
--     product; kind, code and product are immutable. Effects reference it by a
--     typed tracking_identity_id; the free-text tracking_identity column added
--     by 0042 stays NULL permanently (0044's stock_movements_tracking_none). A
--     separate 1:1 edge map holds the opaque ERPNext Batch / Serial No name
--     (M-4, M-9).
--   - G7-3: identities are ERP-born only (origin = 'erp_external').
--
-- NOTHING ACTIVATES HERE. Nothing writes a tracking identity, an edge-map row
-- or a tracking_identity_id (RT-451 / RT-453). Every product stays
-- tracking_mode 'none' until an admin sets a profile through the guarded
-- setter; tracked selling stays fail-closed in the Connector.
--
-- Changes, in order:
--   1. tenant_products: tracking_mode (default 'none') and expiry_required
--      (default false), both NOT NULL with constant defaults (no rewrite); a
--      composite (id, tenant_id) unique target; and a trigger that refuses a
--      profile change once the product has an inventory effect or a captured
--      sale line (387). The API's guarded setter checks the same rule first and
--      answers 409; the trigger is the backstop for every other writer.
--   2. tracking_identities — FORCE RLS with SELECT + INSERT tenant policies and
--      NO UPDATE / DELETE policy. A guard trigger rejects any change of tenant,
--      product, kind, code or origin (any role). expiry_date may only change
--      through the governed expiry correction that RT-449 adds.
--   3. erpnext_tracking_map — the 1:1 edge map, FORCE RLS, SELECT + INSERT only.
--   4. stock_movements.tracking_identity_id (nullable, no default: no rewrite),
--      a NOT VALID composite FK to the identity of the effect's own product and
--      tenant, and a NOT VALID CHECK that an identity needs a product.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS. Opaque UUIDs, an enumerated kind, a printed lot / serial code
-- (manufacturer data, no PII), dates, an opaque ERPNext document name and
-- timestamps. Retention follows the owning product: rows live as long as the
-- product row does (RESTRICT FKs keep a referenced identity).
--
-- Grants: none here. Production grants the domain role SELECT on
-- tracking_identities and erpnext_tracking_map outside migrations:
-- docs/operations/sql/tracking-foundation-domain-grants.sql (deploy/README.md
-- step 2). The API refuses to boot without them (DOMAIN_REQUIRED_GRANTS,
-- apps/api/src/auth/database-pools.ts, RT-212). tenant_products is already
-- read and written by the domain role.
--
-- Deploy window: none. The new columns have defaults or are nullable, no
-- existing writer names them, and the previous release keeps working.
--
-- Lock impact: ONE transaction; every lock is held until COMMIT:
--   - tenant_products: ACCESS EXCLUSIVE for the two ADD COLUMNs (constant
--     defaults, no rewrite) and the CHECKs (one validation scan); SHARE for the
--     unique index build.
--   - stock_movements: ACCESS EXCLUSIVE for the nullable ADD COLUMN and the
--     NOT VALID constraints (no scan); the partial index on the new, all-NULL
--     column builds instantly.
--   - tracking_identities / erpnext_tracking_map are created empty.
-- At pilot volume the whole migration is expected to take well under a second.
-- Reversible via 0045_tracking_foundation.down.sql.

BEGIN;

-- =============================================================================
-- 1. tenant_products: the Tracking Profile (G7-1)
-- =============================================================================

ALTER TABLE tenant_products
  ADD COLUMN IF NOT EXISTS tracking_mode   TEXT    NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS expiry_required BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE tenant_products
  ADD CONSTRAINT tenant_products_tracking_mode_allowed
    CHECK (tracking_mode IN ('none', 'batch', 'serial'));

-- Expiry is a batch fact (386): a serial or untracked product never requires it.
ALTER TABLE tenant_products
  ADD CONSTRAINT tenant_products_expiry_requires_batch
    CHECK (NOT expiry_required OR tracking_mode = 'batch');

-- Composite target for the same-tenant FK from tracking_identities.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_products_id_tenant
  ON tenant_products (id, tenant_id);

-- 387: after stock or transaction history exists, a tracking-mode change is a
-- migration / impact operation, not a field edit. V1 refuses it. The trigger
-- runs as the updating role inside its tenant context, so the EXISTS probes see
-- that tenant's rows (the product's own rows, by construction).
CREATE OR REPLACE FUNCTION tenant_products_guard_tracking_profile()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tracking_mode IS DISTINCT FROM OLD.tracking_mode
     OR NEW.expiry_required IS DISTINCT FROM OLD.expiry_required THEN
    IF EXISTS (SELECT 1 FROM stock_movements WHERE tenant_product_ref = OLD.id)
       OR EXISTS (SELECT 1 FROM sale_lines WHERE tenant_product_ref = OLD.id) THEN
      RAISE EXCEPTION
        'tenant_products % : tracking profile is locked once the product has inventory or sale history', OLD.id
        USING ERRCODE = '23514',
              CONSTRAINT = 'tenant_products_tracking_profile_locked';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_products_guard_tracking_profile
  BEFORE UPDATE OF tracking_mode, expiry_required ON tenant_products
  FOR EACH ROW EXECUTE FUNCTION tenant_products_guard_tracking_profile();

-- =============================================================================
-- 2. tracking_identities (G7-2, G7-3)
-- =============================================================================

CREATE TABLE IF NOT EXISTS tracking_identities (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tenant_product_ref  UUID         NOT NULL,
  kind                TEXT         NOT NULL,
  -- The lot or serial number exactly as printed on the pack; matched exactly,
  -- never fuzzily (313).
  code                TEXT         NOT NULL,
  expiry_date         DATE,
  manufactured_on     DATE,
  origin              TEXT         NOT NULL DEFAULT 'erp_external',
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fk_tracking_identities_product_tenant
    FOREIGN KEY (tenant_product_ref, tenant_id)
    REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT tracking_identities_kind_allowed
    CHECK (kind IN ('batch', 'serial')),
  CONSTRAINT tracking_identities_code_shape
    CHECK (char_length(code) BETWEEN 1 AND 128 AND code = btrim(code)),
  -- G7-3: Retail Tower never invents a batch or serial.
  CONSTRAINT tracking_identities_origin_allowed
    CHECK (origin IN ('erp_external')),
  CONSTRAINT tracking_identities_dates_ordered
    CHECK (manufactured_on IS NULL OR expiry_date IS NULL OR manufactured_on <= expiry_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tracking_identities_product_kind_code
  ON tracking_identities (tenant_id, tenant_product_ref, kind, code);

-- Composite target for stock_movements: the identity of the effect's product.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracking_identities_id_product_tenant
  ON tracking_identities (id, tenant_product_ref, tenant_id);

-- Composite target for the edge map: same tenant, same kind.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracking_identities_id_tenant_kind
  ON tracking_identities (id, tenant_id, kind);

CREATE TRIGGER tracking_identities_set_updated_at
  BEFORE UPDATE ON tracking_identities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- An identity keeps meaning what it meant (G7-2), for every role.
CREATE OR REPLACE FUNCTION tracking_identities_guard_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.tenant_product_ref <> OLD.tenant_product_ref
     OR NEW.kind <> OLD.kind
     OR NEW.code <> OLD.code
     OR NEW.origin <> OLD.origin THEN
    RAISE EXCEPTION
      'tracking_identities % : tenant, product, kind, code and origin are immutable', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tracking_identities_guard_identity
  BEFORE UPDATE ON tracking_identities
  FOR EACH ROW EXECUTE FUNCTION tracking_identities_guard_identity();

ALTER TABLE tracking_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_identities FORCE ROW LEVEL SECURITY;

CREATE POLICY tracking_identities_tenant_read ON tracking_identities
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT only (identity birth, RT-453); NO UPDATE / DELETE policy.
CREATE POLICY tracking_identities_tenant_insert ON tracking_identities
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 3. erpnext_tracking_map — the 1:1 ERP edge map (M-4, M-9)
-- =============================================================================

CREATE TABLE IF NOT EXISTS erpnext_tracking_map (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tracking_identity_id  UUID         NOT NULL,
  -- Repeats the identity's kind so the FK below keeps them equal and a Batch
  -- name and a Serial No name never collide in the unique index.
  kind                  TEXT         NOT NULL,
  -- Opaque ERPNext Batch / Serial No document name (Frappe names are ≤ 140).
  erpnext_ref           TEXT         NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fk_erpnext_tracking_map_identity
    FOREIGN KEY (tracking_identity_id, tenant_id, kind)
    REFERENCES tracking_identities (id, tenant_id, kind) ON DELETE RESTRICT,
  CONSTRAINT erpnext_tracking_map_kind_allowed
    CHECK (kind IN ('batch', 'serial')),
  CONSTRAINT erpnext_tracking_map_ref_length
    CHECK (char_length(erpnext_ref) BETWEEN 1 AND 140)
);

-- 1:1 in both directions within a tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_erpnext_tracking_map_identity
  ON erpnext_tracking_map (tracking_identity_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_erpnext_tracking_map_tenant_kind_ref
  ON erpnext_tracking_map (tenant_id, kind, erpnext_ref);

ALTER TABLE erpnext_tracking_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE erpnext_tracking_map FORCE ROW LEVEL SECURITY;

CREATE POLICY erpnext_tracking_map_tenant_read ON erpnext_tracking_map
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT only; a mapping is never re-pointed in place. NO UPDATE / DELETE policy.
CREATE POLICY erpnext_tracking_map_tenant_insert ON erpnext_tracking_map
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 4. stock_movements.tracking_identity_id (G7-2; new rows only)
-- =============================================================================

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS tracking_identity_id UUID;

-- The identity belongs to the effect's own product and tenant. NOT VALID: no
-- scan (every existing row is NULL; append-only rows are never updated).
ALTER TABLE stock_movements
  ADD CONSTRAINT fk_stock_movements_tracking_identity
    FOREIGN KEY (tracking_identity_id, tenant_product_ref, tenant_id)
    REFERENCES tracking_identities (id, tenant_product_ref, tenant_id) ON DELETE RESTRICT
    NOT VALID;

-- A MATCH SIMPLE FK skips the check when tenant_product_ref is NULL, so an
-- identity without a product is refused explicitly.
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_tracking_identity_needs_product
    CHECK (tracking_identity_id IS NULL OR tenant_product_ref IS NOT NULL) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_stock_movements_tracking_identity
  ON stock_movements (tracking_identity_id)
  WHERE tracking_identity_id IS NOT NULL;

COMMIT;
