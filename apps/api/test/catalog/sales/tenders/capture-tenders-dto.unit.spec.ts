/**
 * RT-77 — the captureSale `tenders` boundary, Docker-free.
 *
 *   - `POS_SALE_TENDERS_ENABLED` is default-OFF (RT-77 comment 10414): until it
 *     is switched on after RT-78 deploys, the pipe validates with the
 *     pre-RT-77 strict schema, so a body with `tenders` fails exactly as today;
 *   - when on, `SaleTender` follows the merged contract: D2 methods, a
 *     non-negative amount (zero allowed, RT-77 10509), a card_external-only
 *     reference, at least one entry, at most one entry per method (400);
 *   - a legacy body hashes byte-identically whichever schema parsed it, so the
 *     sale payload hash (and the feed payloadHash) does not drift on deploy.
 */
import { ZodError } from "zod";

import {
  CaptureSaleRequestSchema,
  CaptureSaleRequestWithTendersSchema,
} from "../../../../src/catalog/sales/dto/capture-sale-request.dto";
import { CaptureSaleRequestPipe } from "../../../../src/catalog/sales/dto/capture-sale-request.pipe";
import { sha256CanonicalHex } from "../../../../src/catalog/sales/payload-hash";
import { isPosSaleTendersEnabled } from "../../../../src/catalog/sales/sale-tenders-gate";

const FLAG = "POS_SALE_TENDERS_ENABLED";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId: "ext-rt77-dto",
    currencyCode: "EGP",
    posTotal: "12.5000",
    occurredAt: "2026-09-30T10:00:00.000Z",
    lines: [
      {
        lineName: "Widget",
        unitPrice: "12.5000",
        currencyCode: "EGP",
        quantity: "1",
        lineAmount: "12.5000",
        unit: "ea",
      },
    ],
    ...overrides,
  };
}

const pipe = new CaptureSaleRequestPipe();
const parse = (value: unknown): unknown => pipe.transform(value, { type: "body" });

afterEach(() => {
  delete process.env[FLAG];
});

describe("RT-77 — POS_SALE_TENDERS_ENABLED gate", () => {
  it("is off when unset, empty or not an enabling value", () => {
    expect(isPosSaleTendersEnabled()).toBe(false);
    for (const v of ["", "0", "false", "no", "off", "enabled"]) {
      process.env[FLAG] = v;
      expect(isPosSaleTendersEnabled()).toBe(false);
    }
  });

  it("is on for 1 / true / yes, case-insensitive and trimmed", () => {
    for (const v of ["1", "true", "TRUE", " yes ", "Yes"]) {
      process.env[FLAG] = v;
      expect(isPosSaleTendersEnabled()).toBe(true);
    }
  });
});

describe("RT-77 — gate OFF: capture is exactly pre-RT-77", () => {
  it("rejects a body carrying tenders with the same strict unknown-key error as today", () => {
    const withTenders = body({ tenders: [{ method: "cash", amount: "12.5" }] });
    const legacyIssues = (() => {
      try {
        CaptureSaleRequestSchema.parse(withTenders);
      } catch (err) {
        return (err as ZodError).issues;
      }
      throw new Error("legacy schema accepted tenders");
    })();
    expect(() => parse(withTenders)).toThrow(ZodError);
    try {
      parse(withTenders);
    } catch (err) {
      expect((err as ZodError).issues).toEqual(legacyIssues);
      expect((err as ZodError).issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  it("accepts a legacy body unchanged", () => {
    expect(parse(body())).toEqual(CaptureSaleRequestSchema.parse(body()));
  });
});

describe("RT-77 — gate ON: SaleTender per the merged contract", () => {
  beforeEach(() => {
    process.env[FLAG] = "true";
  });

  it("accepts a split cash + card_external tender with a card reference", () => {
    const out = parse(
      body({
        tenders: [
          { method: "cash", amount: "2.5" },
          { method: "card_external", amount: "10.0000", reference: "A1B2C3" },
        ],
      }),
    ) as { tenders: unknown[] };
    expect(out.tenders).toEqual([
      { method: "cash", amount: "2.5" },
      { method: "card_external", amount: "10.0000", reference: "A1B2C3" },
    ]);
  });

  it("accepts a zero amount (NonNegativeDecimalAmount, RT-77 10509)", () => {
    expect(() =>
      parse(body({ tenders: [{ method: "cash", amount: "0" }, { method: "card_external", amount: "12.5" }] })),
    ).not.toThrow();
  });

  it.each([
    ["an empty list", []],
    ["a duplicate method", [{ method: "cash", amount: "6" }, { method: "cash", amount: "6.5" }]],
    ["a method outside D2", [{ method: "voucher", amount: "12.5" }]],
    ["a negative amount", [{ method: "cash", amount: "-12.5" }]],
    ["a float amount", [{ method: "cash", amount: 12.5 }]],
    ["a 5-decimal amount", [{ method: "cash", amount: "12.50000" }]],
    ["a reference on cash", [{ method: "cash", amount: "12.5", reference: "A1B2C3" }]],
    ["a malformed card reference", [{ method: "card_external", amount: "12.5", reference: "4111111111111111" }]],
    ["an unknown tender key", [{ method: "cash", amount: "12.5", currencyCode: "EGP" }]],
    ["a missing amount", [{ method: "cash" }]],
  ])("rejects %s with a validation error (400)", (_label, tenders) => {
    expect(() => parse(body({ tenders }))).toThrow(ZodError);
  });

  it("still rejects every other unknown key (strictness is unchanged)", () => {
    expect(() => parse(body({ deviceId: "0a000000-0000-7000-8000-000000000001" }))).toThrow(ZodError);
  });
});

describe("RT-77 — the payload hash of a legacy body does not drift", () => {
  it("is identical whether the legacy or the tender-aware schema parsed it", () => {
    const legacy = CaptureSaleRequestSchema.parse(body());
    const aware = CaptureSaleRequestWithTendersSchema.parse(body());
    expect(Object.prototype.hasOwnProperty.call(aware, "tenders")).toBe(false);
    expect(sha256CanonicalHex(aware)).toBe(sha256CanonicalHex(legacy));
  });

  it("changes when tenders are added (a replay that adds tenders is a different payload)", () => {
    const withTenders = CaptureSaleRequestWithTendersSchema.parse(
      body({ tenders: [{ method: "cash", amount: "12.5" }] }),
    );
    expect(sha256CanonicalHex(withTenders)).not.toBe(
      sha256CanonicalHex(CaptureSaleRequestSchema.parse(body())),
    );
  });
});
