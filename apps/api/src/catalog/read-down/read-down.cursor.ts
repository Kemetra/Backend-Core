/**
 * Opaque, monotonic, scope-bound cursor codec for 010 read-down (R2).
 *
 * The snapshot cursor encodes `(tenant_id, store_id, sequence)` where `sequence`
 * is the change-log head (FR-011). It is OPAQUE to the consumer (base64url JSON)
 * so the mechanism (research R1/R9) can evolve without a contract break. The
 * store scope is carried so a cursor presented under another scope is rejected
 * non-disclosingly (FR-024) — the decode validates it against the device
 * principal's resolved (tenant_id, store_id).
 *
 * No new dependency (T011 [SIGN-OFF]) — base64url of existing ids + a bigint
 * string. The `sequence` stays a STRING end-to-end (it is a 64-bit identity;
 * never parsed to a JS number, which would lose precision past 2^53).
 */
/** Thrown when an opaque token is malformed or presented under a foreign scope. */
export class ReadDownCursorError extends Error {}

export interface SnapshotCursor {
  readonly tenantId: string;
  readonly storeId: string;
  /** Change-log head sequence as a decimal string (64-bit; never a JS number). */
  readonly sequence: string;
}

export function encodeCursor(c: SnapshotCursor): string {
  return Buffer.from(
    JSON.stringify({ t: c.tenantId, s: c.storeId, q: c.sequence }),
    "utf8",
  ).toString("base64url");
}

/**
 * True iff a decoded token body is a JSON object. `null`, a primitive or an
 * array is a malformed token (RT-386: reading a field of `null` threw a
 * TypeError that escaped as HTTP 500 instead of the FR-024 404).
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode + scope-validate an opaque cursor. Throws `ReadDownCursorError` if the
 * token is malformed OR bound to a different (tenant, store) than the caller's
 * device principal (FR-024 non-disclosing).
 */
export function decodeCursor(
  token: string,
  tenantId: string,
  storeId: string,
): SnapshotCursor {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new ReadDownCursorError("malformed cursor");
  }
  if (!isJsonObject(payload)) {
    throw new ReadDownCursorError("malformed cursor");
  }
  if (
    payload.t !== tenantId ||
    payload.s !== storeId ||
    typeof payload.q !== "string" ||
    !/^\d+$/.test(payload.q)
  ) {
    throw new ReadDownCursorError("cursor scope mismatch");
  }
  return { tenantId, storeId, sequence: payload.q };
}
