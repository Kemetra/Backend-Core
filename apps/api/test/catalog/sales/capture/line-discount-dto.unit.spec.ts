/**
 * RT-740 — the captureSale line `discount` boundary, Docker-free (contract
 * `pos-sales/sales.yaml` 1.13.0-draft `CaptureSaleLineDiscount`, RT-699 doc 28
 * option C-A).
 *
 *   - accepted on every capture schema (no deploy gate);
 *   - shape rules are 400: closed enums, a `value` that fits its `kind`, a
 *     non-negative minor-precision `amount`, a uuid `approverUserId`, no
 *     unknown key (so no free-text reason can ride along);
 *   - a body without `discount` hashes exactly as before; a body with it
 *     hashes differently, and so does any change to it.
 */
import { DISCOUNT_REASON_CODES } from "../../../../src/catalog/sales/dto/capture-sale-request.dto";
import { sha256CanonicalHex } from "../../../../src/catalog/sales/payload-hash";
import {
  CAPTURE_SCHEMA_VARIANTS,
  clearTenderFlags,
  expectCapture400 as expect400,
  parseCapture as parse,
  TENDERS_FLAG,
} from "./__capture-dto-support";

const APPROVER = "0a000000-0000-7000-8000-000000000740";

function discount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "percent",
    value: "10",
    amount: "9.00",
    reasonCode: "promotion",
    authoritySource: "manager_session",
    approverRole: "manager",
    ...overrides,
  };
}

function body(lineDiscount?: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId: "ext-rt740-dto",
    currencyCode: "EGP",
    posTotal: lineDiscount === undefined ? "90.00" : "81.00",
    occurredAt: "2026-10-21T10:00:00.000Z",
    lines: [
      {
        lineName: "Panadol Extra 24",
        unitPrice: "45.00",
        currencyCode: "EGP",
        quantity: "2",
        lineAmount: lineDiscount === undefined ? "90.00" : "81.00",
        unit: "box",
        ...(lineDiscount === undefined ? {} : { discount: lineDiscount }),
      },
    ],
    ...overrides,
  };
}

afterEach(clearTenderFlags);

describe("RT-740 — a line discount is accepted on every capture schema", () => {
  it.each(CAPTURE_SCHEMA_VARIANTS)("%s: a discounted line parses unchanged", (_name, env) => {
    Object.assign(process.env, env);
    const parsed = parse(body(discount({ approverUserId: APPROVER })));
    expect((parsed["lines"] as Array<Record<string, unknown>>)[0]!["discount"]).toEqual(
      discount({ approverUserId: APPROVER }),
    );
  });

  it("a zero-total sale with one zero cash tender parses (owner decision: zero-total path)", () => {
    process.env[TENDERS_FLAG] = "true";
    const free = body(discount({ value: "100", amount: "90.00" }), {
      posTotal: "0",
      tenders: [{ method: "cash", amount: "0" }],
    });
    (free["lines"] as Array<Record<string, unknown>>)[0]!["lineAmount"] = "0";
    expect(() => parse(free)).not.toThrow();
  });
});

describe("RT-740 — CaptureSaleLineDiscount shape rules (400 validation_error)", () => {
  it.each(["1", "9", "10", "99", "100"])("percent value %p is accepted", (value) => {
    expect(() => parse(body(discount({ value })))).not.toThrow();
  });

  it.each(["0", "101", "010", "1.5", "10.0", "-5", "", " 10", "1e1"])(
    "percent value %p is refused (a whole percent 1–100)",
    (value) => {
      expect400(body(discount({ value })));
    },
  );

  it.each(["0.01", "5", "5.0000", "999999999999999.9999"])("amount value %p is accepted", (value) => {
    expect(() => parse(body(discount({ kind: "amount", value, amount: value })))).not.toThrow();
  });

  it.each(["0", "0.00", "-5", "1.23456", "1e3", ""])("amount value %p is refused (positive exact decimal)", (value) => {
    expect400(body(discount({ kind: "amount", value, amount: "5.00" })));
  });

  it.each(["-1", "1.23456", "1e3", "", "abc"])("discount amount %p is refused", (amount) => {
    expect400(body(discount({ amount })));
  });

  it("discount amount 0 is accepted (a percent that rounds to nothing)", () => {
    expect(() => parse(body(discount({ amount: "0" })))).not.toThrow();
  });

  it.each([
    ["kind", "fixed"],
    ["reasonCode", "other"],
    ["reasonCode", "Customer is my cousin Ahmed"],
    ["authoritySource", "cashier"],
    ["approverRole", "cashier"],
    ["approverUserId", "user_2abc"],
  ])("%s %p is refused", (key, value) => {
    expect400(body(discount({ [key]: value })));
  });

  it.each(["kind", "value", "amount", "reasonCode", "authoritySource", "approverRole"])(
    "a missing %s is refused",
    (key) => {
      const entry = discount();
      delete entry[key];
      expect400(body(entry));
    },
  );

  it.each(["reasonNote", "approverName", "pin", "approvalId"])(
    "an unknown key %p is refused (strict: no free text, no credential)",
    (key) => {
      expect400(body(discount({ [key]: "x" })));
    },
  );

  it("accepts every reason code on the closed list (OD-28-9)", () => {
    expect(DISCOUNT_REASON_CODES).toEqual([
      "promotion",
      "loyal_or_contract_customer",
      "near_expiry_or_damaged",
      "price_correction",
    ]);
    for (const reasonCode of DISCOUNT_REASON_CODES) {
      expect(() => parse(body(discount({ reasonCode })))).not.toThrow();
    }
  });
});

describe("RT-740 — payload hash", () => {
  it("a body without discount hashes byte-identically to before RT-740", () => {
    const legacy = body();
    const parsed = parse(legacy);
    expect(sha256CanonicalHex(parsed)).toBe(sha256CanonicalHex(legacy));
    expect(Object.hasOwn((parsed["lines"] as Array<Record<string, unknown>>)[0]!, "discount")).toBe(false);
  });

  it("the discount is part of the hash, field by field", () => {
    const base = sha256CanonicalHex(parse(body(discount())));
    expect(base).not.toBe(sha256CanonicalHex(parse(body())));
    for (const change of [
      { reasonCode: "price_correction" },
      { authoritySource: "cashier_approval" },
      { approverRole: "admin" },
      { approverUserId: APPROVER },
    ]) {
      expect(sha256CanonicalHex(parse(body(discount(change))))).not.toBe(base);
    }
  });
});
