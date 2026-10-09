-- 0037_erpnext_posting_resolution.sql
--
-- Frozen ERP resolution for posting intents (Jira RT-330, RT-326 phase 1a).
-- [GATED] migration — owner-authorized in-session on 2026-10-09 ("automate all
-- mission ... delegate and authorize you"; "complete the pathway until i stop
-- you"), recorded on RT-326 comment 11290 and in RT-330.
-- Authority: ERP Integration & Sync Operations baseline (Confluence RETAIL
-- 25264129): "each durable posting intent carries or references an immutable
-- resolved integration context"; "mapping changes after intent creation do not
-- silently retarget the old intent".
--
-- Problem (RT-316 V1, reproduced on the rt9 lab): the posting feed re-joined the
-- LIVE erpnext_item_map at pull time. Retiring a confirmed map made the feed
-- omit a pending intent while the cursor moved past it (stranded); re-pointing
-- the product made the feed emit the intent with the NEW ERP item (retarget).
--
-- Changes, in order:
--   1. erpnext_posting_resolution — append-only, one row per (intent,
--      resolution_version, sale line): the frozen ERP item ref and warehouse
--      ref, the ids of the maps they came from, who resolved them and when.
--      INSERT + SELECT policies only (no UPDATE / DELETE): a correction is a
--      new resolution_version, never an edit.
--   2. erpnext_posting_status.current_resolution_version — the version the
--      feed reads. NULL = no frozen resolution (pre-0037 rows that could not
--      be resolved by the backfill); the feed keeps its pre-0037 live join for
--      those rows only.
--   3. The backfill of existing intents is a SEPARATE migration
--      (0038_erpnext_posting_resolution_backfill). This one holds its locks on
--      erpnext_posting_status only for the DDL below; the bulk scan runs after
--      this COMMIT, with row-level locks only (RT-330 review).
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS-CLASS. ERP item and
-- warehouse references, map ids, an actor class and a timestamp. No PII, no
-- money. Retention follows erpnext_posting_status.
-- Grants: none here — production grants the domain role SELECT + INSERT on the
-- new table outside migrations (see 0006).
-- Lock duration: erpnext_posting_status takes ACCESS EXCLUSIVE (ADD COLUMN,
-- ADD CONSTRAINT), SHARE (the unique index build) and SHARE ROW EXCLUSIVE (the
-- new FK) until this file's COMMIT. Nothing else runs in this transaction, so
-- the hold is the DDL time plus one index build over erpnext_posting_status.
-- Reversible via 0037_erpnext_posting_resolution.down.sql.

BEGIN;

-- =============================================================================
-- 1. erpnext_posting_resolution
-- =============================================================================

-- Composite target so a resolution can only name an intent of the SAME tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_idx_erpnext_posting_status_id_tenant"
  ON erpnext_posting_status (id, tenant_id);

CREATE TABLE IF NOT EXISTS erpnext_posting_resolution (
  tenant_id          UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  intent_id          UUID         NOT NULL,
  resolution_version INTEGER      NOT NULL,
  sale_line_id       UUID         NOT NULL REFERENCES sale_lines(id) ON DELETE RESTRICT,
  erpnext_item_ref   TEXT         NOT NULL,
  item_map_id        UUID         NOT NULL,
  warehouse_ref      TEXT         NOT NULL,
  warehouse_map_id   UUID         NOT NULL,
  resolved_by        TEXT         NOT NULL,
  resolved_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pk_erpnext_posting_resolution
    PRIMARY KEY (intent_id, resolution_version, sale_line_id),
  CONSTRAINT fk_erpnext_posting_resolution_intent_tenant
    FOREIGN KEY (intent_id, tenant_id)
    REFERENCES erpnext_posting_status (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT erpnext_posting_resolution_version_positive
    CHECK (resolution_version >= 1),
  CONSTRAINT erpnext_posting_resolution_item_ref_nonempty
    CHECK (length(erpnext_item_ref) > 0),
  CONSTRAINT erpnext_posting_resolution_warehouse_ref_nonempty
    CHECK (length(warehouse_ref) > 0),
  CONSTRAINT erpnext_posting_resolution_resolved_by_valid
    CHECK (resolved_by IN ('system', 'operator', 'backfill'))
);

CREATE INDEX IF NOT EXISTS idx_erpnext_posting_resolution_tenant
  ON erpnext_posting_resolution (tenant_id);

ALTER TABLE erpnext_posting_resolution ENABLE ROW LEVEL SECURITY;
ALTER TABLE erpnext_posting_resolution FORCE ROW LEVEL SECURITY;

CREATE POLICY erpnext_posting_resolution_tenant_read ON erpnext_posting_resolution
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT-only: append-only resolution history (no UPDATE / DELETE policy).
CREATE POLICY erpnext_posting_resolution_tenant_insert ON erpnext_posting_resolution
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 2. erpnext_posting_status.current_resolution_version
-- =============================================================================

ALTER TABLE erpnext_posting_status
  ADD COLUMN IF NOT EXISTS current_resolution_version INTEGER;

ALTER TABLE erpnext_posting_status
  ADD CONSTRAINT erpnext_posting_status_resolution_version_positive
    CHECK (current_resolution_version IS NULL OR current_resolution_version >= 1);

COMMIT;
