/**
 * Golden bytes for the sale payload hash (sonar S2871 remediation).
 *
 * `sha256CanonicalHex` is persisted as the sale payload hash and must stay
 * reproducible from stored payloads, so the canonical key order must never
 * change. The pinned fixture and literals live in
 * `_helpers/canonical-json-golden.ts`.
 */
import { sha256CanonicalHex } from "../../../src/catalog/sales/payload-hash";
import {
  GOLDEN_FIXTURE,
  GOLDEN_SHA256_HEX,
} from "../../_helpers/canonical-json-golden";

describe("sale payload-hash golden bytes", () => {
  it("hashes the fixture's canonical JSON to the exact golden hex", () => {
    expect(sha256CanonicalHex(GOLDEN_FIXTURE)).toBe(GOLDEN_SHA256_HEX);
  });
});
