-- 0044_stock_locations_position_grain.sql
--
-- Stock Locations and the inventory position grain, additive (Jira RT-432).
-- [GATED] migration — owner-authorized by the RT-290 decision (Jira comments
-- 11715 and 11717, 2026-10-12); RT-432 carries the bounded scope.
--
-- Source-of-truth decisions (Confluence RETAIL "Inventory Operations"
-- baseline, section "Gate 4 ... (RT-290)"):
--   - G4-1: a Stock Location is a tenant-scoped entity that belongs to exactly
--     one Store (746, 747). Every store has exactly one `primary` location; the
--     primary designation is immutable (RT-290 Q1).
--   - G4-2: Inventory Status is a closed enum (751): sellable,
--     return_inspection, quality_hold, damaged, expired, recall_hold.
--   - G4-3: tracking_identity is NULL (none) until Gate 7 (RT-50).
--   - G4-4: an effect's store equals its location's store.
--   - G4-5: effects recorded before this migration keep their NULL position and
--     are READ as (the store's primary location, sellable, no tracking). History
--     is never updated (774, 970); the constraints below apply to new rows only.
--   - Q10: integration state `erp_neutral` for effects whose per-bucket net is
--     zero (assigned by RT-435; nothing assigns it here).
--
-- NOTHING ACTIVATES HERE. No sale / void / return effect is written (RT-427).
--
-- Changes, in order:
--   1. stock_locations — id, tenant, store, code, name, kind (primary |
--      storage), is_active, timestamps. FORCE RLS with SELECT + INSERT tenant
--      policies and NO UPDATE / DELETE policy, so a location's identity cannot
--      be changed or removed through the application. A guard trigger also
--      rejects any change of tenant, store, kind or code (any role). The FK to
--      stores cascades: a store purge (soft-delete sweep) removes its unused
--      locations; a location that any effect references blocks that purge
--      through stock_movements' own RESTRICT FK on store_id first.
--   2. One `primary` location for every existing store (per-tenant loop under
--      the existing RLS policies, the 0043 pattern), and an AFTER INSERT trigger
--      on stores that creates the primary for every new store in the same
--      transaction. The trigger runs as the inserting role inside its tenant
--      context, so it needs INSERT on stock_locations (see Grants).
--   3. stock_movements position constraints, all NOT VALID (no scan; enforced on
--      every new row; existing rows keep their NULL position per G4-5):
--        - position required: stock_location_id and inventory_status NOT NULL;
--        - inventory_status in the closed enum;
--        - tracking_identity IS NULL;
--        - same-store, same-tenant FK (stock_location_id, store_id, tenant_id)
--          -> stock_locations (id, store_id, tenant_id).
--   4. inventory_effect_integration.state gains `erp_neutral`, which carries no
--      ERP intent and no ERP document.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS. Opaque UUIDs, a short operator-facing location code and name
-- (no PII), an enumerated kind, a flag and timestamps. Retention follows the
-- owning store: rows live as long as the store row does.
--
-- Grants: none here. Production grants the domain role SELECT and INSERT on
-- stock_locations outside migrations:
-- docs/operations/sql/stock-locations-domain-grants.sql (deploy/README.md
-- step 2). The API refuses to boot without them (DOMAIN_REQUIRED_GRANTS,
-- apps/api/src/auth/database-pools.ts, RT-212).
--
-- Deploy window: from this migration's COMMIT until the release that writes
-- explicit positions is running (deploy/README.md steps 1-3), an inventory
-- write from the PREVIOUS release (manual movement, transfer, count) is
-- rejected by the position-required CHECK and returns an error; nothing is
-- written. Creating a store also needs the step-2 grant. Run it in the
-- maintenance window 0042 already requires (no inventory writes in flight).
--
-- Lock impact: ONE transaction; every lock is held until COMMIT (the 0036
-- precedent):
--   - stock_movements: ACCESS EXCLUSIVE for the NOT VALID CHECKs and the
--     NOT VALID FK (no scan, no index build). Every read and write of
--     stock_movements waits until COMMIT; the hold itself is brief.
--   - stores: SHARE ROW EXCLUSIVE for the new FK and the trigger.
--   - inventory_effect_integration: ACCESS EXCLUSIVE to swap one CHECK (the new
--     CHECK is NOT VALID: every existing row satisfies the narrower old one).
--   - stock_locations is created and filled with one row per store.
-- At pilot volume the whole migration is expected to take well under a second.
-- Reversible via 0044_stock_locations_position_grain.down.sql.

BEGIN;

-- =============================================================================
-- 1. stock_locations
-- =============================================================================

CREATE TABLE IF NOT EXISTS stock_locations (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id    UUID         NOT NULL,
  code        TEXT         NOT NULL,
  name        TEXT         NOT NULL,
  kind        TEXT         NOT NULL,
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- 0000 created the (tenant_id, id) unique target on stores.
  CONSTRAINT fk_stock_locations_store_tenant
    FOREIGN KEY (tenant_id, store_id)
    REFERENCES stores (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT stock_locations_kind_allowed
    CHECK (kind IN ('primary', 'storage')),
  -- The primary location is always active (G4-1).
  CONSTRAINT stock_locations_primary_active
    CHECK (kind <> 'primary' OR is_active),
  CONSTRAINT stock_locations_code_length
    CHECK (char_length(code) BETWEEN 1 AND 64),
  CONSTRAINT stock_locations_name_length
    CHECK (char_length(name) BETWEEN 1 AND 200)
);

-- Exactly one primary per store: at most one here; at least one from the
-- backfill below and the stores trigger.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_locations_store_primary
  ON stock_locations (store_id)
  WHERE kind = 'primary';

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_locations_store_code
  ON stock_locations (store_id, lower(code));

-- Composite target for the same-store, same-tenant FK from stock_movements.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_locations_id_store_tenant
  ON stock_locations (id, store_id, tenant_id);

CREATE TRIGGER stock_locations_set_updated_at
  BEFORE UPDATE ON stock_locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A location's identity never changes (G4-1: the primary designation is
-- immutable; an effect's position must keep meaning what it meant). This holds
-- for every role, including the migration owner.
CREATE OR REPLACE FUNCTION stock_locations_guard_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.store_id <> OLD.store_id
     OR NEW.kind <> OLD.kind
     OR NEW.code <> OLD.code THEN
    RAISE EXCEPTION
      'stock_locations % : tenant, store, kind and code are immutable', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_locations_guard_identity
  BEFORE UPDATE ON stock_locations
  FOR EACH ROW EXECUTE FUNCTION stock_locations_guard_identity();

ALTER TABLE stock_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_locations FORCE ROW LEVEL SECURITY;

CREATE POLICY stock_locations_tenant_read ON stock_locations
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT only: the primary is created with its store; NO UPDATE / DELETE policy.
CREATE POLICY stock_locations_tenant_insert ON stock_locations
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 2. A primary location for every store
-- =============================================================================

-- Every store that exists now, soft-deleted ones included (their historical
-- effects are read against their primary, G4-5). Per tenant under the existing
-- policies (the 0043 pattern); explicit tenant predicates keep the result
-- identical when the migration runs as a superuser. Idempotent.
DO $$
DECLARE
  t uuid;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    INSERT INTO stock_locations (tenant_id, store_id, code, name, kind)
    SELECT s.tenant_id, s.id, 'PRIMARY', 'Primary', 'primary'
      FROM stores s
     WHERE s.tenant_id = t
       AND NOT EXISTS (
         SELECT 1 FROM stock_locations l
          WHERE l.store_id = s.id AND l.kind = 'primary');
  END LOOP;
END
$$;

-- Every new store gets its primary in the same transaction. The INSERT runs as
-- the inserting role, under its tenant context, so the stock_locations INSERT
-- policy applies exactly as the stores policy did.
CREATE OR REPLACE FUNCTION stores_create_primary_location()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO stock_locations (tenant_id, store_id, code, name, kind)
  VALUES (NEW.tenant_id, NEW.id, 'PRIMARY', 'Primary', 'primary');
  RETURN NEW;
END;
$$;

CREATE TRIGGER stores_create_primary_location
  AFTER INSERT ON stores
  FOR EACH ROW EXECUTE FUNCTION stores_create_primary_location();

-- =============================================================================
-- 3. stock_movements position constraints (new rows only)
-- =============================================================================

-- NOT VALID throughout: no validation scan. Pre-0044 rows keep their NULL
-- position (G4-5) and are never updated (no UPDATE policy; append-only);
-- every new row is checked.
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_position_required
    CHECK (stock_location_id IS NOT NULL AND inventory_status IS NOT NULL) NOT VALID;

ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_inventory_status_allowed
    CHECK (inventory_status IN (
      'sellable', 'return_inspection', 'quality_hold', 'damaged', 'expired',
      'recall_hold')) NOT VALID;

-- G4-3: no tracked stock until Gate 7 defines Tracking Identity.
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_tracking_none
    CHECK (tracking_identity IS NULL) NOT VALID;

-- G4-4: the location belongs to the effect's own store and tenant.
ALTER TABLE stock_movements
  ADD CONSTRAINT fk_stock_movements_location_store_tenant
    FOREIGN KEY (stock_location_id, store_id, tenant_id)
    REFERENCES stock_locations (id, store_id, tenant_id) ON DELETE RESTRICT
    NOT VALID;

-- =============================================================================
-- 4. inventory_effect_integration: erp_neutral (RT-290 Q10)
-- =============================================================================

ALTER TABLE inventory_effect_integration
  DROP CONSTRAINT inventory_effect_integration_state_allowed;

-- NOT VALID: every existing row satisfies the narrower 0042 CHECK.
ALTER TABLE inventory_effect_integration
  ADD CONSTRAINT inventory_effect_integration_state_allowed
    CHECK (state IN ('not_posted', 'pending', 'confirmed', 'rejected',
                     'reconciliation_required', 'external', 'erp_neutral'))
    NOT VALID;

-- An ERP-neutral effect needs no ERP representation, so it names no ERP
-- document. (0042's intent-link and confirmed-at CHECKs already keep its
-- posting_status_id and erp_confirmed_at NULL.)
ALTER TABLE inventory_effect_integration
  ADD CONSTRAINT inventory_effect_integration_erp_neutral_bare
    CHECK (state <> 'erp_neutral' OR erp_document_ref IS NULL) NOT VALID;

COMMIT;
