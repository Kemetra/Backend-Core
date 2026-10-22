-- 0072_inventory_safety.sql
--
-- Tracking holds, recall, identity expiry correction and the Inventory Safety
-- Revision, additive (Jira RT-449, RT-50 Gate 7 follow-up F2).
-- [GATED] migration — owner-authorized on RT-449 (comment 13434, 2026-10-22:
-- the shape of comment 13432 and rulings H1–H8 approved as proposed; PR + CI
-- only, never applied to a lab or live database by that approval).
--
-- Source-of-truth decisions (RT-50 comments 11763 / 11764, owner decision
-- 11765; Confluence RETAIL "Inventory Operations" baseline, "Gate 7"):
--   - G7-6 / 739, 740, 860–863, 965: a Tracking Hold is a record on an
--     identity (kind quality_hold | recall_hold, reason code, placed by/at,
--     released by/at). A Recall is an Inventory safety Business Event (tenant,
--     reason / reference, product, listed identities, effective_at) that
--     creates a recall_hold on each listed identity; it never retires the
--     product (861).
--   - G7-7 / 864, 865: a per-tenant monotonic safety revision, incremented in
--     the same transaction as a hold / recall placement or release, an
--     identity expiry correction or a tracking-profile change. The change log
--     is what the POS `inventory-safety` feed's delta reads (RT-449 PR 2).
--   - G7-2: an identity's kind, code and product are immutable; an
--     `expiry_date` correction is a governed safety event with history, never
--     a silent UPDATE.
--   - Q8 / H8: the tenant's Safety TTL, default 15 minutes, configurable
--     downwards only.
--   - H4: a recall hold's quantity leaves only through the Gate 8 disposition
--     (RT-293); releasing the record moves nothing.
--
-- Changes, in order:
--   1. tenant_inventory_safety_revisions — one row per tenant holding its
--      current revision (> 0, never decreasing; a guard trigger). Writers
--      bump it with an upsert whose row lock is held until commit, so commit
--      order equals revision order. SELECT, INSERT and UPDATE tenant
--      policies; NO DELETE policy.
--   2. inventory_recalls — the recall event record. Append-only (SELECT +
--      INSERT policies only). Its replay fingerprint is UNIQUE per tenant.
--   3. tracking_holds — the hold record. The identity is an identity of the
--      hold's own product (the 0045 composite target); a recall hold names
--      its recall, of the same product. At most one ACTIVE hold per
--      (identity, kind). SELECT, INSERT and UPDATE tenant policies; a guard
--      trigger (an allowlist) lets an UPDATE only set the release
--      (released_by, released_at, release_note), once: a released hold is
--      final.
--   4. tracking_identity_expiry_corrections — the history of every expiry
--      correction (old, new, reason, actor). Append-only.
--   5. inventory_safety_changes — one change per (tenant, revision): its
--      kind and the hold / recall / identity it names. Append-only.
--   6. tracking_identities — an UPDATE tenant policy (the expiry
--      correction), and 0045's guard function replaced by an allowlist:
--      only `expiry_date` (and `updated_at`) may change — `manufactured_on`
--      and any later column included — and an `expiry_date` change is refused
--      unless its correction row (same old and new date) was written in the
--      same transaction. The history requirement holds for every writer.
--   7. tenant_inventory_settings.safety_ttl_seconds — NULL (the 900-second
--      default) or 60–900.
--
-- Nothing here changes stock_movements, inventory_effect_integration or
-- inventory_position_events: a hold's quantity moves are RT-435 status moves
-- (0056) carrying the identity, with the reserved reason codes `quality_hold`
-- and `recall` that 0056's CHECK already admits.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS. Opaque UUIDs, enumerated kinds, machine reason codes, an
-- authority reference (a notice number; no PII by policy), bounded operator
-- notes (no PII by policy, as stock_movements.reason), dates, a revision
-- counter, SHA-256 hex fingerprints (never the raw Idempotency-Key) and
-- timestamps. No money. Recall, hold, correction and change records live as
-- long as the identities they name (the inventory long-horizon,
-- insert-only posture).
--
-- Grants: none here. Production grants the domain role, outside migrations:
-- docs/operations/sql/inventory-safety-domain-grants.sql (deploy/README.md
-- step 2). The API refuses to boot without them (DOMAIN_REQUIRED_GRANTS,
-- apps/api/src/auth/database-pools.ts, RT-212).
--
-- Deploy window: none. Every table is new, the TTL column is nullable with no
-- default (no rewrite), and only the new routes write them; the previous
-- release keeps working. Apply 0072 and the grants script before the API
-- that uses them rolls out.
--
-- Lock impact: ONE transaction. The new tables are created empty. The FKs
-- take SHARE ROW EXCLUSIVE on tenants, tenant_products and
-- tracking_identities while the migration commits. CREATE POLICY on
-- tracking_identities and ADD COLUMN / ADD CONSTRAINT on
-- tenant_inventory_settings take ACCESS EXCLUSIVE briefly; both tables are
-- small (nothing writes tracking_identities yet; one settings row per
-- tenant). CREATE OR REPLACE FUNCTION takes no table lock. At pilot volume
-- the migration takes well under a second.
-- Reversible via 0072_inventory_safety.down.sql (refuses while safety data
-- exists).

BEGIN;

-- =============================================================================
-- 1. tenant_inventory_safety_revisions
-- =============================================================================

CREATE TABLE IF NOT EXISTS tenant_inventory_safety_revisions (
  tenant_id   UUID         PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  -- The tenant's current Inventory Safety Revision (G7-7). A tenant with no
  -- row is at revision 0.
  revision    BIGINT       NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tenant_inventory_safety_revisions_positive
    CHECK (revision > 0)
);

CREATE TRIGGER tenant_inventory_safety_revisions_set_updated_at
  BEFORE UPDATE ON tenant_inventory_safety_revisions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- G7-7: monotonic. A revision only ever moves forward, for every role.
CREATE OR REPLACE FUNCTION tenant_inventory_safety_revisions_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION
      'tenant_inventory_safety_revisions %: the revision only moves forward', OLD.tenant_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_inventory_safety_revisions_guard
  BEFORE UPDATE ON tenant_inventory_safety_revisions
  FOR EACH ROW EXECUTE FUNCTION tenant_inventory_safety_revisions_guard();

ALTER TABLE tenant_inventory_safety_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_inventory_safety_revisions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_inventory_safety_revisions_tenant_read ON tenant_inventory_safety_revisions
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY tenant_inventory_safety_revisions_tenant_insert ON tenant_inventory_safety_revisions
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- UPDATE: the bump. Both USING and WITH CHECK; NO DELETE policy.
CREATE POLICY tenant_inventory_safety_revisions_tenant_update ON tenant_inventory_safety_revisions
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
-- 2. inventory_recalls
-- =============================================================================

CREATE TABLE IF NOT EXISTS inventory_recalls (
  id                   UUID         PRIMARY KEY,
  tenant_id            UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tenant_product_ref   UUID         NOT NULL,
  -- A machine reason code (e.g. `authority_notice`, `supplier_notice`).
  reason_code          TEXT         NOT NULL,
  -- The external reference, e.g. an authority notice number.
  reference            TEXT         NOT NULL,
  note                 TEXT,
  effective_at         TIMESTAMPTZ  NOT NULL,
  -- SHA-256 hex of the command's replay identity (never the raw key).
  command_fingerprint  TEXT         NOT NULL,
  created_by           UUID         NOT NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fk_inventory_recalls_product_tenant
    FOREIGN KEY (tenant_product_ref, tenant_id)
    REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_recalls_reason_code_shape
    CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT inventory_recalls_reference_shape
    CHECK (char_length(reference) BETWEEN 1 AND 200 AND reference = btrim(reference)),
  CONSTRAINT inventory_recalls_note_length
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  CONSTRAINT inventory_recalls_fingerprint_shape
    CHECK (command_fingerprint ~ '^[0-9a-f]{64}$')
);

-- DB-level replay: one recall per command per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_recalls_tenant_fingerprint
  ON inventory_recalls (tenant_id, command_fingerprint);

-- Composite targets: a hold's recall is of the hold's product and tenant; a
-- change's recall is of the change's tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_recalls_id_product_tenant
  ON inventory_recalls (id, tenant_product_ref, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_recalls_id_tenant
  ON inventory_recalls (id, tenant_id);

ALTER TABLE inventory_recalls ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_recalls FORCE ROW LEVEL SECURITY;

CREATE POLICY inventory_recalls_tenant_read ON inventory_recalls
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT only: a recall record is never changed or removed.
CREATE POLICY inventory_recalls_tenant_insert ON inventory_recalls
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 3. tracking_holds
-- =============================================================================

CREATE TABLE IF NOT EXISTS tracking_holds (
  id                    UUID         PRIMARY KEY,
  tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tracking_identity_id  UUID         NOT NULL,
  tenant_product_ref    UUID         NOT NULL,
  kind                  TEXT         NOT NULL,
  reason_code           TEXT         NOT NULL,
  note                  TEXT,
  -- The recall that placed a recall hold; NULL for a quality hold.
  recall_id             UUID,
  -- SHA-256 hex of the placing command (a quality hold); NULL for a recall
  -- hold, whose replay identity is its recall's.
  command_fingerprint   TEXT,
  placed_by             UUID         NOT NULL,
  placed_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  released_by           UUID,
  released_at           TIMESTAMPTZ,
  release_note          TEXT,
  -- 0045's composite target: an identity of the hold's own product.
  CONSTRAINT fk_tracking_holds_identity
    FOREIGN KEY (tracking_identity_id, tenant_product_ref, tenant_id)
    REFERENCES tracking_identities (id, tenant_product_ref, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_tracking_holds_recall
    FOREIGN KEY (recall_id, tenant_product_ref, tenant_id)
    REFERENCES inventory_recalls (id, tenant_product_ref, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT tracking_holds_kind_allowed
    CHECK (kind IN ('quality_hold', 'recall_hold')),
  -- G7-6: a recall hold is placed by a recall; a quality hold never is.
  CONSTRAINT tracking_holds_recall_iff_recall_hold
    CHECK ((kind = 'recall_hold') = (recall_id IS NOT NULL)),
  CONSTRAINT tracking_holds_release_paired
    CHECK ((released_by IS NULL) = (released_at IS NULL)),
  CONSTRAINT tracking_holds_release_note_when_released
    CHECK (release_note IS NULL
        OR (released_at IS NOT NULL AND char_length(release_note) BETWEEN 1 AND 500)),
  CONSTRAINT tracking_holds_reason_code_shape
    CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT tracking_holds_note_length
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  CONSTRAINT tracking_holds_fingerprint_shape
    CHECK (command_fingerprint IS NULL OR command_fingerprint ~ '^[0-9a-f]{64}$')
);

-- At most one ACTIVE hold per (identity, kind); a released one leaves room.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracking_holds_active_identity_kind
  ON tracking_holds (tenant_id, tracking_identity_id, kind)
  WHERE released_at IS NULL;

-- DB-level replay of a quality-hold placement (NULLs are distinct).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracking_holds_tenant_fingerprint
  ON tracking_holds (tenant_id, command_fingerprint);

-- Composite target for the change log.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracking_holds_id_tenant
  ON tracking_holds (id, tenant_id);

CREATE INDEX IF NOT EXISTS idx_tracking_holds_recall
  ON tracking_holds (recall_id)
  WHERE recall_id IS NOT NULL;

-- A hold's placement is immutable; its release is set once and is final.
CREATE OR REPLACE FUNCTION tracking_holds_guard_release()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'tracking_holds %: a released hold is final', OLD.id
      USING ERRCODE = '23514';
  END IF;
  -- An allowlist: every column but the three release columns, including any
  -- column added later, must stay as it was.
  IF (to_jsonb(NEW) - 'released_by' - 'released_at' - 'release_note')
     IS DISTINCT FROM (to_jsonb(OLD) - 'released_by' - 'released_at' - 'release_note') THEN
    RAISE EXCEPTION 'tracking_holds %: only the release may be set', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tracking_holds_guard_release
  BEFORE UPDATE ON tracking_holds
  FOR EACH ROW EXECUTE FUNCTION tracking_holds_guard_release();

ALTER TABLE tracking_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_holds FORCE ROW LEVEL SECURITY;

CREATE POLICY tracking_holds_tenant_read ON tracking_holds
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY tracking_holds_tenant_insert ON tracking_holds
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- UPDATE: the release (the guard trigger fences the columns). Both USING and
-- WITH CHECK; NO DELETE policy.
CREATE POLICY tracking_holds_tenant_update ON tracking_holds
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
-- 4. tracking_identity_expiry_corrections
-- =============================================================================

CREATE TABLE IF NOT EXISTS tracking_identity_expiry_corrections (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tracking_identity_id  UUID         NOT NULL,
  tenant_product_ref    UUID         NOT NULL,
  old_expiry_date       DATE,
  new_expiry_date       DATE,
  reason_code           TEXT         NOT NULL,
  note                  TEXT,
  command_fingerprint   TEXT         NOT NULL,
  created_by            UUID         NOT NULL,
  -- The transaction's start time: the identity guard matches a correction
  -- written in the same transaction by it.
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fk_tracking_identity_expiry_corrections_identity
    FOREIGN KEY (tracking_identity_id, tenant_product_ref, tenant_id)
    REFERENCES tracking_identities (id, tenant_product_ref, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT tracking_identity_expiry_corrections_changes
    CHECK (old_expiry_date IS DISTINCT FROM new_expiry_date),
  -- The 0045 date range.
  CONSTRAINT tracking_identity_expiry_corrections_dates_in_range
    CHECK ((old_expiry_date IS NULL OR old_expiry_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
       AND (new_expiry_date IS NULL OR new_expiry_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')),
  CONSTRAINT tracking_identity_expiry_corrections_reason_code_shape
    CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT tracking_identity_expiry_corrections_note_length
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  CONSTRAINT tracking_identity_expiry_corrections_fingerprint_shape
    CHECK (command_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tracking_identity_expiry_corrections_tenant_fingerprint
  ON tracking_identity_expiry_corrections (tenant_id, command_fingerprint);

-- The identity's history, and the guard's same-transaction lookup.
CREATE INDEX IF NOT EXISTS idx_tracking_identity_expiry_corrections_identity
  ON tracking_identity_expiry_corrections (tracking_identity_id, created_at);

ALTER TABLE tracking_identity_expiry_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_identity_expiry_corrections FORCE ROW LEVEL SECURITY;

CREATE POLICY tracking_identity_expiry_corrections_tenant_read ON tracking_identity_expiry_corrections
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT only: the history is never changed or removed.
CREATE POLICY tracking_identity_expiry_corrections_tenant_insert ON tracking_identity_expiry_corrections
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 5. inventory_safety_changes
-- =============================================================================

CREATE TABLE IF NOT EXISTS inventory_safety_changes (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- The revision this change produced (G7-7): exactly one change per step.
  revision              BIGINT       NOT NULL,
  kind                  TEXT         NOT NULL,
  tracking_hold_id      UUID,
  inventory_recall_id   UUID,
  tracking_identity_id  UUID,
  tenant_product_ref    UUID         NOT NULL,
  created_by            UUID         NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fk_inventory_safety_changes_product_tenant
    FOREIGN KEY (tenant_product_ref, tenant_id)
    REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_safety_changes_hold
    FOREIGN KEY (tracking_hold_id, tenant_id)
    REFERENCES tracking_holds (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_safety_changes_recall
    FOREIGN KEY (inventory_recall_id, tenant_id)
    REFERENCES inventory_recalls (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_safety_changes_identity
    FOREIGN KEY (tracking_identity_id, tenant_product_ref, tenant_id)
    REFERENCES tracking_identities (id, tenant_product_ref, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_safety_changes_revision_positive
    CHECK (revision > 0),
  CONSTRAINT inventory_safety_changes_kind_allowed
    CHECK (kind IN ('hold_placed', 'hold_released', 'recall_created', 'expiry_corrected',
                    'tracking_profile_changed')),
  -- Each kind names what it changed.
  CONSTRAINT inventory_safety_changes_hold_refs
    CHECK (kind NOT IN ('hold_placed', 'hold_released')
        OR (tracking_hold_id IS NOT NULL AND tracking_identity_id IS NOT NULL)),
  CONSTRAINT inventory_safety_changes_recall_refs
    CHECK (kind <> 'recall_created' OR inventory_recall_id IS NOT NULL),
  CONSTRAINT inventory_safety_changes_expiry_refs
    CHECK (kind <> 'expiry_corrected' OR tracking_identity_id IS NOT NULL)
);

-- One change per revision step; also the feed delta's keyset (revision > n).
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_safety_changes_tenant_revision
  ON inventory_safety_changes (tenant_id, revision);

ALTER TABLE inventory_safety_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_safety_changes FORCE ROW LEVEL SECURITY;

CREATE POLICY inventory_safety_changes_tenant_read ON inventory_safety_changes
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT only: the change log is never changed or removed.
CREATE POLICY inventory_safety_changes_tenant_insert ON inventory_safety_changes
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 6. tracking_identities: the expiry correction
-- =============================================================================

-- UPDATE: the expiry correction. Both USING and WITH CHECK; NO DELETE policy.
-- The guard below fences the columns and requires the history row.
CREATE POLICY tracking_identities_tenant_update ON tracking_identities
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- Replaces the 0045 body (the down migration restores it). An identity keeps
-- meaning what it meant (G7-2), for every role: an ALLOWLIST lets only
-- `expiry_date` (and `updated_at`, which its trigger maintains) change — every
-- other column, including any added later, must stay as it was — and an
-- expiry change needs its correction row from this same transaction (never a
-- silent UPDATE).
CREATE OR REPLACE FUNCTION tracking_identities_guard_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'expiry_date' - 'updated_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'expiry_date' - 'updated_at') THEN
    RAISE EXCEPTION
      'tracking_identities % : only expiry_date may change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.expiry_date IS DISTINCT FROM OLD.expiry_date
     AND NOT EXISTS (
       SELECT 1 FROM tracking_identity_expiry_corrections c
        WHERE c.tracking_identity_id = OLD.id
          AND c.tenant_id = OLD.tenant_id
          AND c.old_expiry_date IS NOT DISTINCT FROM OLD.expiry_date
          AND c.new_expiry_date IS NOT DISTINCT FROM NEW.expiry_date
          AND c.created_at = now()) THEN
    RAISE EXCEPTION
      'tracking_identities % : an expiry change needs its correction record in the same transaction', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- =============================================================================
-- 7. tenant_inventory_settings.safety_ttl_seconds (Q8 / H8)
-- =============================================================================

-- NULL: the 900-second (15 minute) default. Configurable downwards only.
ALTER TABLE tenant_inventory_settings
  ADD COLUMN IF NOT EXISTS safety_ttl_seconds INTEGER;

ALTER TABLE tenant_inventory_settings
  ADD CONSTRAINT tenant_inventory_settings_safety_ttl_range
    CHECK (safety_ttl_seconds IS NULL OR safety_ttl_seconds BETWEEN 60 AND 900);

COMMIT;
