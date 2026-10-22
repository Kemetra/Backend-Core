/**
 * RT-787 (RT-271 F-2) deployment flags for refund allocation and execution.
 * Both are off by default and read per request (the `isPosReturnsEnabled`
 * convention); each accepts "1", "true" or "yes", case-insensitive, trimmed.
 */
import { isEnvFlagOn } from "./sale-tenders-gate";

/**
 * R-7 settle before post (`pos-sales/sales.yaml` `recordReturn`, Posting).
 * Read at ACCEPTANCE only: a return accepted while it is on, with
 * `allocationRef` on its allocations and a non-zero total, is emitted by the
 * execution that settles it, whatever the flag says by then. Turn it on only
 * once every till sends `allocationRef` and reports its executions (F-5).
 */
export function isRefundSettleBeforePostEnabled(): boolean {
  return isEnvFlagOn("POS_REFUND_SETTLE_BEFORE_POST_ENABLED");
}

/**
 * R-11: the deprecated amount-only `recordRefund`. Off → 404 `not_found` and
 * nothing recorded, a provenance replay of an earlier refund included. No POS
 * calls it; a later breaking contract version removes the operation.
 */
export function isLegacyRefundEnabled(): boolean {
  return isEnvFlagOn("POS_LEGACY_REFUND_ENABLED");
}
