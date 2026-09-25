/**
 * #612 — sale_lines.quantity is numeric(19,6), so at most 13 integer digits.
 * 14 integer digits must fail the DTO (400) rather than reach PG 22003.
 */
import { CaptureSaleRequestSchema } from "../../../../src/catalog/sales/dto/capture-sale-request.dto";

function bodyWithQuantity(quantity: string): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId: "sale-001",
    currencyCode: "EGP",
    posTotal: "12.50",
    occurredAt: "2026-06-21T10:00:00.000Z",
    lines: [
      {
        lineName: "Paracetamol 500mg",
        unitPrice: "12.50",
        currencyCode: "EGP",
        quantity,
        lineAmount: "12.50",
        unit: "box",
      },
    ],
  };
}

describe("#612 sale line quantity precision", () => {
  it("accepts 13 integer digits (column maximum)", () => {
    expect(CaptureSaleRequestSchema.safeParse(bodyWithQuantity("9999999999999")).success).toBe(true);
  });

  it("accepts 13 integer digits plus 6 fractional digits", () => {
    expect(
      CaptureSaleRequestSchema.safeParse(bodyWithQuantity("9999999999999.123456")).success,
    ).toBe(true);
  });

  it("rejects 14 integer digits", () => {
    expect(CaptureSaleRequestSchema.safeParse(bodyWithQuantity("99999999999999")).success).toBe(false);
  });

  it("rejects 7 fractional digits", () => {
    expect(CaptureSaleRequestSchema.safeParse(bodyWithQuantity("1.1234567")).success).toBe(false);
  });
});
