-- 0038_erpnext_posting_resolution_backfill.sql
--
-- Backfill for 0037_erpnext_posting_resolution (Jira RT-330). [GATED] under the
-- same owner authorization as 0037 (RT-326 comment 11290, RT-330).
--
-- Split from 0037 (RT-330 review): 0037's DDL takes ACCESS EXCLUSIVE on
-- erpnext_posting_status, held until its COMMIT. Running the bulk scan in its
-- own migration means it takes only row-level locks: plain reads of
-- erpnext_posting_status are never blocked, and a write waits only on a row
-- this backfill is updating.
--
-- Every intent whose lines all resolve from the CURRENT maps (a confirmed,
-- non-retired item map per line and the store's active 'stock' warehouse map)
-- gets resolution version 1 with resolved_by = 'backfill'. Intents that do not
-- resolve keep a NULL version, and the feed keeps the pre-0037 live join for
-- them only. Idempotent: rows that already carry a version are skipped.
--
-- RLS: every table read here is FORCE ROW LEVEL SECURITY with tenant-GUC
-- policies. The loop reads tenants under app.is_platform_admin (which
-- tenants_tenant_isolation honours) and sets app.current_tenant per tenant, so
-- the backfill runs under the existing policies without lifting FORCE on any
-- table. Explicit tenant predicates keep the result identical when the
-- migration runs as a superuser.
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): unchanged from 0037.
-- Reversible via 0038_erpnext_posting_resolution_backfill.down.sql (a no-op:
-- the backfilled rows are kept; 0037's down drops the table).

BEGIN;

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
