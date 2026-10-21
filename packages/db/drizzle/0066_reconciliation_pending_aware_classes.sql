-- 0066_reconciliation_pending_aware_classes.sql
--
-- Pending-aware 017 stock reconciliation classes (Jira RT-428).
-- [GATED] migration — owner authorization recorded on RT-428 (comment 13281,
-- "for gating i approve all", 2026-10-21); class vocabulary owner-chosen
-- 2026-10-21 (Reconciliation 926–930, RT-290 Gate 4 comment 11726).
--
-- Widens erpnext_reconciliation_result_class_valid, additively, with:
--   - expected_pending_erp    (927) — the gap is explained by effects with an
--                                     ERP intent ERPNext has not booked as-is
--                                     (pending, rejected, reconciliation_required);
--   - expected_pending_retail (928) — explained by Retail effects with no ERP
--                                     intent yet (not_posted);
--   - erp_snapshot_stale      (929) — the Bin was read before an effect's
--                                     erp_confirmed_at;
--   - uom_mismatch                  — the operational unit differs from the
--                                     Bin stock UOM; never a quantity class (M-6).
-- `match` (926) and `quantity_divergence` (930) keep their names. Every
-- existing value stays allowed; no row changes.
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): no new column or table. The
-- class codes are enumerated business codes; no PII, no money.
--
-- Lock impact: the DROP + ADD ... NOT VALID take ACCESS EXCLUSIVE on
-- erpnext_reconciliation_result for a catalog-only change (no scan) and
-- commit at once. VALIDATE then scans the table under SHARE UPDATE EXCLUSIVE,
-- which does not block reads or writes. Every existing row satisfies the wider
-- CHECK by construction.
-- Reversible via 0066_reconciliation_pending_aware_classes.down.sql.

BEGIN;

ALTER TABLE erpnext_reconciliation_result
  DROP CONSTRAINT erpnext_reconciliation_result_class_valid;

ALTER TABLE erpnext_reconciliation_result
  ADD CONSTRAINT erpnext_reconciliation_result_class_valid
    CHECK (mismatch_class IN (
      'match', 'quantity_divergence', 'unmapped_store', 'unmapped_item',
      'dp2_only', 'erpnext_only', 'negative_balance_flagged',
      'expected_pending_erp', 'expected_pending_retail', 'erp_snapshot_stale',
      'uom_mismatch'
    )) NOT VALID;

COMMIT;

ALTER TABLE erpnext_reconciliation_result
  VALIDATE CONSTRAINT erpnext_reconciliation_result_class_valid;
