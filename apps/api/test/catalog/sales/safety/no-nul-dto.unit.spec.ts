/**
 * RT-612: a NUL byte in a stored text field is a 400 at the DTO, never a
 * Postgres 22021 (which the global filter now also maps to 400 as a backstop).
 */
import { CaptureSaleRequestSchema } from "../../../../src/catalog/sales/dto/capture-sale-request.dto";
import { RecordRefundRequestSchema } from "../../../../src/catalog/sales/dto/record-refund-request.dto";
import { RecordReturnRequestSchema } from "../../../../src/catalog/sales/dto/record-return-request.dto";
import { RecordVoidRequestSchema } from "../../../../src/catalog/sales/dto/record-void-request.dto";

const NUL = "a\u0000b";
const UUID = "11111111-1111-4111-8111-111111111111";

const void_ok = { sourceSystem: "pos", externalId: "v-1" };
const refund_ok = { sourceSystem: "pos", externalId: "r-1", posRefundAmount: "1.00", currencyCode: "EGP" };
const return_ok = {
  sourceSystem: "pos",
  externalId: "t-1",
  lines: [{ lineRef: UUID, quantity: "1" }],
  refundTenders: [{ method: "cash", amount: "1.00" }],
};
const approval_ok = {
  approvalId: UUID,
  action: "sale.void",
  saleRef: UUID,
  amount: "1.00",
  requesterUserId: UUID,
  approverUserId: UUID,
  policyVersion: "v1",
  approvedAt: "2026-01-01T00:00:00Z",
};

describe("RT-612 NUL rejection in POS sale DTOs", () => {
  it("accepts the NUL-free baselines", () => {
    expect(RecordVoidRequestSchema.safeParse({ ...void_ok, approval: approval_ok }).success).toBe(true);
    expect(RecordRefundRequestSchema.safeParse(refund_ok).success).toBe(true);
    expect(RecordReturnRequestSchema.safeParse(return_ok).success).toBe(true);
  });

  it.each([
    ["void sourceSystem", () => RecordVoidRequestSchema.safeParse({ ...void_ok, sourceSystem: NUL })],
    ["void externalId", () => RecordVoidRequestSchema.safeParse({ ...void_ok, externalId: NUL })],
    ["void approval.action", () => RecordVoidRequestSchema.safeParse({ ...void_ok, approval: { ...approval_ok, action: NUL } })],
    ["void approval.policyVersion", () => RecordVoidRequestSchema.safeParse({ ...void_ok, approval: { ...approval_ok, policyVersion: NUL } })],
    ["refund sourceSystem", () => RecordRefundRequestSchema.safeParse({ ...refund_ok, sourceSystem: NUL })],
    ["refund externalId", () => RecordRefundRequestSchema.safeParse({ ...refund_ok, externalId: NUL })],
    ["return sourceSystem", () => RecordReturnRequestSchema.safeParse({ ...return_ok, sourceSystem: NUL })],
    ["return externalId", () => RecordReturnRequestSchema.safeParse({ ...return_ok, externalId: NUL })],
    ["return reason", () => RecordReturnRequestSchema.safeParse({ ...return_ok, reason: NUL })],
    ["capture sourceSystem", () => CaptureSaleRequestSchema.safeParse({ sourceSystem: NUL })],
  ])("rejects a NUL in %s", (_name, parse) => {
    const result = parse();
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("NUL");
  });
});
