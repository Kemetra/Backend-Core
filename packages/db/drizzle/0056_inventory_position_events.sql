-- 0056_inventory_position_events.sql
--
-- Inventory status moves and relocations, additive (Jira RT-435).
-- [GATED] migration — owner-authorized on RT-435 (comment 12993, 2026-10-19:
-- D1–D4 of comment 12991 approved as proposed) within the RT-290 Gate 4
-- decision (comments 11715 and 11717).
--
-- Source-of-truth decisions (Confluence RETAIL "Inventory Operations"
-- baseline, sections "Gate 4 ... (RT-290)" and "Gate 7 ... (RT-50)"):
--   - G4-2 / 842–844: a status change is two effects under one event at the
--     same location; it never reduces total physical stock.
--   - 800 / 814: a relocation is an internal move between locations of one
--     store, distinct from a shipment Transfer; within one ERP mapping bucket
--     it needs no ERP quantity movement.
--   - M-5 / Q10: an event whose per-bucket net is zero gets `erp_neutral`
--     effects at creation (the integration rows, in the writer's transaction).
--   - G2-1 / 838: both events are typed `adjustment` Business Events (D3); this
--     table is their event record, as stock_counts is a count's.
--   - DC-1: one effect per event leg, keyed `<kind>:<eventId>:from|to` in the
--     effects' (source_system, external_id) provenance pair; replays are no-ops.
--   - 839 (D1): a closed Reason Code per status move, checked against the
--     (from_status -> to_status) pair by the API; the CHECK below holds the
--     vocabulary only.
--   - Q6 / 849: the per-tenant return landing status, default `sellable`.
--   - RT-50 comment 11775: an event names the tracking identity its effect
--     pair carries. NULL until tracked selling (RT-451) writes one.
--
-- Changes, in order:
--   1. inventory_position_events — the event record of a status move or a
--      relocation: store, product, quantity, from / to (location, status),
--      reason code, note, tracking identity, actor and a command fingerprint
--      that is UNIQUE per tenant (DB-level replay). FORCE RLS with SELECT +
--      INSERT tenant policies and NO UPDATE / DELETE policy: the record is
--      append-only. Both locations are tied to the event's store and tenant by
--      composite FKs (the 0044 target), the product and the tracking identity
--      to the tenant (0045 targets).
--   2. tenant_inventory_settings — one row per tenant with
--      return_landing_status (`sellable` | `return_inspection`, default
--      `sellable`). No row reads as the default. FORCE RLS with SELECT, INSERT
--      and UPDATE tenant policies; NO DELETE policy.
--
-- Nothing here changes stock_movements or inventory_effect_integration: the
-- effects of both events use the existing `adjustment` event type, the
-- `adjustment` movement type and 0044's `erp_neutral` state.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS. Opaque UUIDs, enumerated kind / status / reason codes, an
-- exact-decimal quantity and its unit, a bounded operator note (no PII by
-- policy, as stock_movements.reason), a SHA-256 hex fingerprint (never the raw
-- Idempotency-Key) and timestamps. No money. Event records live as long as
-- the effects they own (stock_movements' long-horizon, insert-only posture);
-- a settings row lives as long as its tenant.
--
-- Grants: none here. Production grants the domain role SELECT and INSERT on
-- inventory_position_events and SELECT, INSERT and UPDATE on
-- tenant_inventory_settings outside migrations:
-- docs/operations/sql/inventory-position-events-domain-grants.sql
-- (deploy/README.md step 2). The API refuses to boot without them
-- (DOMAIN_REQUIRED_GRANTS, apps/api/src/auth/database-pools.ts, RT-212).
--
-- Deploy window: none. Both tables are new and only the new routes use them;
-- the previous release keeps working.
--
-- Lock impact: ONE transaction. Both tables are created empty. The FKs take
-- SHARE ROW EXCLUSIVE on tenants, stock_locations, tenant_products and
-- tracking_identities while the migration commits; the new tables have no
-- rows to validate. At pilot volume it takes well under a second.
-- Reversible via 0056_inventory_position_events.down.sql.

BEGIN;

-- =============================================================================
-- 1. inventory_position_events
-- =============================================================================

CREATE TABLE IF NOT EXISTS inventory_position_events (
  id                    UUID           PRIMARY KEY,
  tenant_id             UUID           NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id              UUID           NOT NULL,
  kind                  TEXT           NOT NULL,
  tenant_product_ref    UUID           NOT NULL,
  -- The moved magnitude; the effects carry -quantity (from) and +quantity (to).
  quantity              NUMERIC(19,4)  NOT NULL,
  stocking_unit         TEXT           NOT NULL,
  from_location_id      UUID           NOT NULL,
  to_location_id        UUID           NOT NULL,
  from_status           TEXT           NOT NULL,
  to_status             TEXT           NOT NULL,
  reason_code           TEXT,
  note                  TEXT,
  -- The tracking identity both effects carry (RT-50 G7-2). NULL until RT-451.
  tracking_identity_id  UUID,
  -- SHA-256 hex of the command's replay identity (never the raw key).
  command_fingerprint   TEXT           NOT NULL,
  occurred_at           TIMESTAMPTZ    NOT NULL DEFAULT now(),
  created_by            UUID           NOT NULL,
  created_at            TIMESTAMPTZ    NOT NULL DEFAULT now(),
  -- 0044's composite target: each location belongs to the event's store and
  -- tenant (G4-4).
  CONSTRAINT fk_inventory_position_events_from_location
    FOREIGN KEY (from_location_id, store_id, tenant_id)
    REFERENCES stock_locations (id, store_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_position_events_to_location
    FOREIGN KEY (to_location_id, store_id, tenant_id)
    REFERENCES stock_locations (id, store_id, tenant_id) ON DELETE RESTRICT,
  -- 0045's composite targets: a product of this tenant, and an identity of
  -- that product.
  CONSTRAINT fk_inventory_position_events_product_tenant
    FOREIGN KEY (tenant_product_ref, tenant_id)
    REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_position_events_tracking_identity
    FOREIGN KEY (tracking_identity_id, tenant_product_ref, tenant_id)
    REFERENCES tracking_identities (id, tenant_product_ref, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_position_events_kind_allowed
    CHECK (kind IN ('status_move', 'relocation')),
  CONSTRAINT inventory_position_events_quantity_positive
    CHECK (quantity > 0),
  CONSTRAINT inventory_position_events_unit_length
    CHECK (char_length(stocking_unit) BETWEEN 1 AND 32),
  CONSTRAINT inventory_position_events_status_allowed
    CHECK (from_status IN ('sellable', 'return_inspection', 'quality_hold', 'damaged',
                           'expired', 'recall_hold')
       AND to_status IN ('sellable', 'return_inspection', 'quality_hold', 'damaged',
                         'expired', 'recall_hold')),
  -- G4-2: a status move changes the status at one location.
  CONSTRAINT inventory_position_events_status_move_shape
    CHECK (kind <> 'status_move'
        OR (from_location_id = to_location_id
            AND from_status <> to_status
            AND reason_code IS NOT NULL)),
  -- 800: a relocation changes the location and keeps the status.
  CONSTRAINT inventory_position_events_relocation_shape
    CHECK (kind <> 'relocation'
        OR (from_location_id <> to_location_id AND from_status = to_status)),
  -- 839 (RT-435 D1): the governed Reason Code vocabulary.
  CONSTRAINT inventory_position_events_reason_code_allowed
    CHECK (reason_code IS NULL OR reason_code IN (
      'damage', 'expiry', 'quality_hold', 'recall', 'inspection_restock',
      'inspection_damage', 'hold_release', 'correction')),
  CONSTRAINT inventory_position_events_correction_note
    CHECK (reason_code IS DISTINCT FROM 'correction' OR note IS NOT NULL),
  CONSTRAINT inventory_position_events_note_length
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  CONSTRAINT inventory_position_events_fingerprint_shape
    CHECK (command_fingerprint ~ '^[0-9a-f]{64}$')
);

-- DB-level replay (DC-1): one event per command per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_position_events_tenant_fingerprint
  ON inventory_position_events (tenant_id, command_fingerprint);

CREATE INDEX IF NOT EXISTS idx_inventory_position_events_tenant_store_created
  ON inventory_position_events (tenant_id, store_id, created_at);

ALTER TABLE inventory_position_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_position_events FORCE ROW LEVEL SECURITY;

CREATE POLICY inventory_position_events_tenant_read ON inventory_position_events
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT only: an event record is never changed or removed.
CREATE POLICY inventory_position_events_tenant_insert ON inventory_position_events
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 2. tenant_inventory_settings
-- =============================================================================

CREATE TABLE IF NOT EXISTS tenant_inventory_settings (
  tenant_id              UUID         PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  -- Q6 / 849: where a return line's effect lands (RT-427 reads it).
  return_landing_status  TEXT         NOT NULL DEFAULT 'sellable',
  updated_by             UUID         NOT NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tenant_inventory_settings_return_landing_allowed
    CHECK (return_landing_status IN ('sellable', 'return_inspection'))
);

CREATE TRIGGER tenant_inventory_settings_set_updated_at
  BEFORE UPDATE ON tenant_inventory_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE tenant_inventory_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_inventory_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_inventory_settings_tenant_read ON tenant_inventory_settings
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY tenant_inventory_settings_tenant_insert ON tenant_inventory_settings
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- UPDATE: the setting changes. Both USING and WITH CHECK, so a row can be
-- neither reached nor re-homed across tenants. NO DELETE policy.
CREATE POLICY tenant_inventory_settings_tenant_update ON tenant_inventory_settings
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

COMMIT;
