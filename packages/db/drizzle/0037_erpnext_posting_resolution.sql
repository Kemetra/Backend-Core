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
--   3. Backfill: every intent whose lines all resolve from the CURRENT maps
--      (confirmed, non-retired item map per line + the store's active 'stock'
--      warehouse map) gets version 1 with resolved_by = 'backfill'.
--
-- RLS AND THE BACKFILL: every table read here is FORCE ROW LEVEL SECURITY with
-- tenant-GUC policies. The backfill loops over tenants (readable under
-- app.is_platform_admin, which tenants_tenant_isolation honours) and sets
-- app.current_tenant per tenant, so it runs under the existing policies
-- without lifting FORCE on any table. Explicit tenant predicates keep the
-- result identical when the migration runs as a superuser.
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS-CLASS. ERP item and
-- warehouse references, map ids, an actor class and a timestamp. No PII, no
-- money. Retention follows erpnext_posting_status.
-- Grants: none here — production grants the domain role SELECT + INSERT on the
-- new table outside migrations (see 0006).
-- Lock duration: erpnext_posting_status takes ACCESS EXCLUSIVE briefly for the
-- ADD COLUMN; the backfill then updates matching rows under RLS.
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

-- =============================================================================
-- 3. Backfill version 1 from the current maps, tenant by tenant under RLS
-- =============================================================================

DO $$
DECLARE
  t uuid;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);

    INSERT INTO erpnext_posting_resolution
      (tenant_id, intent_id, resolution_version, sale_line_id,
       erpnext_item_ref, item_map_id, warehouse_ref, warehouse_map_id, resolved_by)
    SELECT ps.tenant_id, ps.id, 1, sl.id,
           m.erpnext_item_ref, m.id, w.erpnext_warehouse_ref, w.id, 'backfill'
      FROM erpnext_posting_status ps
      JOIN erpnext_warehouse_map w
        ON w.tenant_id = ps.tenant_id AND w.store_id = ps.store_id
       AND w.purpose = 'stock' AND w.retired_at IS NULL
      JOIN sale_lines sl
        ON sl.tenant_id = ps.tenant_id AND sl.sale_id = ps.sale_id
      JOIN erpnext_item_map m
        ON m.tenant_id = ps.tenant_id AND m.tenant_product_id = sl.tenant_product_ref
       AND m.state = 'confirmed' AND m.retired_at IS NULL
     WHERE ps.tenant_id = t
       AND ps.current_resolution_version IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM sale_lines ul
           LEFT JOIN erpnext_item_map um
             ON um.tenant_id = ul.tenant_id AND um.tenant_product_id = ul.tenant_product_ref
            AND um.state = 'confirmed' AND um.retired_at IS NULL
          WHERE ul.tenant_id = ps.tenant_id AND ul.sale_id = ps.sale_id
            AND (ul.tenant_product_ref IS NULL OR um.id IS NULL));

    UPDATE erpnext_posting_status ps
       SET current_resolution_version = 1
     WHERE ps.tenant_id = t
       AND ps.current_resolution_version IS NULL
       AND EXISTS (
         SELECT 1 FROM erpnext_posting_resolution r
          WHERE r.intent_id = ps.id AND r.resolution_version = 1);
  END LOOP;
END
$$;

COMMIT;
