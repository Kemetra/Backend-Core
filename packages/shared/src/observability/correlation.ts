/**
 * Correlation-ID helper — Track B / P4 / T474.
 *
 * Resolves an end-to-end correlation identifier for a log line:
 *   1. If an OTel trace is active AND the active span's trace-id is valid
 *      (not the all-zero invalid-trace-id constant), return that trace-id.
 *   2. Otherwise return the caller-supplied fallback (typically the HTTP
 *      `request_id`).
 *
 * Why a helper module instead of inlining at the call site:
 *   - The OTel `getActiveSpan()` API can return `undefined`, a no-op span,
 *     or a real recording span depending on whether the SDK has been
 *     started. Each case has subtly different invariants; encapsulating
 *     them here means call sites can stay one-liners.
 *   - Worker code (FR-B-010) and HTTP code (FR-B-004) both need the same
 *     resolution rule. A single helper keeps drift impossible.
 *   - The fallback path MUST be tested (otherwise the branch is uncovered
 *     in non-SDK test runs, and the api package's 88% branch threshold
 *     will refuse the slice).
 */
import { trace } from "@opentelemetry/api";

/** The OpenTelemetry "invalid trace ID" sentinel — all zeros. */
const INVALID_TRACE_ID = "00000000000000000000000000000000";

/**
 * Resolve a correlation ID. Reads the active OTel span; returns its trace
 * ID when valid, otherwise returns `fallback`. Never throws — even if the
 * OTel API surface is broken or stubbed, the fallback is honored.
 */
export function getCorrelationId(fallback: string): string {
  try {
    const span = trace.getActiveSpan();
    if (!span) return fallback;
    const ctx = span.spanContext();
    if (!ctx?.traceId || ctx.traceId === INVALID_TRACE_ID) {
      return fallback;
    }
    return ctx.traceId;
  } catch {
    // Defensive: a broken OTel install MUST NOT poison logging. The
    // request_id fallback is always available — keep logs flowing.
    return fallback;
  }
}
