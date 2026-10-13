/**
 * Golden bytes for the idempotency canonical JSON (sonar S2871 remediation).
 *
 * The serialized string and its sha256 are persisted as idempotency
 * fingerprints, so the key order must never change. The expected values were
 * captured from the code BEFORE the explicit comparator was introduced and are
 * pinned here as literals — do not recompute them from the code under test.
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "../../src/idempotency/canonical-json";
import { bodyFingerprint } from "../../src/idempotency/idempotency.interceptor";

// Mixed-case, non-ASCII, underscore and integer-like keys. Object.keys yields
// "9" before "10"; code-unit sort must put "10" first.
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

describe("idempotency canonicalJson golden bytes", () => {
  it("pins the literal's sha256 (guards the golden constants themselves)", () => {
    expect(createHash("sha256").update(GOLDEN_STRING).digest("hex")).toBe(GOLDEN_SHA256_HEX);
  });

  it("serializes the fixture to the exact golden string", () => {
    expect(canonicalJson(FIXTURE)).toBe(GOLDEN_STRING);
  });

  it("stores the exact golden fingerprint bytes", () => {
    expect(bodyFingerprint(FIXTURE).toString("hex")).toBe(GOLDEN_SHA256_HEX);
  });
});
