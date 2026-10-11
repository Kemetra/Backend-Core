/**
 * cursor.unit.spec.ts — RT-386 Docker-free coverage for the opaque read-down
 * cursor codec (`read-down.cursor.ts`).
 *
 * A decoded cursor body is only ever a JSON object. Any other JSON value
 * (`null`, a primitive, an array) is malformed and must surface as
 * `ReadDownCursorError`, which the controller maps to the non-disclosing 404
 * (FR-024). Before RT-386, the JSON text `null` (base64url `bnVsbA`) threw a
 * TypeError that escaped as HTTP 500.
 */
import {
  decodeCursor,
  encodeCursor,
  ReadDownCursorError,
} from "../../../src/catalog/read-down/read-down.cursor";

const TENANT = "0a000000-0000-7000-8000-0000000000a1";
const STORE = "0a000000-0000-7000-8000-0000000000b1";
const OTHER = "0a000000-0000-7000-8000-0000000000ff";

/** base64url of a raw JSON text, as a hand-crafted token. */
const token = (json: string): string => Buffer.from(json, "utf8").toString("base64url");

describe("read-down cursor codec (RT-386)", () => {
  it("round-trips a cursor in its own scope", () => {
    const encoded = encodeCursor({ tenantId: TENANT, storeId: STORE, sequence: "42" });
    expect(decodeCursor(encoded, TENANT, STORE)).toEqual({
      tenantId: TENANT,
      storeId: STORE,
      sequence: "42",
    });
  });

  it("keeps a 64-bit sequence as the exact decimal string", () => {
    const sequence = "9223372036854775807";
    const encoded = encodeCursor({ tenantId: TENANT, storeId: STORE, sequence });
    expect(decodeCursor(encoded, TENANT, STORE).sequence).toBe(sequence);
  });

  it("encodes JSON null as bnVsbA (the RT-386 repro token)", () => {
    expect(token("null")).toBe("bnVsbA");
  });

  it.each([
    ["JSON null", token("null")],
    ["a JSON number", token("1")],
    ["a JSON string", token('"x"')],
    ["a JSON boolean", token("true")],
    ["a JSON array", token("[]")],
    ["an array holding a cursor object", token(JSON.stringify([{ t: TENANT, s: STORE, q: "1" }]))],
    ["an empty JSON object", token("{}")],
    ["text that is not JSON", "x"],
  ])("rejects %s as ReadDownCursorError", (_label, malformed) => {
    expect(() => decodeCursor(malformed, TENANT, STORE)).toThrow(ReadDownCursorError);
  });

  it.each([
    ["another tenant", { t: OTHER, s: STORE, q: "1" }],
    ["another store", { t: TENANT, s: OTHER, q: "1" }],
  ])("rejects a cursor bound to %s", (_label, body) => {
    expect(() => decodeCursor(token(JSON.stringify(body)), TENANT, STORE)).toThrow(
      ReadDownCursorError,
    );
  });

  it.each([
    ["a numeric sequence", 1],
    ["a non-digit sequence", "1e3"],
    ["a negative sequence", "-1"],
    ["a missing sequence", undefined],
  ])("rejects %s", (_label, q) => {
    const body = token(JSON.stringify({ t: TENANT, s: STORE, q }));
    expect(() => decodeCursor(body, TENANT, STORE)).toThrow(ReadDownCursorError);
  });
});
