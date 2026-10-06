/**
 * RT-17 slice 2b-2 — the closeShift refund-ref rule (RT-17 comment 10929,
 * P3-6; `pos-shifts.openapi.yaml` 1.1.0-draft, "Refund references"):
 * every ref must be a cash-refunded return of the caller's tenant and store
 * (the repository returns only those) not claimed by any shift's close, else
 * the one non-disclosing `refund_ref_invalid`; a valid ref refunded in
 * another currency is `currency_mismatch`. Invalid wins over mismatch.
 */
import type { RefundRefRow } from "../../src/pos-shifts/shift-cash-up.repository";
import { refundRefFailure } from "../../src/pos-shifts/shift-refund-refs";

const R1 = "0e170000-0000-4000-8000-0000000aee01";
const R2 = "0e170000-0000-4000-8000-0000000aee02";
const OTHER_SHIFT = "0e170000-0000-4000-8000-0000000a1001";

const row = (returnId: string, overrides: Partial<RefundRefRow> = {}): RefundRefRow => ({
  returnId,
  currencyCode: "EGP",
  hasCashRefund: true,
  claimedByShiftId: null,
  ...overrides,
});

/** The rows the repository found for `refs` (on an EGP shift). */
interface RefCase {
  readonly rows: RefundRefRow[];
  readonly refs: string[];
}

const failureOf = (c: RefCase) => refundRefFailure(c.rows, { refs: c.refs, currencyCode: "EGP" });

describe("refundRefFailure", () => {
  it.each<[string, RefCase, string | null]>([
    ["no refs", { rows: [], refs: [] }, null],
    ["two cash-refunded, unclaimed refs", { rows: [row(R1), row(R2)], refs: [R1, R2] }, null],
    ["an unknown or foreign ref (absent)", { rows: [row(R1)], refs: [R1, R2] }, "refund_ref_invalid"],
    ["a ref without a cash refund", { rows: [row(R1, { hasCashRefund: false })], refs: [R1] }, "refund_ref_invalid"],
    ["a ref claimed by another shift", { rows: [row(R1, { claimedByShiftId: OTHER_SHIFT })], refs: [R1] }, "refund_ref_invalid"],
    ["a ref refunded in USD", { rows: [row(R1, { currencyCode: "USD" })], refs: [R1] }, "currency_mismatch"],
    ["an invalid ref and a USD ref", { rows: [row(R1, { currencyCode: "USD" })], refs: [R1, R2] }, "refund_ref_invalid"],
    ["an invalid USD ref", { rows: [row(R1, { currencyCode: "USD", hasCashRefund: false })], refs: [R1] }, "refund_ref_invalid"],
  ])("%s → %s", (_label, c, failure) => {
    expect(failureOf(c)).toBe(failure);
  });
});
