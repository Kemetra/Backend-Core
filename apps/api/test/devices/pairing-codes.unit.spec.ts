/**
 * RT-367 — pure helpers of the Console pairing codes
 * (`pairing-codes.projections.ts`): the generated code, the default terminal
 * label and the list cursor. No DB, no HTTP.
 */
import {
  defaultTerminalLabel,
  decodePairingCodeCursor,
  encodePairingCodeCursor,
  generatePairingCode,
  InvalidPairingCodeCursorError,
  PAIRING_CODE_ALPHABET,
} from "../../src/devices/pairing-codes.projections";

const TENANT = "0a000000-0000-7000-8000-000000000001";
const CODE_ID = "0a000000-0000-7000-8000-000000000002";

describe("generatePairingCode", () => {
  const codes = Array.from({ length: 500 }, () => generatePairingCode());

  it("is 16 characters from the look-alike-free alphabet", () => {
    for (const code of codes) {
      expect(code).toHaveLength(16);
      for (const ch of code) expect(PAIRING_CODE_ALPHABET).toContain(ch);
    }
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[01ILOU]/);
  });

  it("always clears the RT-141 strength floor (16..32 characters, at least 8 distinct)", () => {
    for (const code of codes) expect(new Set(code).size).toBeGreaterThanOrEqual(8);
  });

  it("does not repeat", () => {
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("defaultTerminalLabel", () => {
  it("is T- and the first 8 hex digits of the terminal id, upper case", () => {
    expect(defaultTerminalLabel("3f2a9c1b-0000-4000-8000-000000000000")).toBe("T-3F2A9C1B");
  });
});

describe("pairing-code cursor", () => {
  const key = { createdAtKey: "2026-10-17T10:00:00.123456Z", pairingCodeId: CODE_ID };

  it("round-trips for the tenant it was issued under", () => {
    const cursor = encodePairingCodeCursor({ tenantId: TENANT, ...key });
    expect(decodePairingCodeCursor({ tenantId: TENANT, cursor })).toEqual(key);
  });

  it.each([
    ["another tenant", (c: string) => decodePairingCodeCursor({ tenantId: CODE_ID, cursor: c })],
    ["garbage", () => decodePairingCodeCursor({ tenantId: TENANT, cursor: "bm90LWEtY3Vyc29y" })],
    [
      "a device-list cursor",
      () =>
        decodePairingCodeCursor({
          tenantId: TENANT,
          cursor: Buffer.from(JSON.stringify({ k: "devices", t: TENANT })).toString("base64url"),
        }),
    ],
  ])("refuses %s", (_label, decode) => {
    const cursor = encodePairingCodeCursor({ tenantId: TENANT, ...key });
    expect(() => decode(cursor)).toThrow(InvalidPairingCodeCursorError);
  });
});
