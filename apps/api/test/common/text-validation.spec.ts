/**
 * RT-611 — shared text validation: lone UTF-16 surrogates are refused at
 * validation and lengths count code points (the OpenAPI `maxLength` unit).
 */
import { z } from "zod";

import { codePointLength, isWellFormedText, maxCodePoints, wellFormedText } from "../../src/common/text-validation";
import { DeviceRetireBodySchema, DeviceRevokeBodySchema } from "../../src/devices/devices.query";
import { ApplyPaymentRequestSchema } from "../../src/settlement/dto/apply-payment-request.dto";
import {
  PayerAccountCreateSchema,
  PayerAccountUpdateSchema,
} from "../../src/settlement/dto/payer-account.dto";

const LONE_HIGH = "ab\uD83Dcd";
const LONE_LOW = "ab\uDE00cd";
const emoji = (n: number) => "\u{1F600}".repeat(n);

describe("text-validation helpers", () => {
  it("codePointLength counts code points, not UTF-16 units", () => {
    expect(codePointLength("abc")).toBe(3);
    expect(codePointLength(emoji(3))).toBe(3);
    expect(emoji(3).length).toBe(6);
  });

  it("isWellFormedText rejects lone surrogates only", () => {
    expect(isWellFormedText("plain \u{1F600} ok")).toBe(true);
    expect(isWellFormedText(LONE_HIGH)).toBe(false);
    expect(isWellFormedText(LONE_LOW)).toBe(false);
    expect(isWellFormedText("\uD83D")).toBe(false);
  });

  it("wellFormedText + maxCodePoints compose on a zod string", () => {
    const schema = z.string().min(1).superRefine(maxCodePoints(2)).superRefine(wellFormedText);
    expect(schema.safeParse(emoji(2)).success).toBe(true);
    expect(schema.safeParse(emoji(3)).success).toBe(false);
    expect(schema.safeParse(LONE_HIGH).success).toBe(false);
  });
});

describe("payer account text fields", () => {
  const create = (over: Record<string, unknown>) =>
    PayerAccountCreateSchema.safeParse({ category: "corporate", displayName: "Acme", ...over }).success;
  const update = (over: Record<string, unknown>) =>
    PayerAccountUpdateSchema.safeParse({ expectedVersion: 1, ...over }).success;

  it("refuses lone surrogates in displayName and externalRef (create + update)", () => {
    expect(create({ displayName: LONE_HIGH })).toBe(false);
    expect(create({ externalRef: LONE_LOW })).toBe(false);
    expect(update({ displayName: LONE_HIGH })).toBe(false);
    expect(update({ externalRef: LONE_LOW })).toBe(false);
  });

  it("accepts emoji up to the code-point limit and refuses beyond", () => {
    expect(create({ displayName: emoji(200) })).toBe(true);
    expect(create({ displayName: emoji(201) })).toBe(false);
    expect(create({ externalRef: emoji(300) })).toBe(true); // create has no contract maxLength
    expect(update({ displayName: emoji(200) })).toBe(true);
    expect(update({ displayName: emoji(201) })).toBe(false);
    expect(update({ externalRef: emoji(140) })).toBe(true);
    expect(update({ externalRef: emoji(141) })).toBe(false);
  });
});

describe("device retire reason and revoke note", () => {
  it("retireReason: lone surrogate 400, 500 emoji ok, 501 refused", () => {
    expect(DeviceRetireBodySchema.safeParse({ retireReason: LONE_HIGH }).success).toBe(false);
    expect(DeviceRetireBodySchema.safeParse({ retireReason: emoji(500) }).success).toBe(true);
    expect(DeviceRetireBodySchema.safeParse({ retireReason: emoji(501) }).success).toBe(false);
  });

  it("revoke note: lone surrogate 400, 500 emoji ok, 501 refused", () => {
    const parse = (note: string) => DeviceRevokeBodySchema.safeParse({ reason: "other", note }).success;
    expect(parse(LONE_LOW)).toBe(false);
    expect(parse(emoji(500))).toBe(true);
    expect(parse(emoji(501))).toBe(false);
  });
});

describe("apply-payment note", () => {
  const parse = (note: string) => ApplyPaymentRequestSchema.safeParse({ amount: "1.00", version: 0, note }).success;
  it("counts code points and refuses lone surrogates", () => {
    expect(parse(emoji(500))).toBe(true);
    expect(parse(emoji(501))).toBe(false);
    expect(parse(LONE_HIGH)).toBe(false);
  });
});
