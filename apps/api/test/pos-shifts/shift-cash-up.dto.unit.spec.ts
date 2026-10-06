/**
 * RT-17 slice 2b — the strict openShift / recordCashMovement bodies
 * (`OpenShiftRequest`, `RecordCashMovementRequest` in pos-shifts.openapi.yaml
 * 1.1.0-draft). Every rejection is a ZodError, i.e. 400 `validation_error`.
 */
import type { ZodTypeAny } from "zod";

import {
  CloseShiftRequestSchema,
  OpenShiftRequestSchema,
  RecordCashMovementRequestSchema,
  ShiftIdParamSchema,
  ShiftInstantSchema,
} from "../../src/pos-shifts/shift-cash-up.dto";

const UUID = "0192f5a2-3b4c-7d8e-9f01-23456789ab01";
const UUID_V4 = "0e170000-0000-4000-8000-000000000001";

const OPEN = {
  shiftId: UUID,
  openedAt: "2026-10-05T08:00:00Z",
  openingUserId: UUID_V4,
  currencyCode: "EGP",
  openingFloat: "500.00",
};

const MOVEMENT = {
  movementId: UUID,
  kind: "pay_out",
  amount: "120.00",
  reasonCode: "petty_expense",
  note: "Cleaning supplies",
  occurredAt: "2026-10-05T11:30:00Z",
};

/** One schema case: the schema, a base body and the overrides to apply. */
interface BodyCase {
  readonly schema: ZodTypeAny;
  readonly base: Record<string, unknown>;
  readonly overrides: Record<string, unknown>;
}

const accepts = (c: BodyCase): boolean => c.schema.safeParse({ ...c.base, ...c.overrides }).success;

describe("OpenShiftRequestSchema", () => {
  it.each([
    ["the contract example", {}],
    ["a device-path claim", { operatorUserId: UUID_V4 }],
    ["a whole-unit float", { openingFloat: "500" }],
    ["a JPY float", { currencyCode: "JPY", openingFloat: "5000" }],
    ["a KWD float with 3 digits", { currencyCode: "KWD", openingFloat: "1.250" }],
    ["a fractional-second openedAt", { openedAt: "2026-10-05T08:00:00.123456Z" }],
    ["an RFC 3339 offset openedAt (Codex P2)", { openedAt: "2026-10-05T10:00:00+02:00" }],
  ])("accepts %s", (_label, overrides) => {
    expect(accepts({ schema: OpenShiftRequestSchema, base: OPEN, overrides })).toBe(true);
  });

  it.each([
    ["an unknown key", { tenantId: UUID }],
    ["3 digits on EGP", { openingFloat: "500.000" }],
    ["a fraction on JPY", { currencyCode: "JPY", openingFloat: "1.5" }],
    ["a currency with no minor unit", { currencyCode: "XAU", openingFloat: "1" }],
    ["a lower-case currency", { currencyCode: "egp" }],
    ["a negative float", { openingFloat: "-1" }],
    ["a float in exponent form", { openingFloat: "5e2" }],
    ["a numeric float", { openingFloat: 500 }],
    ["a non-RFC 3339 offset openedAt", { openedAt: "2026-10-05T10:00:00+0200" }],
    ["a non-uuid opener", { openingUserId: "cashier-1" }],
    ["a null claim", { operatorUserId: null }],
  ])("rejects %s", (_label, overrides) => {
    expect(accepts({ schema: OpenShiftRequestSchema, base: OPEN, overrides })).toBe(false);
  });

  it("rejects a body missing a required field", () => {
    const { openingFloat: _float, ...body } = OPEN;
    expect(OpenShiftRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("RecordCashMovementRequestSchema", () => {
  it.each([
    ["the contract example", {}],
    ["a pay-in without a note", { kind: "pay_in", reasonCode: "float_top_up", note: undefined }],
    ["a 200-code-point note", { note: "€".repeat(200) }],
    ["4 fractional digits (checked against the shift later)", { amount: "1.0001" }],
    ["an RFC 3339 offset occurredAt (Codex P2)", { occurredAt: "2026-10-05T13:30:00+02:00" }],
  ])("accepts %s", (_label, overrides) => {
    expect(accepts({ schema: RecordCashMovementRequestSchema, base: MOVEMENT, overrides })).toBe(true);
  });

  it.each([
    ["a zero amount", { amount: "0.00" }],
    ["a negative amount", { amount: "-1.00" }],
    ["5 fractional digits", { amount: "1.00001" }],
    ["an unknown kind", { kind: "drop" }],
    ["an unknown reason", { reasonCode: "tips" }],
    ["an empty note", { note: "" }],
    ["a 201-character note", { note: "x".repeat(201) }],
    ["a note with a NUL", { note: "a\u0000b" }],
    ["a currency field", { currencyCode: "EGP" }],
    ["a shift field", { shiftId: UUID }],
    ["an out-of-range offset occurredAt", { occurredAt: "2026-10-05T13:30:00+24:00" }],
  ])("rejects %s", (_label, overrides) => {
    expect(accepts({ schema: RecordCashMovementRequestSchema, base: MOVEMENT, overrides })).toBe(false);
  });
});

const CLOSE = {
  closedAt: "2026-10-05T16:00:00Z",
  closingUserId: UUID_V4,
  closeKind: "normal",
  openingFloat: "500.00",
  cashSalesTotal: "2450.00",
  cashRefundsTotal: "75.00",
  payInTotal: "0.00",
  payOutTotal: "120.00",
  expectedCash: "2755.00",
  countedCash: "2750.00",
  variance: "-5.00",
  saleCount: 37,
  cashRefundReturnRefs: [UUID],
};

describe("CloseShiftRequestSchema", () => {
  it.each([
    ["the contract example", {}],
    ["a device-path claim and an approver", { operatorUserId: UUID_V4, varianceApprovedByUserId: UUID }],
    ["a forced close with its reason", { closeKind: "forced", forcedReason: "Cashier left" }],
    ["a positive variance", { countedCash: "2760.00", variance: "5.00" }],
    ["no refund refs", { cashRefundReturnRefs: [] }],
    ["an RFC 3339 offset closedAt", { closedAt: "2026-10-05T18:00:00+02:00" }],
    ["4 fractional digits (checked against the shift later)", { countedCash: "2750.0001" }],
  ])("accepts %s", (_label, overrides) => {
    expect(accepts({ schema: CloseShiftRequestSchema, base: CLOSE, overrides })).toBe(true);
  });

  it.each([
    ["a normal close with a forcedReason", { forcedReason: "no" }],
    ["a forced close without a forcedReason", { closeKind: "forced" }],
    ["an empty forcedReason", { closeKind: "forced", forcedReason: "" }],
    ["a 201-character forcedReason", { closeKind: "forced", forcedReason: "x".repeat(201) }],
    ["an unknown closeKind", { closeKind: "abandoned" }],
    ["a negative total", { payOutTotal: "-1.00" }],
    ["a total in exponent form", { cashSalesTotal: "2.45e3" }],
    ["a numeric total", { countedCash: 2750 }],
    ["a variance with 5 fractional digits", { variance: "-5.00001" }],
    ["a negative saleCount", { saleCount: -1 }],
    ["a fractional saleCount", { saleCount: 1.5 }],
    ["a saleCount beyond a database integer", { saleCount: 2 ** 31 }],
    ["a string saleCount", { saleCount: "37" }],
    ["duplicate refund refs", { cashRefundReturnRefs: [UUID, UUID] }],
    ["a non-uuid refund ref", { cashRefundReturnRefs: ["return-1"] }],
    ["a non-uuid approver", { varianceApprovedByUserId: "manager" }],
    ["a currency field", { currencyCode: "EGP" }],
    ["a non-RFC 3339 closedAt", { closedAt: "2026-10-05T16:00:00+0200" }],
  ])("rejects %s", (_label, overrides) => {
    expect(accepts({ schema: CloseShiftRequestSchema, base: CLOSE, overrides })).toBe(false);
  });

  it.each(Object.keys(CLOSE))("rejects a body missing %s", (field) => {
    const body: Record<string, unknown> = { ...CLOSE };
    delete body[field];
    expect(CloseShiftRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("ShiftInstantSchema — an RFC 3339 date-time, Z or a ±HH:MM offset (Codex P2)", () => {
  it.each([
    ["2026-10-05T08:00:00Z", true],
    ["2026-10-05T08:00:00.123456Z", true],
    ["2026-10-05T10:00:00+02:00", true],
    ["2026-10-05T03:00:00.5-05:00", true],
    ["2026-10-05T08:00:00-00:00", true],
    ["2026-10-05T23:59:59+23:59", true],
    ["2026-10-05T10:00:00+0200", false],
    ["2026-10-05T10:00:00+02", false],
    ["2026-10-05T10:00:00+2:00", false],
    ["2026-10-05T10:00:00+24:00", false],
    ["2026-10-05T10:00:00+02:60", false],
    ["2026-10-05T10:00:00", false],
    ["2026-10-05T08:00:00z", false],
    ["2026-10-05 08:00:00Z", false],
  ])("%s → %s", (value, ok) => {
    expect(ShiftInstantSchema.safeParse(value).success).toBe(ok);
  });
});

describe("ShiftIdParamSchema", () => {
  it.each([
    [UUID, true],
    [UUID_V4, true],
    ["not-a-uuid", false],
    ["", false],
  ])("%s → %s", (value, ok) => {
    expect(ShiftIdParamSchema.safeParse(value).success).toBe(ok);
  });
});
