/**
 * Explicit UTF-16 code-unit comparator — the same order as `Array#sort()`
 * with no compare function. Canonical serializers that feed persisted hashes
 * use it so the ordering is stated, not implied. NEVER swap in `localeCompare`:
 * it is locale-dependent and would change stored hash bytes.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
