### Added
- RT-577 `[GATED]` migration `0054_sale_credit_reversals` + contract posture
  lift, pending owner approval: credit-sale reversals
  (`pos-sales/sales.yaml` 1.11.0-draft; owner V1 decision and rulings D6 /
  D7 / D8, 2026-10-17). `recordVoid`, `recordReturn` and `recordRefund`
  refuse a sale with payer responsibilities for every operator (403
  `credit_sale_reversal_restricted`, after the sale and a provenance replay;
  nothing recorded). `recordCreditSaleReversal`
  (`POST /api/pos/v1/sales/{saleRef}/credit-reversals`) ships and loses
  `x-runtime-status: contract-only`: Manager/Admin only (live standing), RT-530
  for a void, a pro-rata floor allocation in exact minor units (D7), payer
  settlement, a second approval for a cash-paying return (D6), mirrored void
  tenders and cash-only returns (D8); fail-closed 422s write nothing. The
  reversal reuses the `sale_voids` / `sale_returns` row (the posting feed's
  hold on credit-sale reversals is unchanged). Migration: append-only,
  RLS-forced `sale_credit_reversals`, `sale_credit_reversal_tenders` and the
  shared single-use ledger `sale_approval_uses` (backfilled per tenant, kept
  filled for voids by the `SECURITY DEFINER` trigger
  `sale_voids_record_approval_use`). Deploy: run
  `docs/operations/sql/sale-credit-reversals-domain-grants.sql` after
  `migrate up` (`DOMAIN_REQUIRED_GRANTS` now lists the three tables, SELECT /
  INSERT).
