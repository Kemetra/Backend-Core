/**
 * RT-572 — the `PayerAccountUpdate` request boundary (`settlement.yaml` 2.1.0).
 *
 * The DTO patterns are applied verbatim from the contract: each `.source` is
 * pinned to the `pattern` string in the YAML, so a looser (or backtracking)
 * re-implementation fails here. Pure (no DB, no HTTP).
 */
import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../src/openapi/loader";
import {
  PAYER_DISPLAY_NAME_PATTERN,
  PAYER_EXTERNAL_REF_PATTERN,
  PAYER_VERSION_MAX,
  PayerAccountUpdateSchema,
  PayerRefParamSchema,
} from "../../../src/settlement/dto/payer-account.dto";

interface UpdateProperty {
  pattern?: string;
  maxLength?: number;
  maximum?: number;
}

function contractProperties(): Record<string, UpdateProperty> {
  const dir = resolve(__dirname, "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "settlement");
  const doc = loadOpenApiContracts({ dir }).find((c) => c.id === "settlement")!.document as {
    components: { schemas: { PayerAccountUpdate: { properties: Record<string, UpdateProperty> } } };
  };
  return doc.components.schemas.PayerAccountUpdate.properties;
}

describe("PayerAccountUpdate — verbatim from the contract", () => {
  const props = contractProperties();

  it("the display name and externalRef patterns are the contract's, character for character", () => {
    expect(PAYER_DISPLAY_NAME_PATTERN.source).toBe(props["displayName"]!.pattern);
    expect(PAYER_EXTERNAL_REF_PATTERN.source).toBe(props["externalRef"]!.pattern);
  });

  it("the bounds are the contract's (200, 140, int4)", () => {
    expect(props["displayName"]!.maxLength).toBe(200);
    expect(props["externalRef"]!.maxLength).toBe(140);
    expect(props["expectedVersion"]!.maximum).toBe(PAYER_VERSION_MAX);
    expect(PAYER_VERSION_MAX).toBe(2147483647);
  });
});

describe("PayerAccountUpdateSchema", () => {
  const ok = (body: unknown) => PayerAccountUpdateSchema.safeParse(body).success;

  it.each([
    [{ expectedVersion: 0, externalRef: "CUST-1" }],
    [{ expectedVersion: 5, displayName: " Padded " }],
    [{ expectedVersion: 2147483647, status: "suspended" }],
    [{ expectedVersion: 1, displayName: "A", externalRef: "B C", status: "active" }],
  ])("accepts %j", (body) => {
    expect(ok(body)).toBe(true);
  });

  it.each([
    [{}],
    [{ expectedVersion: 0 }],
    [{ displayName: "No version" }],
    [{ expectedVersion: 0, externalRef: null }],
    [{ expectedVersion: 0, category: "insurer", displayName: "X" }],
    [{ expectedVersion: 0, storeId: null, displayName: "X" }],
    [{ expectedVersion: 2147483648, displayName: "X" }],
    [{ expectedVersion: -1, displayName: "X" }],
    [{ expectedVersion: 0.5, displayName: "X" }],
    [{ expectedVersion: 0, displayName: "   " }],
    [{ expectedVersion: 0, displayName: "a\u0000b" }],
    [{ expectedVersion: 0, externalRef: " x" }],
    [{ expectedVersion: 0, externalRef: "x " }],
    [{ expectedVersion: 0, externalRef: "a\nb" }],
    [{ expectedVersion: 0, externalRef: "a\u200bb" }],
    [{ expectedVersion: 0, externalRef: "a\u2028b" }],
    [{ expectedVersion: 0, externalRef: "a\ufeffb" }],
    [{ expectedVersion: 0, externalRef: "r".repeat(141) }],
    [{ expectedVersion: 0, status: "deleted" }],
  ])("rejects %j", (body) => {
    expect(ok(body)).toBe(false);
  });

  it("refuses long NUL-bearing and whitespace-heavy values quickly (linear patterns)", () => {
    const long = 150_000;
    for (const re of [PAYER_DISPLAY_NAME_PATTERN, PAYER_EXTERNAL_REF_PATTERN]) {
      const start = Date.now();
      expect(re.test("a".repeat(long) + "\u0000")).toBe(false);
      expect(re.test(" ".repeat(long) + "\u0000")).toBe(false);
      // a trailing newline is fine in a display name, never in an identifier
      expect(re.test("a ".repeat(long / 2) + "\n")).toBe(re === PAYER_DISPLAY_NAME_PATTERN);
      expect(Date.now() - start).toBeLessThan(3000);
    }
  });
});

describe("PayerRefParamSchema", () => {
  it("accepts a uuid and refuses everything else before any SQL cast", () => {
    expect(PayerRefParamSchema.safeParse("0a000000-0000-7000-8000-0000004182a1").success).toBe(true);
    for (const bad of ["", "not-a-uuid", "12345", "0a000000-0000-7000-8000-00000000zzzz", "\u0000"]) {
      expect(PayerRefParamSchema.safeParse(bad).success).toBe(false);
    }
  });
});
