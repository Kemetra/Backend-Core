### Added
- RT-490 `[GATED]`, owner authorization 2026-10-21 (RT-271 F-1, decisions
  R-1 to R-12): contract-only refund allocation, refund execution and return
  reads. `pos-sales/sales.yaml` 1.13.0-draft re-describes `RefundTender` as a
  refund allocation with optional `allocationRef`, `originalTenderRef` and
  `instrument` (cash), and states the instrument and cumulative
  refundable-balance rules on `recordReturn` (422
  `refund_instrument_not_allowed`, `refund_allocation_exceeds_tender`; the 422
  response is renamed `ReturnUnprocessable`). It adds `recordRefundExecution`,
  `readReturnByProvenance` and `listSaleReturns` (all contract-only until F-2)
  and documents the legacy `recordRefund` as gated off from F-4.
  `erpnext-connector/posting-feed.yaml` 1.9.0-draft states settle-before-post
  for returns behind a deploy flag, with no schema change. `pos-shifts.openapi.yaml`
  1.3.0-draft adds the R-9 close cross-check (422 `refund_ref_unsettled`,
  `cash_refunds_total_mismatch`) from F-3. Ref-less return bodies stay valid.
  No runtime, migration, Connector or POS change.
