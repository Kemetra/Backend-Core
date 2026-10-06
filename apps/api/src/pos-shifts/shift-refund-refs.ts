/**
 * The closeShift refund-ref rule (RT-17 slice 2b-2; RT-17 comment 10929,
 * P3-6; contract `pos-shifts.openapi.yaml` 1.1.0-draft, "Refund
 * references").
 *
 * `rows` are what `ShiftCashUpRepository.readRefundRefs` found for the refs
 * in the caller's tenant and store: an unknown, foreign or other-store ref is
 * simply absent. Each ref must be present, carry a cash refund tender and be
 * unclaimed (by ANY shift's close, of this device or another), else the one
 * non-disclosing 422 `refund_ref_invalid`: the answer never says which case,
 * and never names the claiming shift. Only then is a ref refunded in a
 * currency other than the shift's a 422 `currency_mismatch` (an invalid ref
 * never reveals its currency).
 */
import type { RefundRefRow } from "./shift-cash-up.repository";

export type RefundRefFailure = "refund_ref_invalid" | "currency_mismatch";

/** The refs a close claims and the currency of the shift it closes. */
export interface RefundClaim {
  readonly refs: ReadonlyArray<string>;
  readonly currencyCode: string;
}

function claimable(row: RefundRefRow | undefined): row is RefundRefRow {
  return row !== undefined && row.hasCashRefund && row.claimedByShiftId === null;
}

/** The refusal for a close's refund refs, or null when every ref is claimable. */
export function refundRefFailure(
  rows: ReadonlyArray<RefundRefRow>,
  claim: RefundClaim,
): RefundRefFailure | null {
  const byId = new Map(rows.map((row) => [row.returnId, row]));
  const resolved = claim.refs.map((ref) => byId.get(ref));
  if (!resolved.every(claimable)) return "refund_ref_invalid";
  return resolved.every((row) => row.currencyCode === claim.currencyCode) ? null : "currency_mismatch";
}
