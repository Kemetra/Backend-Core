### Added
- RT-787 `[GATED]` migration `0067_refund_executions` + contract posture lift
  (RT-271 F-2; authorized in RT-787 comment 13359, PR + CI only): the runtime
  for the RT-490 refund contract (`pos-sales/sales.yaml` 1.13.0-draft).
  `recordReturn` accepts the optional allocation fields `allocationRef`,
  `originalTenderRef` and `instrument` (part of the replayed payload, R-3) and
  enforces the allocation rules: `allocationRef` on every allocation or none,
  an `originalTenderRef` must be a tender of the sale (400); a sale carrying
  a non-cash tender is 422 `refund_instrument_not_allowed` (R-12); the
  refundable balance of a referenced tender and of the sale's cash pool,
  legacy refunds included, is checked under the `sales` row lock, else 422
  `refund_allocation_exceeds_tender` (R-5); a tender-unknown sale is capped by
  the line cap only (R-6). `recordRefundExecution`, `readReturnByProvenance`
  and `listSaleReturns` ship and lose `x-runtime-status: contract-only`:
  append-only settled cash executions with provenance idempotency (409 on a
  changed payload or a reused `executionRef`), one `shiftRef` per return,
  422 `refund_execution_exceeds_allocation`, and the derived refund
  settlement (`open`, `partially_settled`, `settled`, or null when untracked).
  Two deploy flags, both off by default: `POS_REFUND_SETTLE_BEFORE_POST_ENABLED`
  (R-7: a return accepted with it on, `allocationRef` set and a non-zero
  total is posted once, by the execution that settles it, with
  `refundTenders` projected from its executions) and `POS_LEGACY_REFUND_ENABLED`
  (R-11: off, the deprecated `recordRefund` answers 404 and records nothing).
  The legacy refund now takes the `sales` row lock. Migration: nullable
  allocation columns on `sale_return_tenders` (no backfill),
  `sale_returns.posting_deferred`, and the append-only, RLS-forced
  `refund_executions`. Out of scope: the `closeShift` R-9 cross-check (F-3),
  the POS (F-5) and the Connector.
