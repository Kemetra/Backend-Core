/**
 * Run work with tracing suppressed (RT-684, OBS-9 finding F-B).
 *
 * Every span started inside `fn` (including the `pg` instrumentation's
 * pool-connect, BEGIN, query and COMMIT spans) is non-recording and never
 * exported. The suppression follows `fn` across `await`s through the active
 * context manager, and the caller's context is restored when `fn` settles.
 *
 * Use it only for background polling that runs whether or not there is work,
 * where a span per cycle would burn the Datadog trace budget (D3) without
 * telling an operator anything. Work found by the poll must run outside it.
 *
 * `suppressTracing` lives in `@opentelemetry/core`, which this package does
 * not depend on directly. `@opentelemetry/sdk-node` re-exports it as `core`.
 * It is read at call time, so unit suites that mock sdk-node as `{ NodeSDK }`
 * can still import this module. With no SDK started, the API's no-op context
 * manager just runs `fn`.
 */
import { context } from "@opentelemetry/api";
import { core } from "@opentelemetry/sdk-node";

export function withTracingSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  return context.with(core.suppressTracing(context.active()), fn);
}
