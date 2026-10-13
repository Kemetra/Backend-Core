/**
 * Golden bytes for the idempotency canonical JSON (sonar S2871 remediation).
 *
 * The serialized string and its sha256 are persisted as idempotency
 * fingerprints, so the key order must never change. The pinned fixture and
 * literals live in `_helpers/canonical-json-golden.ts`.
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "../../src/idempotency/canonical-json";
import { bodyFingerprint } from "../../src/idempotency/idempotency.interceptor";
import {
  GOLDEN_FIXTURE,
  GOLDEN_SHA256_HEX,
  GOLDEN_STRING,
} from "../_helpers/canonical-json-golden";

describe("idempotency canonicalJson golden bytes", () => {
  it("pins the literal's sha256 (guards the golden constants themselves)", () => {
    expect(createHash("sha256").update(GOLDEN_STRING).digest("hex")).toBe(GOLDEN_SHA256_HEX);
  });

  it("serializes the fixture to the exact golden string", () => {
    expect(canonicalJson(GOLDEN_FIXTURE)).toBe(GOLDEN_STRING);
  });

  it("stores the exact golden fingerprint bytes", () => {
    expect(bodyFingerprint(GOLDEN_FIXTURE).toString("hex")).toBe(GOLDEN_SHA256_HEX);
  });
});
