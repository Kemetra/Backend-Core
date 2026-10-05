/**
 * RT-225 — the `admissionCheckAt` body rules, Docker-free ([GATED] approval:
 * Jira RT-225, owner, 2026-10-05; sales.yaml 1.6.0-draft).
 *
 * `admissionCheckAt` is OPTIONAL. When present:
 *   - it is allowed ONLY together with `operatorUserId` (the device path);
 *   - `admissionCheckAt <= occurredAt` (inclusive, compared at full precision);
 *   - `occurredAt - admissionCheckAt <= 7 days` (inclusive).
 * Any breach is a ZodError (the usual 400 `validation_error`). OpenAPI cannot
 * express these cross-field rules, so the contract states them in prose and
 * this spec pins the DTO. Both capture schemas (with and without RT-77
 * tenders) and the pipe enforce them.
 */
import { ZodError } from "zod";

import {
  CaptureSaleRequestSchema,
  CaptureSaleRequestWithTendersSchema,
} from "../../../../src/catalog/sales/dto/capture-sale-request.dto";
import { CaptureSaleRequestPipe } from "../../../../src/catalog/sales/dto/capture-sale-request.pipe";

const FLAG = "POS_SALE_TENDERS_ENABLED";
const OPERATOR = "0a225000-0000-4000-8000-0000000000c1";
const OCCURRED_AT = "2026-09-30T10:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceSystem: "pos-pulse",
    externalId: "ext-rt225-dto",
    currencyCode: "EGP",
    posTotal: "12.50",
    occurredAt: OCCURRED_AT,
    lines: [
      {
        lineName: "Widget",
        unitPrice: "12.50",
        currencyCode: "EGP",
        quantity: "1",
        lineAmount: "12.50",
        unit: "ea",
      },
    ],
    ...overrides,
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const occurredMs = Date.parse(OCCURRED_AT);

const SCHEMAS = [
  ["CaptureSaleRequestSchema", CaptureSaleRequestSchema],
  ["CaptureSaleRequestWithTendersSchema", CaptureSaleRequestWithTendersSchema],
] as const;

afterEach(() => {
  delete process.env[FLAG];
});

describe.each(SCHEMAS)("RT-225 admissionCheckAt — %s", (_name, schema) => {
  const ok = (overrides: Record<string, unknown>): boolean => schema.safeParse(body(overrides)).success;

  it("accepts it with operatorUserId, before occurredAt, and keeps it in the parsed body", () => {
    const checkAt = iso(occurredMs - 15 * 60 * 1000);
    const parsed = schema.parse(body({ operatorUserId: OPERATOR, admissionCheckAt: checkAt }));
    expect(parsed).toMatchObject({ operatorUserId: OPERATOR, admissionCheckAt: checkAt, occurredAt: OCCURRED_AT });
  });

  it("accepts it equal to occurredAt (inclusive)", () => {
    expect(ok({ operatorUserId: OPERATOR, admissionCheckAt: OCCURRED_AT })).toBe(true);
  });

  it("accepts a gap of exactly 7 days (inclusive)", () => {
    expect(ok({ operatorUserId: OPERATOR, admissionCheckAt: iso(occurredMs - 7 * DAY_MS) })).toBe(true);
  });

  it("rejects a gap of 7 days + 1 ms", () => {
    expect(ok({ operatorUserId: OPERATOR, admissionCheckAt: iso(occurredMs - 7 * DAY_MS - 1) })).toBe(false);
  });

  it("rejects a gap of 7 days + a fraction below one millisecond", () => {
    expect(ok({ operatorUserId: OPERATOR, admissionCheckAt: "2026-09-23T09:59:59.9999Z" })).toBe(false);
    expect(ok({ operatorUserId: OPERATOR, admissionCheckAt: "2026-09-23T10:00:00Z" })).toBe(true);
  });

  it("rejects it 1 ms after occurredAt", () => {
    expect(ok({ operatorUserId: OPERATOR, admissionCheckAt: iso(occurredMs + 1) })).toBe(false);
  });

  it("rejects it after occurredAt by less than one millisecond (full-precision compare)", () => {
    expect(ok({ operatorUserId: OPERATOR, admissionCheckAt: "2026-09-30T10:00:00.0001Z" })).toBe(false);
    // Different fraction lengths, same instant.
    expect(ok({ operatorUserId: OPERATOR, admissionCheckAt: "2026-09-30T10:00:00.000000Z" })).toBe(true);
    expect(ok({ operatorUserId: OPERATOR, admissionCheckAt: "2026-09-30T10:00:00Z" })).toBe(true);
  });

  it("compares a whole-second occurredAt correctly against a fractional checkAt", () => {
    const b = { occurredAt: "2026-09-30T10:00:00Z", operatorUserId: OPERATOR };
    expect(schema.safeParse(body({ ...b, admissionCheckAt: "2026-09-30T09:59:59.5Z" })).success).toBe(true);
    expect(schema.safeParse(body({ ...b, admissionCheckAt: "2026-09-30T10:00:00.5Z" })).success).toBe(false);
  });

  it("rejects it without operatorUserId (the field is device-path only)", () => {
    const result = schema.safeParse(body({ admissionCheckAt: iso(occurredMs - 1000) }));
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues.map((i) => i.path.join("."))).toContain("admissionCheckAt");
  });

  it("rejects a value that is not an RFC 3339 UTC date-time", () => {
    for (const v of ["yesterday", "2026-09-30 09:00:00", "2026-09-30T09:00:00+02:00", 1727690400000, null]) {
      expect(ok({ operatorUserId: OPERATOR, admissionCheckAt: v })).toBe(false);
    }
  });

  it("the absence of the field changes nothing", () => {
    expect(ok({})).toBe(true);
    expect(ok({ operatorUserId: OPERATOR })).toBe(true);
  });
});

describe("RT-225 admissionCheckAt — the captureSale pipe enforces the rules with the tenders gate off and on", () => {
  const pipe = new CaptureSaleRequestPipe();
  const parse = (value: unknown): unknown => pipe.transform(value, { type: "body" });

  it.each([["off", ""], ["on", "true"]])("tenders gate %s", (_label, flag) => {
    process.env[FLAG] = flag;
    expect(() => parse(body({ operatorUserId: OPERATOR, admissionCheckAt: iso(occurredMs - 1000) }))).not.toThrow();
    expect(() => parse(body({ admissionCheckAt: iso(occurredMs - 1000) }))).toThrow(ZodError);
    expect(() => parse(body({ operatorUserId: OPERATOR, admissionCheckAt: iso(occurredMs + 1) }))).toThrow(ZodError);
    expect(() =>
      parse(body({ operatorUserId: OPERATOR, admissionCheckAt: iso(occurredMs - 7 * DAY_MS - 1) })),
    ).toThrow(ZodError);
  });
});
