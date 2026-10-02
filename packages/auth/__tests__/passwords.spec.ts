import argon2 = require("argon2");

import {
  ARGON2_PARAMS,
  hashPassword,
  isWithinPasswordMaxLength,
  MAX_PASSWORD_CODE_POINTS,
  needsRehash,
  verifyPassword,
} from "../src/passwords";

describe("ARGON2_PARAMS (OWASP 2025)", () => {
  it("uses memoryCost = 19456 (19 MiB)", () => {
    expect(ARGON2_PARAMS.memoryCost).toBe(19456);
  });

  it("uses timeCost = 2", () => {
    expect(ARGON2_PARAMS.timeCost).toBe(2);
  });

  it("uses parallelism = 1", () => {
    expect(ARGON2_PARAMS.parallelism).toBe(1);
  });

  it("uses hashLength = 32", () => {
    expect(ARGON2_PARAMS.hashLength).toBe(32);
  });
});

describe("hashPassword", () => {
  it("returns a PHC string starting with $argon2id$", async () => {
    const phc = await hashPassword("correct horse battery staple");
    expect(phc.startsWith("$argon2id$")).toBe(true);
  });

  it("encodes the OWASP params (m=19456,t=2,p=1) in the PHC string", async () => {
    const phc = await hashPassword("hunter2");
    expect(phc).toMatch(/m=19456,t=2,p=1/);
  });

  it("produces a different hash for the same password each call (salt randomness)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("rejects empty string", async () => {
    await expect(hashPassword("")).rejects.toThrow();
  });
});

describe("verifyPassword", () => {
  it("returns true for the correct password", async () => {
    const phc = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(phc, "correct horse battery staple")).toBe(
      true,
    );
  });

  it("returns false for a wrong password", async () => {
    const phc = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(phc, "wrong password")).toBe(false);
  });

  it("returns false for an empty candidate without throwing", async () => {
    const phc = await hashPassword("real");
    expect(await verifyPassword(phc, "")).toBe(false);
  });

  it("returns false for a malformed PHC string without throwing", async () => {
    expect(await verifyPassword("not-a-phc-string", "anything")).toBe(false);
  });
});

describe("needsRehash", () => {
  it("returns false for a freshly hashed password (matches current params)", async () => {
    const phc = await hashPassword("ok");
    expect(needsRehash(phc)).toBe(false);
  });

  it("returns true for a hash produced with weaker memoryCost", () => {
    // Hand-crafted PHC string with memoryCost = 4096 (well below the 19456 floor).
    const weak = "$argon2id$v=19$m=4096,t=2,p=1$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU";
    expect(needsRehash(weak)).toBe(true);
  });

  it("returns true for a hash produced with weaker timeCost", () => {
    const weak = "$argon2id$v=19$m=19456,t=1,p=1$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU";
    expect(needsRehash(weak)).toBe(true);
  });

  it("returns true for a malformed PHC string (forces a rehash)", () => {
    expect(needsRehash("garbage")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RT-153 (RT-145 F1): canonical 1024-code-point bound and hash compatibility
// ---------------------------------------------------------------------------

const EMOJI = "\u{1F600}"; // non-BMP: 1 code point, 2 UTF-16 units, 4 UTF-8 bytes
const CLEF = "\u{1D11E}"; // non-BMP
const LONE_HIGH_SURROGATE = "\uD800";

describe("MAX_PASSWORD_CODE_POINTS", () => {
  it("is 1024", () => {
    expect(MAX_PASSWORD_CODE_POINTS).toBe(1024);
  });
});

describe("isWithinPasswordMaxLength (counts Unicode code points)", () => {
  it.each([
    ["1024 ASCII", "a".repeat(1024)],
    ["1024 BMP '€' (3072 UTF-8 bytes)", "€".repeat(1024)],
    ["1024 non-BMP emoji (2048 UTF-16 units)", EMOJI.repeat(1024)],
    ["1023 ASCII + 1 non-BMP (1025 UTF-16 units)", "a".repeat(1023) + EMOJI],
    ["512 emoji + 512 clef (mixed non-BMP)", EMOJI.repeat(512) + CLEF.repeat(512)],
    ["1024 lone surrogates", LONE_HIGH_SURROGATE.repeat(1024)],
  ])("accepts exactly 1024 code points: %s", (_label, value) => {
    expect([...value]).toHaveLength(1024);
    expect(isWithinPasswordMaxLength(value)).toBe(true);
  });

  it.each([
    ["1025 ASCII", "a".repeat(1025)],
    ["1025 BMP '€'", "€".repeat(1025)],
    ["1025 non-BMP emoji (2050 UTF-16 units)", EMOJI.repeat(1025)],
    ["1024 non-BMP emoji + 1 ASCII (2049 UTF-16 units)", EMOJI.repeat(1024) + "a"],
    ["1 ASCII + 1024 non-BMP emoji", "a" + EMOJI.repeat(1024)],
    ["1025 lone surrogates", LONE_HIGH_SURROGATE.repeat(1025)],
  ])("rejects 1025 code points: %s", (_label, value) => {
    expect([...value]).toHaveLength(1025);
    expect(isWithinPasswordMaxLength(value)).toBe(false);
  });

  it("rejects a very long input", () => {
    expect(isWithinPasswordMaxLength("a".repeat(100_000))).toBe(false);
  });
});

describe("hashPassword / verifyPassword at the 1024-code-point bound", () => {
  it("hashes and verifies exactly 1024 non-BMP code points", async () => {
    const pw = EMOJI.repeat(1024);
    const phc = await hashPassword(pw);
    expect(await verifyPassword(phc, pw)).toBe(true);
  });

  it.each([
    ["1025 ASCII", "a".repeat(1025)],
    ["1025 non-BMP emoji", EMOJI.repeat(1025)],
  ])("hashPassword throws for %s, without running argon2", async (_label, pw) => {
    const hash = jest.spyOn(argon2, "hash");
    await expect(hashPassword(pw)).rejects.toThrow(/at most 1024 code points/);
    expect(hash).not.toHaveBeenCalled();
  });

  it.each([
    ["1025 ASCII", "a".repeat(1025)],
    ["1025 non-BMP emoji", EMOJI.repeat(1025)],
  ])(
    "verifyPassword returns false for %s, without running argon2, even against its own hash",
    async (_label, pw) => {
      // A hash of the over-limit input, made with argon2 directly.
      const phc = await argon2.hash(pw, ARGON2_PARAMS);
      expect(await argon2.verify(phc, pw)).toBe(true);

      const verify = jest.spyOn(argon2, "verify");
      expect(await verifyPassword(phc, pw)).toBe(false);
      expect(verify).not.toHaveBeenCalled();
    },
  );
});

/**
 * Golden vectors: argon2id with the production ARGON2_PARAMS and a fixed
 * salt, used here only so the output is reproducible (production salts are
 * random). They pin the raw-input hash: any pre-hash, normalization, trimming
 * or parameter change breaks them, so existing stored hashes would stop
 * verifying. The first three are the RT-145 planning vectors.
 */
const GOLDEN_SALT = Buffer.from("rt145-fixed-salt");
const MIXED_NFC = "Caf\u00e9 \u2615 \u{1D11E} \u5bc6\u7801 \u043f\u0430\u0440\u043e\u043b\u044c";

const GOLDEN_VECTORS: ReadonlyArray<readonly [string, string, string]> = [
  [
    "ASCII passphrase",
    "correct horse battery staple",
    "$argon2id$v=19$m=19456,t=2,p=1$cnQxNDUtZml4ZWQtc2FsdA$c4otZat92dKM7PofOvSsXt5PdyFg+FW3Oj7aBq4vt4U",
  ],
  [
    "1024 ASCII",
    "a".repeat(1024),
    "$argon2id$v=19$m=19456,t=2,p=1$cnQxNDUtZml4ZWQtc2FsdA$TQeiwWxCz2natSci0Ib+f9zbljPeO27eNamLFsyNkQc",
  ],
  [
    "1024 '€' (3072 UTF-8 bytes)",
    "€".repeat(1024),
    "$argon2id$v=19$m=19456,t=2,p=1$cnQxNDUtZml4ZWQtc2FsdA$cCo0REDsjoGEvU/HjiOo8XXOx0cP7Q7oQP4g+1ot0uE",
  ],
  [
    "512 non-BMP emoji (1024 UTF-16 units, the old cap)",
    EMOJI.repeat(512),
    "$argon2id$v=19$m=19456,t=2,p=1$cnQxNDUtZml4ZWQtc2FsdA$0G85VPAtVD1zgDuup7kSIAezCnRVA3HtCy4UXm89N94",
  ],
  [
    "mixed BMP/non-BMP, NFC",
    MIXED_NFC,
    "$argon2id$v=19$m=19456,t=2,p=1$cnQxNDUtZml4ZWQtc2FsdA$zJy+h7pGNLmGWVQQp9yl5K/HXBXAIZJCy1NAzFWcmqk",
  ],
  [
    "mixed BMP/non-BMP, NFD",
    MIXED_NFC.normalize("NFD"),
    "$argon2id$v=19$m=19456,t=2,p=1$cnQxNDUtZml4ZWQtc2FsdA$ePvMsRl5m3sdxm9DADxofRoqWYqxxOj7v1d8ciyhU6g",
  ],
];

describe("golden vectors — existing hashes keep verifying (RT-145/RT-153)", () => {
  it.each(GOLDEN_VECTORS)("%s: verifyPassword accepts the stored hash", async (_label, pw, phc) => {
    expect(await verifyPassword(phc, pw)).toBe(true);
  });

  it.each(GOLDEN_VECTORS)("%s: ARGON2_PARAMS on the raw input reproduce the hash", async (_label, pw, phc) => {
    expect(await argon2.hash(pw, { ...ARGON2_PARAMS, salt: GOLDEN_SALT })).toBe(phc);
  });

  it.each(GOLDEN_VECTORS)("%s: needs no rehash", (_label, _pw, phc) => {
    expect(needsRehash(phc)).toBe(false);
  });

  it("does not normalize: the NFD form does not verify against the NFC hash, and vice versa", async () => {
    const nfd = MIXED_NFC.normalize("NFD");
    expect(nfd).not.toBe(MIXED_NFC);
    const nfcHash = GOLDEN_VECTORS[4]![2];
    const nfdHash = GOLDEN_VECTORS[5]![2];
    expect(await verifyPassword(nfcHash, nfd)).toBe(false);
    expect(await verifyPassword(nfdHash, MIXED_NFC)).toBe(false);
  });

  it("does not trim: surrounding whitespace is part of the password", async () => {
    const phc = GOLDEN_VECTORS[0]![2];
    expect(await verifyPassword(phc, " correct horse battery staple")).toBe(false);
  });
});
