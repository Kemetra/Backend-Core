/**
 * Non-replayable responses (RT-82 K3 / RT-155).
 *
 * A route decorated `@Idempotent(..., { replay: "forbid" })` returns
 * credential material that must never be stored or replayed. The interceptor
 * stores this marker instead of the response body: the key stays occupied
 * (the handler never runs twice), and a same-key retry answers 409.
 *
 * The marker is built from an allowlist of top-level scalar fields. Anything
 * not named, and any nested value, is dropped, so a new secret field added to
 * the response later is never persisted by accident.
 */
const MARKER_FLAG = "__dp2NonReplayable";

type MarkerScalar = string | number | boolean | null;

function isScalar(value: unknown): value is MarkerScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** Build the stored marker. Never mutates `responseBody`. */
export function nonReplayableMarker(
  responseBody: unknown,
  fields: readonly string[] = [],
): Record<string, MarkerScalar> {
  const marker: Record<string, MarkerScalar> = { [MARKER_FLAG]: true };
  if (responseBody === null || typeof responseBody !== "object") return marker;
  const source = responseBody as Record<string, unknown>;
  for (const field of fields) {
    const value = source[field];
    if (field !== MARKER_FLAG && isScalar(value)) marker[field] = value;
  }
  return marker;
}

export function isNonReplayableMarker(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  return (body as Record<string, unknown>)[MARKER_FLAG] === true;
}
