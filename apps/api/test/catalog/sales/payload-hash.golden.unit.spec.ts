/**
 * Golden bytes for the sale payload hash (sonar S2871 remediation).
 *
 * `sha256CanonicalHex` is persisted as the sale payload hash and must stay
 * reproducible from stored payloads, so the canonical key order must never
 * change. The expected values were captured from the code BEFORE the explicit
 * comparator was introduced and are pinned here as literals.
 */
import { createHash } from "node:crypto";

import { sha256CanonicalHex } from "../../../src/catalog/sales/payload-hash";

const FIXTURE = {
  b: 1,
  B: 2,
  a: 3,
  "é": 4,
  _: 5,
  "10": 6,
  "9": 7,
  nested: { z: 1, Z: 2 },
};

const GOLDEN_STRING =
  '{"10":6,"9":7,"B":2,"_":5,"a":3,"b":1,"nested":{"Z":2,"z":1},"é":4}';
const GOLDEN_SHA256_HEX =
  "93fa82fc5dc408821bae29ddf65c2af4cd77a73a408e9dd9a308a3bbabfb2d87";

describe("sale payload-hash golden bytes", () => {
  it("pins the literal's sha256 (guards the golden constants themselves)", () => {
    expect(createHash("sha256").update(GOLDEN_STRING).digest("hex")).toBe(GOLDEN_SHA256_HEX);
  });

  it("hashes the fixture's canonical JSON to the exact golden hex", () => {
    expect(sha256CanonicalHex(FIXTURE)).toBe(GOLDEN_SHA256_HEX);
  });
});
