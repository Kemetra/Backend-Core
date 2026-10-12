-- 0042_inventory_effects_journal.sql
--
-- Inventory Effects Journal schema, additive (Jira RT-425).
-- [GATED] migration — owner-authorized by the RT-289 decision (Jira comments
-- 11682 and 11685, 2026-10-12); RT-425 carries the bounded scope.
--
-- Source-of-truth decisions (Confluence RETAIL "Inventory Operations"
-- baseline, section "Gates 2+3 ... (RT-289)"):
--   - G2-2: an Inventory Effect is an additive evolution of stock_movements,
--     not a parallel table (725, 969–971, 976).
--   - G2-3: integration state lives in a separate MUTABLE per-effect record,
--     never on the immutable effect row (771, 772, 774). States:
--     not_posted | pending | confirmed | rejected | reconciliation_required |
--     external. RT-289 Q1 + Q2.
--   - G2-4: erp_confirmed_at is the server time of the ERP `posted` ack
--     (RT-289 Q6) — erpnext_posting_status.posted_at below.
--
-- NOTHING ACTIVATES HERE. No sale / void / return effect is written (that is
-- RT-427), and no posting outcome moves an integration state (that is RT-426).
--
-- Changes, in order:
--   1. stock_movements gains, all additive:
--      - origin TEXT NOT NULL DEFAULT 'retail' — 'retail' | 'erp_external'
--        (768). The constant default is metadata-only (no table rewrite) and
--        makes every existing row 'retail', which it is: every writer on main
--        is a Retail Tower path.
--      - event_type TEXT / event_ref_id UUID — the owning Inventory Business
--        Event (761, 762, G2-1). Both-or-neither. NULL on every pre-0042 row:
--        the append-only history is not rewritten (727, 970), and the RLS
--        layer has no UPDATE policy on this table anyway. New writes set them.
--      - compensates_effect_id UUID — set only on a correction effect (775);
--        a same-tenant self-reference.
--      - stock_location_id UUID / inventory_status TEXT / tracking_identity
--        TEXT — position PLACEHOLDERS (750). Their values are defined by Gate 4
--        (RT-290) and Gate 7 (RT-50); nothing writes them in RT-425, so they
--        carry no CHECK yet.
--      - uq_stock_movements_id_tenant (id, tenant_id) — the composite target
--        the two same-tenant FKs below reference.
--   2. inventory_effect_integration — the mutable per-effect integration
--      record. One row per effect (PK effect_id). RLS: SELECT + INSERT +
--      UPDATE (the state moves); NO DELETE policy. A transition never inserts,
--      edits or deletes an effect (771) — the effect row stays append-only.
--   3. erpnext_posting_status.posted_at TIMESTAMPTZ — set from the server
--      clock when the `posted` ack is applied. NULL for every row posted
--      before 0042 (no backfill: the true confirmation time is unknown).
--
-- The `not_posted` backfill for existing movements is the separate migration
-- 0043_inventory_effect_integration_backfill (the 0037/0038 split precedent):
-- this file holds its ACCESS EXCLUSIVE locks for DDL only.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS. Enumerated origin / event / state codes, opaque UUIDs, an
-- ERPNext document reference ({doctype, name} JSON text, as on
-- erpnext_posting_status.document_ref), timestamps and a bounded state reason.
-- No PII, no money. Retention inherits stock_movements' long-horizon,
-- insert-only posture; integration rows live as long as their effect.
--
-- Grants: none here. Production grants the domain role SELECT, INSERT and
-- UPDATE on inventory_effect_integration outside migrations:
-- docs/operations/sql/inventory-effect-integration-domain-grants.sql
-- (deploy/README.md step 2). The API refuses to boot without them
-- (DOMAIN_REQUIRED_GRANTS, apps/api/src/auth/database-pools.ts, RT-212).
-- Lock impact: the whole migration is ONE transaction, and every lock below
-- is held until its COMMIT (the 0036 precedent):
--   - stock_movements: ACCESS EXCLUSIVE for the ADD COLUMNs (nullable or
--     constant-default, metadata-only), the CHECKs and the self-FK (all added
--     NOT VALID: no scan; every existing row satisfies them by construction),
--     plus the two index builds (one pass over stock_movements each). Every
--     read and write of stock_movements waits until COMMIT.
--   - erpnext_posting_status: ACCESS EXCLUSIVE for one nullable ADD COLUMN and
--     a NOT VALID CHECK; SHARE ROW EXCLUSIVE for the new table's FK.
--   - inventory_effect_integration is created empty, so its FKs scan nothing.
-- Duration is dominated by the two stock_movements index builds. Run it in a
-- maintenance window (no inventory writes in flight); at pilot volume the
-- whole migration is expected to take well under a second.
-- Reversible via 0042_inventory_effects_journal.down.sql.

BEGIN;

-- =============================================================================
-- 1. stock_movements: origin, owning event, compensation, position placeholders
-- =============================================================================

ALTER TABLE stock_movements
  ADD COLUMN origin                TEXT NOT NULL DEFAULT 'retail',
  ADD COLUMN event_type            TEXT,
  ADD COLUMN event_ref_id          UUID,
  ADD COLUMN compensates_effect_id UUID,
  ADD COLUMN stock_location_id     UUID,
  ADD COLUMN inventory_status      TEXT,
  ADD COLUMN tracking_identity     TEXT;

ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_origin_allowed
    CHECK (origin IN ('retail', 'erp_external')) NOT VALID;

-- G2-1: Retail-origin and ERP-origin Business Event types.
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_event_type_allowed
    CHECK (event_type IS NULL OR event_type IN (
      'sale', 'sale_void', 'sale_return', 'transfer', 'count', 'adjustment',
      'erp_procurement_receipt', 'erp_manufacturing', 'erp_opening_stock',
      'erp_correction')) NOT VALID;

-- The owning event is identified by both columns or neither.
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_event_pair
    CHECK ((event_type IS NULL) = (event_ref_id IS NULL)) NOT VALID;

-- An event type belongs to exactly one origin (768, 905–913).
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_event_origin_consistent
    CHECK (event_type IS NULL
        OR (origin = 'retail') = (event_type IN (
             'sale', 'sale_void', 'sale_return', 'transfer', 'count', 'adjustment')))
    NOT VALID;

ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_compensates_not_self
    CHECK (compensates_effect_id IS NULL OR compensates_effect_id <> id) NOT VALID;

-- Composite target for the same-tenant FKs (effect -> compensated effect;
-- integration row -> effect).
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_id_tenant
  ON stock_movements (id, tenant_id);

-- NOT VALID: no validation scan. Every existing row has a NULL
-- compensates_effect_id (the column is new), so nothing is left unchecked;
-- every new row is still checked.
ALTER TABLE stock_movements
  ADD CONSTRAINT fk_stock_movements_compensates_tenant
    FOREIGN KEY (compensates_effect_id, tenant_id)
    REFERENCES stock_movements (id, tenant_id) ON DELETE RESTRICT
    NOT VALID;

-- Looks an event's effects up (RT-427 writes, RT-426 transitions).
CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant_event
  ON stock_movements (tenant_id, event_type, event_ref_id)
  WHERE event_type IS NOT NULL;

-- =============================================================================
-- 2. inventory_effect_integration — mutable per-effect integration state
-- =============================================================================

CREATE TABLE IF NOT EXISTS inventory_effect_integration (
  effect_id          UUID         PRIMARY KEY,
  tenant_id          UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  state              TEXT         NOT NULL,
  -- The ERP posting intent that represents this effect (pending onward).
  posting_status_id  UUID,
  -- The ERPNext document {doctype, name} JSON text, as erpnext_posting_status.
  erp_document_ref   TEXT,
  -- Server time of the `posted` ack that confirmed the effect (G2-4).
  erp_confirmed_at   TIMESTAMPTZ,
  -- Bounded machine/operator note on the last transition (no PII).
  state_reason       TEXT,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fk_inventory_effect_integration_effect_tenant
    FOREIGN KEY (effect_id, tenant_id)
    REFERENCES stock_movements (id, tenant_id) ON DELETE RESTRICT,
  -- 0037 created the (id, tenant_id) unique target on erpnext_posting_status.
  CONSTRAINT fk_inventory_effect_integration_posting_tenant
    FOREIGN KEY (posting_status_id, tenant_id)
    REFERENCES erpnext_posting_status (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_effect_integration_state_allowed
    CHECK (state IN ('not_posted', 'pending', 'confirmed', 'rejected',
                     'reconciliation_required', 'external')),
  -- An ERP intent exists exactly for the intent-bearing states; not_posted
  -- (no intent yet) and external (ERP-origin) carry none.
  CONSTRAINT inventory_effect_integration_intent_link
    CHECK ((posting_status_id IS NOT NULL) =
           (state IN ('pending', 'confirmed', 'rejected', 'reconciliation_required'))),
  -- Only a confirmed effect has a confirmation time, and it always has one.
  CONSTRAINT inventory_effect_integration_confirmed_at
    CHECK ((state = 'confirmed') = (erp_confirmed_at IS NOT NULL)),
  -- A confirmed effect names the ERP document that confirmed it.
  CONSTRAINT inventory_effect_integration_confirmed_document
    CHECK (state <> 'confirmed' OR erp_document_ref IS NOT NULL),
  CONSTRAINT inventory_effect_integration_not_posted_bare
    CHECK (state <> 'not_posted' OR erp_document_ref IS NULL),
  CONSTRAINT inventory_effect_integration_reason_length
    CHECK (state_reason IS NULL OR char_length(state_reason) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_inventory_effect_integration_tenant_state
  ON inventory_effect_integration (tenant_id, state);

CREATE INDEX IF NOT EXISTS idx_inventory_effect_integration_posting
  ON inventory_effect_integration (posting_status_id)
  WHERE posting_status_id IS NOT NULL;

ALTER TABLE inventory_effect_integration ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_effect_integration FORCE ROW LEVEL SECURITY;

CREATE POLICY inventory_effect_integration_tenant_read ON inventory_effect_integration
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY inventory_effect_integration_tenant_insert ON inventory_effect_integration
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- UPDATE: the integration state moves (RT-426). Both USING and WITH CHECK, so
-- a row can neither be reached nor re-homed across tenants. NO DELETE policy.
CREATE POLICY inventory_effect_integration_tenant_update ON inventory_effect_integration
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 3. erpnext_posting_status.posted_at — ERP confirmation time (G2-4)
-- =============================================================================

ALTER TABLE erpnext_posting_status
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ;

-- Only a posted row carries a confirmation time. Not the converse: rows posted
-- before 0042 keep a NULL posted_at.
ALTER TABLE erpnext_posting_status
  ADD CONSTRAINT erpnext_posting_status_posted_at_when_posted
    CHECK (posted_at IS NULL OR status = 'posted') NOT VALID;

COMMIT;
