/**
 * Minimum strength for an owner-supplied pairing code (RT-141).
 *
 * The consume contract accepts 6–32 characters, and the server's guess
 * budgets (per IP, per code, global wrong-code) only bound the RATE of
 * guessing. A short or repetitive code can still be found inside those
 * budgets, so the issuing CLI refuses weak codes up front. `--generate`
 * mints 18 random bytes (24 base64url characters, 144 bits) and always
 * passes.
 *
 * Rules: 16–32 characters (code points, matching Postgres `length()`), with
 * at least 8 distinct characters.
 */
export const MIN_PAIRING_CODE_LENGTH = 16;
export const MAX_PAIRING_CODE_LENGTH = 32;
export const MIN_PAIRING_CODE_DISTINCT = 8;

/** Why `code` is too weak to issue, or null when it is acceptable. */
export function pairingCodeWeakness(code: string): string | null {
  const chars = [...code];
  if (chars.length < MIN_PAIRING_CODE_LENGTH) {
    return `must be at least ${MIN_PAIRING_CODE_LENGTH} characters`;
  }
  if (chars.length > MAX_PAIRING_CODE_LENGTH) {
    return `must be at most ${MAX_PAIRING_CODE_LENGTH} characters (consume contract limit)`;
  }
  if (new Set(chars).size < MIN_PAIRING_CODE_DISTINCT) {
    return `must contain at least ${MIN_PAIRING_CODE_DISTINCT} distinct characters`;
  }
  return null;
}
