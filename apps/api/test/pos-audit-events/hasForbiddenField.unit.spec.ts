/**
 * hasForbiddenField — unit spec for the exported helper in dto.ts.
 *
 * The function is called by PosAuditEventsService to reject events whose
 * payload contains any of the sensitive fields defined in FORBIDDEN_PAYLOAD_KEYS
 * (pin, password, token, secret, etc.). It walks the value recursively,
 * including inside array elements.
 *
 * These tests cover the two branches that are unreachable via HTTP-level
 * tests (the service unit spec never triggers arrays or forbidden-key hits
 * from the top-level body because the Zod schema validates the wrapper):
 *   - line 51: `if (Array.isArray(value))` true branch
 *   - line 55: `if (FORBIDDEN_PAYLOAD_KEYS.has(key)) return true` true branch
 */
import { hasForbiddenField } from "../../src/pos-audit-events/dto";

describe("hasForbiddenField", () => {
  it("returns false for a plain object with no forbidden keys", () => {
    expect(hasForbiddenField({ action: "shift.open", store: "abc" })).toBe(false);
  });

  it("returns true when the object contains a forbidden key (covers FORBIDDEN_PAYLOAD_KEYS hit branch)", () => {
    expect(hasForbiddenField({ pin: "1234" })).toBe(true);
    expect(hasForbiddenField({ password: "hunter2" })).toBe(true);
    expect(hasForbiddenField({ token: "raw-token" })).toBe(true);
  });

  it("returns false for null / primitives (depth guard)", () => {
    expect(hasForbiddenField(null)).toBe(false);
    expect(hasForbiddenField("string")).toBe(false);
    expect(hasForbiddenField(42)).toBe(false);
  });

  it("returns false for an array of safe objects (covers Array.isArray branch — false result)", () => {
    expect(hasForbiddenField([{ action: "open" }, { result: "ok" }])).toBe(false);
  });

  it("returns true for an array containing an object with a forbidden key (covers Array.isArray branch — true result)", () => {
    // Covers the `if (Array.isArray(value))` true branch in hasForbiddenField.
    expect(hasForbiddenField([{ safe: "yes" }, { pin: "9999" }])).toBe(true);
  });

  it("detects forbidden keys nested inside object values", () => {
    expect(hasForbiddenField({ meta: { pin: "1234" } })).toBe(true);
  });

  it("returns false for an empty array", () => {
    expect(hasForbiddenField([])).toBe(false);
  });

  it("fails closed when a nested object exceeds the supported depth", () => {
    let value: Record<string, unknown> = { safe: true };
    for (let i = 0; i < 21; i += 1) value = { nested: value };
    expect(hasForbiddenField(value)).toBe(true);
  });

  it("fails closed when nested arrays exceed the supported depth", () => {
    let value: unknown = { safe: true };
    for (let i = 0; i < 21; i += 1) value = [value];
    expect(hasForbiddenField(value)).toBe(true);
  });

  it("still accepts normal payloads at the maximum supported depth", () => {
    let value: Record<string, unknown> = { safe: true };
    for (let i = 0; i < 20; i += 1) value = { nested: value };
    expect(hasForbiddenField(value)).toBe(false);
  });
});
