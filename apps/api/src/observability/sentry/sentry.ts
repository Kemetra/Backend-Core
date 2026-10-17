/**
 * Sentry error export for the API (spec 037 US1).
 *
 * Default-inert: with no valid `SENTRY_DSN` nothing is initialised and nothing
 * leaves the process. Errors only (no tracing, no breadcrumbs): traces and
 * metrics go through the OpenTelemetry layer in `instrumentation.ts`. Every
 * event is rebuilt by the shared allowlist scrubber before it is sent.
 */
import * as Sentry from "@sentry/node";
import { initSentry, type SentryInitResult } from "@data-pulse-2/shared";

/** Called at module-evaluation time from `instrumentation.ts`. Never throws. */
export function initApiSentry(env: NodeJS.ProcessEnv = process.env): SentryInitResult {
  return initSentry(env, {
    sentryInit: (options) =>
      Sentry.init({
        ...(options as unknown as Sentry.NodeOptions),
        // The SDK's default "warn" mode registers an `unhandledRejection`
        // listener, which stops Node from crashing on one. "strict" reports the
        // rejection, then exits non-zero, so restart-on-crash behaves as before.
        integrations: [Sentry.onUnhandledRejectionIntegration({ mode: "strict" })],
      }),
    warn: (message) => console.warn(message),
  });
}

/**
 * Report a server-side error. A no-op until the SDK is initialised, and never
 * throws, so error reporting can never turn into a second failure in the
 * exception filter.
 */
export function captureServerError(exception: unknown): void {
  try {
    Sentry.captureException(exception);
  } catch {
    // Telemetry must never break the request path.
  }
}
