/**
 * RT-418 — the captureSale `responsibilities` boundary, Docker-free
 * (contract RT-417, `pos-sales/sales.yaml` 1.10.0-draft `SaleResponsibility`).
 *
 *   - accepted on every capture schema (no deploy gate: the server accepts
 *     them from RT-418; the posting feed holds such sales until RT-419);
 *   - one entry at most (`maxItems: 1`), at least one when present;
 *   - `amount` is strictly positive (`PositiveDecimalAmount`), `payerRef` a
 *     uuid, `sequence` an integer >= 1; unknown keys are 400;
 *   - a body without `responsibilities` hashes exactly as before, so legacy
 *     sales replay unchanged; a body with them hashes differently.
 */
import { ZodError } from "zod";

import { CaptureSaleRequestPipe } from "../../../../src/catalog/sales/dto/capture-sale-request.pipe";
import { sha256CanonicalHex } from "../../../../src/catalog/sales/payload-hash";

const TENDERS_FLAG = "POS_SALE_TENDERS_ENABLED";
const SAME_METHOD_FLAG = "POS_SALE_TENDERS_SAME_METHOD_ENABLED";
const PAYER = "0a000000-0000-7000-8000-0000000418a1";
const PAYER_2 = "0a000000-0000-7000-8000-0000000418a2";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId: "ext-rt418-dto",
    currencyCode: "EGP",
    posTotal: "12.5000",
    occurredAt: "2026-10-16T10:00:00.000Z",
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

const credit = (overrides: Record<string, unknown> = {}) => ({
  payerRef: PAYER,
  amount: "12.5",
  sequence: 1,
  ...overrides,
});

const pipe = new CaptureSaleRequestPipe();
const parse = (value: unknown): Record<string, unknown> =>
  pipe.transform(value, { type: "body" }) as unknown as Record<string, unknown>;

function expect400(value: unknown): void {
  expect(() => parse(value)).toThrow(ZodError);
}

afterEach(() => {
  delete process.env[TENDERS_FLAG];
  delete process.env[SAME_METHOD_FLAG];
});

describe("RT-418 — responsibilities are accepted on every capture schema", () => {
  const variants: ReadonlyArray<[string, Record<string, string>]> = [
    ["tenders gate off", {}],
    ["tenders gate on", { [TENDERS_FLAG]: "true" }],
    ["same-method gate on", { [TENDERS_FLAG]: "true", [SAME_METHOD_FLAG]: "true" }],
  ];
  it.each(variants)("%s: a single responsibility parses unchanged", (_name, env) => {
    Object.assign(process.env, env);
    const parsed = parse(body({ responsibilities: [credit()] }));
    expect(parsed["responsibilities"]).toEqual([credit()]);
  });
});

describe("RT-418 — SaleResponsibility rules (400 validation_error)", () => {
  it("more than one entry is refused (maxItems 1)", () => {
    expect400(body({ responsibilities: [credit(), credit({ payerRef: PAYER_2, sequence: 2 })] }));
  });

  it("an empty list is refused (minItems 1)", () => {
    expect400(body({ responsibilities: [] }));
  });

  it.each(["0", "0.0000", "-1", "1.23456", "1e3", " 1", "", "1234567890123456"])(
    "amount %p is refused (strictly positive exact decimal)",
    (amount) => {
      expect400(body({ responsibilities: [credit({ amount })] }));
    },
  );

  it.each(["0.0001", "1", "999999999999999.9999"])("amount %p is accepted", (amount) => {
    expect(() => parse(body({ responsibilities: [credit({ amount })] }))).not.toThrow();
  });

  it("a payerRef that is not a uuid is refused", () => {
    expect400(body({ responsibilities: [credit({ payerRef: "payer-1" })] }));
  });

  it.each([0, -1, 1.5, "1", 32768])("sequence %p is refused", (sequence) => {
    expect400(body({ responsibilities: [credit({ sequence })] }));
  });

  it.each(["payerRef", "amount", "sequence"])("a missing %s is refused", (key) => {
    const entry: Record<string, unknown> = credit();
    delete entry[key];
    expect400(body({ responsibilities: [entry] }));
  });

  it("an unknown key on an entry is refused (strict; no payerExternalRef from the till)", () => {
    expect400(body({ responsibilities: [credit({ payerExternalRef: "CUST-1" })] }));
  });
});

describe("RT-418 — payload hash", () => {
  it("a body without responsibilities hashes byte-identically to before RT-418", () => {
    const legacy = body();
    expect(sha256CanonicalHex(parse(legacy))).toBe(sha256CanonicalHex(legacy));
    expect(Object.hasOwn(parse(legacy), "responsibilities")).toBe(false);
  });

  it("responsibilities are part of the hash", () => {
    const withCredit = parse(body({ responsibilities: [credit()] }));
    const otherAmount = parse(body({ responsibilities: [credit({ amount: "12.4" })] }));
    expect(sha256CanonicalHex(withCredit)).not.toBe(sha256CanonicalHex(parse(body())));
    expect(sha256CanonicalHex(withCredit)).not.toBe(sha256CanonicalHex(otherAmount));
  });
});
