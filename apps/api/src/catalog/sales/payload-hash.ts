/**
 * SHA-256 over a canonical (sorted-key) JSON serialization of a value
 * (gate C). Deterministic key ordering so US5/T062 provenance-reconcile can
 * reproduce the hash from the stored payload. No float involved — the input
 * is a request DTO whose money fields are strings.
 */
import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
  );
  return `{${entries.join(",")}}`;
}

export function sha256CanonicalHex(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
