/**
 * RT-141 — owner-supplied pairing codes must not be guessable.
 */
import { randomBytes } from "node:crypto";

import {
  MAX_PAIRING_CODE_LENGTH,
  MIN_PAIRING_CODE_LENGTH,
  pairingCodeWeakness,
} from "../../src/cli/pairing-code-strength";

describe("pairingCodeWeakness (RT-141)", () => {
  it.each(["123456", "pilot-code", "a".repeat(MIN_PAIRING_CODE_LENGTH - 1)])(
    "rejects a short code (%s)",
    (code) => {
      expect(pairingCodeWeakness(code)).toMatch(/at least 16 characters/);
    },
  );

  it("rejects a code longer than the consume contract allows", () => {
    expect(pairingCodeWeakness("Ab1-".repeat(9))).toMatch(/at most 32/);
  });

  it("rejects a long but repetitive code", () => {
    expect(pairingCodeWeakness("abababababababababab")).toMatch(/distinct/);
  });

  it("counts code points, not UTF-16 units", () => {
    // 16 emoji = 32 UTF-16 units but only 16 code points, 1 distinct.
    expect(pairingCodeWeakness("😀".repeat(16))).toMatch(/distinct/);
  });

  it("accepts a strong supplied code and every generated code", () => {
    expect(pairingCodeWeakness("Tq7-mZ2p-Lx9w-Rk4v")).toBeNull();
    for (let i = 0; i < 200; i += 1) {
      const generated = randomBytes(18).toString("base64url"); // the CLI's --generate
      expect(generated.length).toBeLessThanOrEqual(MAX_PAIRING_CODE_LENGTH);
      expect(pairingCodeWeakness(generated)).toBeNull();
    }
  });

  it("never echoes the code in the reason", () => {
    const code = "secretsecret";
    expect(pairingCodeWeakness(code)).not.toContain(code);
  });
});
