/**
 * Key-sorted JSON for idempotency fingerprints.
 *
 * `JSON.stringify` follows insertion order, so a retry whose object keys
 * were serialized in a different order hashed as a different body and
 * returned 409. This serializer sorts object keys and otherwise matches
 * JSON.stringify (undefined object values are omitted, arrays keep order).
 */
export function canonicalJson(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stringify(record[key])}`).join(",")}}`;
}
