### Added
- RT-428 `[GATED]`, owner authorization 2026-10-21 (RT-428 comment 13281;
  applying to the lab or a live database is not authorized): the 017 stock
  reconciliation compares like with like (RT-289 DC-7). For a tenant with
  activated sale effects, the expected ERP book per (store, product) is the
  RT-427 anchor plus the effects since it, minus the pending-ERP terms
  (`pending`, `rejected`, `reconciliation_required`) and the pending-Retail
  term (`not_posted`). It is compared with the run's Bin view. New result
  classes (owner-chosen vocabulary, decisions 926–930):
  `expected_pending_erp`, `expected_pending_retail`, `erp_snapshot_stale`
  (the Bin was read before an effect's `erp_confirmed_at`) and `uom_mismatch`.
  `match` and `quantity_divergence` keep their names, and each result's detail
  carries the DC-7 terms. Migration 0066 widens the result-class CHECK
  (catalog-only, then VALIDATE; down refuses while a new-class result exists).
  Tenants without activated sale effects keep the legacy raw-SUM comparison
  unchanged. New read-only `inventory-effects equivalence --tenant <uuid>` CLI:
  the dual-read cutover report (977, 980), legacy vs pending-aware against the
  latest Bin. Reconciliation never writes an effect, an integration row or ERP
  stock.
