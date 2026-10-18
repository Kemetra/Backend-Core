/**
 * Sentry error export for the worker (spec 037 US1).
 *
 * Default-inert and errors-only, same posture as the API. Once initialised the
 * SDK's default global-handler integrations report uncaught exceptions and
 * unhandled rejections. A BullMQ job's final failure is captured by the
 * Worker `failed` listener in `failed-job.ts` (RT-698).
 */
import * as Sentry from "@sentry/node";
import { initSentry, type SentryInitResult } from "@data-pulse-2/shared";

/** Called at module-evaluation time from `instrumentation.ts`. Never throws. */
export function initWorkerSentry(env: NodeJS.ProcessEnv = process.env): SentryInitResult {
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
    service: "backend-worker",
  });
}
