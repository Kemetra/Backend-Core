import * as argon2 from "argon2";

/**
 * argon2id parameters per the OWASP Password Storage Cheat Sheet (2025).
 *
 * Floor for argon2id at the time of writing:
 *   - memoryCost: 19456 KiB (= 19 MiB)
 *   - timeCost:   2 iterations
 *   - parallelism: 1 lane
 *   - hashLength: 32 bytes
 *
 * If you raise these, also bump `needsRehash`'s threshold check so existing
 * users get re-hashed on next successful login.
 */
export const ARGON2_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

/**
 * Canonical maximum password length (RT-145 F1 / RT-153), counted in Unicode
 * code points — the same unit as JSON Schema `maxLength` in the OpenAPI
 * contract. The API DTOs enforce it at the boundary; `hashPassword` and
 * `verifyPassword` enforce it again here as defense in depth.
 *
 * Every password accepted by the earlier 1024 UTF-16-unit cap is at most 1024
 * code points, so this never rejects a password that may already be stored.
 * The password is hashed raw: no pre-hash and no Unicode normalization.
 */
export const MAX_PASSWORD_CODE_POINTS = 1024;

/**
 * True when `value` has at most `MAX_PASSWORD_CODE_POINTS` code points. A lone
 * surrogate counts as one code point. Cheap: the length bounds settle most
 * inputs, and the scan stops as soon as the limit is passed.
 */
export function isWithinPasswordMaxLength(value: string): boolean {
  // One code point is one or two UTF-16 units.
  if (value.length <= MAX_PASSWORD_CODE_POINTS) return true;
  if (value.length > 2 * MAX_PASSWORD_CODE_POINTS) return false;
  let codePoints = 0;
  for (const _ of value) {
    if (++codePoints > MAX_PASSWORD_CODE_POINTS) return false;
  }
  return true;
}

export async function hashPassword(plaintext: string): Promise<string> {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  if (!isWithinPasswordMaxLength(plaintext)) {
    throw new Error(
      `password must be at most ${MAX_PASSWORD_CODE_POINTS} code points`,
    );
  }
  return argon2.hash(plaintext, ARGON2_PARAMS);
}

/**
 * Constant-time verify. Returns false (never throws) on malformed input or
 * mismatch, so callers can treat the boolean as the only signal.
 *
 * A candidate over `MAX_PASSWORD_CODE_POINTS` returns false before argon2
 * runs. No stored password can be that long, and the API rejects such input
 * at the DTO, so no dummy argon2 work is spent on it (RT-145 ratification).
 */
export async function verifyPassword(
  phcString: string,
  candidate: string,
): Promise<boolean> {
  if (typeof phcString !== "string" || phcString.length === 0) return false;
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (!isWithinPasswordMaxLength(candidate)) return false;
  try {
    return await argon2.verify(phcString, candidate);
  } catch {
    return false;
  }
}

/**
 * Returns true if the given PHC hash was produced with weaker parameters than
 * the current floor (or is malformed). Use after a successful verify to
 * upgrade the user's hash transparently:
 *
 *   if (await verifyPassword(stored, candidate)) {
 *     if (needsRehash(stored)) await save(await hashPassword(candidate));
 *   }
 */
export function needsRehash(phcString: string): boolean {
  try {
    return argon2.needsRehash(phcString, ARGON2_PARAMS);
  } catch {
    return true;
  }
}
