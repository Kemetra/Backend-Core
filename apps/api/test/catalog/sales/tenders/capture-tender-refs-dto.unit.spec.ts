/**
 * RT-360 — the captureSale tender-line identity boundary (contract RT-359,
 * decisions RT-264 D1–D4), Docker-free.
 *
 *   - `SaleTender` accepts an optional `tenderRef` (uuid) and `sequence`
 *     (integer >= 1, within the SMALLINT column);
 *   - per sale: `tenderRef` unique, `sequence` unique (400);
 *   - more than one tender of the same method needs BOTH gates on
 *     (`POS_SALE_TENDERS_ENABLED` and the new default-off
 *     `POS_SALE_TENDERS_SAME_METHOD_ENABLED`, switched on only after RT-361)
 *     AND a `tenderRef` on every entry;
 *   - the refs are part of the payload hash; a legacy body's hash does not drift.
 */
import { ZodError } from "zod";

import {
  CaptureSaleRequestSchema,
  CaptureSaleRequestWithSameMethodTendersSchema,
} from "../../../../src/catalog/sales/dto/capture-sale-request.dto";
import { CaptureSaleRequestPipe } from "../../../../src/catalog/sales/dto/capture-sale-request.pipe";
import { sha256CanonicalHex } from "../../../../src/catalog/sales/payload-hash";
import { isPosSaleTendersSameMethodEnabled } from "../../../../src/catalog/sales/sale-tenders-gate";

const TENDERS_FLAG = "POS_SALE_TENDERS_ENABLED";
const SAME_METHOD_FLAG = "POS_SALE_TENDERS_SAME_METHOD_ENABLED";

const REF_A = "3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const REF_B = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId: "ext-rt360-dto",
    currencyCode: "EGP",
    posTotal: "10.0000",
    occurredAt: "2026-10-11T10:00:00.000Z",
    lines: [
      {
        lineName: "Widget",
        unitPrice: "10.0000",
        currencyCode: "EGP",
        quantity: "1",
        lineAmount: "10.0000",
        unit: "ea",
      },
    ],
    ...overrides,
  };
}

const SAME_METHOD = [
  { method: "cash", amount: "6", tenderRef: REF_A, sequence: 1 },
  { method: "cash", amount: "4", tenderRef: REF_B, sequence: 2 },
];

const pipe = new CaptureSaleRequestPipe();
const parse = (value: unknown): unknown => pipe.transform(value, { type: "body" });

afterEach(() => {
  delete process.env[TENDERS_FLAG];
  delete process.env[SAME_METHOD_FLAG];
});

describe("RT-360 — POS_SALE_TENDERS_SAME_METHOD_ENABLED gate", () => {
  it("is off when unset, empty or not an enabling value", () => {
    expect(isPosSaleTendersSameMethodEnabled()).toBe(false);
    for (const v of ["", "0", "false", "no", "off", "enabled"]) {
      process.env[SAME_METHOD_FLAG] = v;
      expect(isPosSaleTendersSameMethodEnabled()).toBe(false);
    }
  });

  it("is on for 1 / true / yes, case-insensitive and trimmed", () => {
    for (const v of ["1", "true", "TRUE", " yes ", "Yes"]) {
      process.env[SAME_METHOD_FLAG] = v;
      expect(isPosSaleTendersSameMethodEnabled()).toBe(true);
    }
  });

  it("does nothing while the tenders gate is off: a body with tenders is still a 400", () => {
    process.env[SAME_METHOD_FLAG] = "true";
    expect(() => parse(body({ tenders: SAME_METHOD }))).toThrow(ZodError);
  });
});

describe("RT-360 — tenders gate ON, same-method gate OFF (the default)", () => {
  beforeEach(() => {
    process.env[TENDERS_FLAG] = "true";
  });

  it("accepts tenderRef + sequence on tenders of different methods", () => {
    const tenders = [
      { method: "cash", amount: "4", tenderRef: REF_A, sequence: 1 },
      { method: "card_external", amount: "6", reference: "A1B2C3", tenderRef: REF_B, sequence: 2 },
    ];
    expect((parse(body({ tenders })) as { tenders: unknown[] }).tenders).toEqual(tenders);
  });

  it("still rejects two tenders of the same method, even when both carry a tenderRef", () => {
    expect(() => parse(body({ tenders: SAME_METHOD }))).toThrow(ZodError);
  });

  it.each([
    ["a non-uuid tenderRef", [{ method: "cash", amount: "10", tenderRef: "not-a-uuid" }]],
    ["a sequence of 0", [{ method: "cash", amount: "10", sequence: 0 }]],
    ["a fractional sequence", [{ method: "cash", amount: "10", sequence: 1.5 }]],
    ["a sequence beyond the SMALLINT column", [{ method: "cash", amount: "10", sequence: 32768 }]],
    ["a string sequence", [{ method: "cash", amount: "10", sequence: "1" }]],
    [
      "a repeated sequence",
      [
        { method: "cash", amount: "4", sequence: 1 },
        { method: "card_external", amount: "6", sequence: 1 },
      ],
    ],
    [
      "a repeated tenderRef",
      [
        { method: "cash", amount: "4", tenderRef: REF_A },
        { method: "card_external", amount: "6", tenderRef: REF_A },
      ],
    ],
  ])("rejects %s with a validation error (400)", (_label, tenders) => {
    expect(() => parse(body({ tenders }))).toThrow(ZodError);
  });
});

describe("RT-360 — both gates ON: same-method split tenders", () => {
  beforeEach(() => {
    process.env[TENDERS_FLAG] = "true";
    process.env[SAME_METHOD_FLAG] = "true";
  });

  it("accepts two cash tenders that each carry a tenderRef", () => {
    expect((parse(body({ tenders: SAME_METHOD })) as { tenders: unknown[] }).tenders).toEqual(
      SAME_METHOD,
    );
  });

  it("rejects same-method tenders when any entry lacks a tenderRef", () => {
    const tenders = [
      { method: "cash", amount: "6", tenderRef: REF_A },
      { method: "card_external", amount: "1" },
      { method: "card_external", amount: "3", tenderRef: REF_B },
    ];
    expect(() => parse(body({ tenders }))).toThrow(ZodError);
  });

  it("still rejects a repeated tenderRef", () => {
    const tenders = [
      { method: "cash", amount: "6", tenderRef: REF_A },
      { method: "cash", amount: "4", tenderRef: REF_A },
    ];
    expect(() => parse(body({ tenders }))).toThrow(ZodError);
  });

  it("still accepts a legacy ref-less body with one tender per method", () => {
    expect(() => parse(body({ tenders: [{ method: "cash", amount: "10" }] }))).not.toThrow();
  });
});

describe("RT-360 — the tender refs are part of the payload hash", () => {
  it("a different tenderRef is a different payload (a replay that changes it is a 409)", () => {
    const a = CaptureSaleRequestWithSameMethodTendersSchema.parse(body({ tenders: SAME_METHOD }));
    const b = CaptureSaleRequestWithSameMethodTendersSchema.parse(
      body({ tenders: [SAME_METHOD[1], { ...SAME_METHOD[0], tenderRef: REF_B.replace("7a", "7b") }] }),
    );
    expect(sha256CanonicalHex(a)).not.toBe(sha256CanonicalHex(b));
  });

  it("a legacy body hashes identically whichever schema parsed it", () => {
    const legacy = CaptureSaleRequestSchema.parse(body());
    const aware = CaptureSaleRequestWithSameMethodTendersSchema.parse(body());
    expect(sha256CanonicalHex(aware)).toBe(sha256CanonicalHex(legacy));
  });
});
