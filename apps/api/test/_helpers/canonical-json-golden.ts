/**
 * Shared golden fixture for the canonical-JSON serializers (sonar S2871
 * remediation): the idempotency fingerprint and the sale payload hash both
 * serialize to the same canonical form, so they share one pinned fixture.
 *
 * The expected values were captured from the code BEFORE the explicit
 * comparator was introduced and are pinned here as literals — never recompute
 * them from the code under test.
 */

// Mixed-case, non-ASCII, underscore and integer-like keys. Object.keys yields
// "9" before "10"; code-unit sort must put "10" first.
export const GOLDEN_FIXTURE = {
  b: 1,
  B: 2,
  a: 3,
  "é": 4,
  _: 5,
  "10": 6,
  "9": 7,
  nested: { z: 1, Z: 2 },
};

export const GOLDEN_STRING =
  '{"10":6,"9":7,"B":2,"_":5,"a":3,"b":1,"nested":{"Z":2,"z":1},"é":4}';

export const GOLDEN_SHA256_HEX =
  "93fa82fc5dc408821bae29ddf65c2af4cd77a73a408e9dd9a308a3bbabfb2d87";
