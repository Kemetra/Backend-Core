/**
 * RootLoggerModule — registers `ROOT_LOGGER` once, at the application root
 * (RT-124 / RT-119 R4).
 *
 * Before this module, `ROOT_LOGGER` was only provided feature-locally (e.g.
 * IdempotencyModule), so every other `@Optional() @Inject(ROOT_LOGGER)` site —
 * the audit emitter interceptor, the POS write rate-limit guard, the ERPNext
 * map services, reconciliation — resolved `undefined` in production and its
 * `logger?.error(...)` silently did nothing. In particular, a failed audit
 * enqueue left no trace.
 *
 * `@Global()` so every module sees the provider without importing it.
 * `getRootLogger()` memoizes one pino instance, shared with the one `main.ts`
 * gives the global LoggingInterceptor.
 */
import { Global, Module } from "@nestjs/common";
import { createLogger, type Logger } from "@data-pulse-2/shared";

import { ROOT_LOGGER } from "./logging.interceptor";

let rootLogger: Logger | null = null;

export function getRootLogger(): Logger {
  rootLogger ??= createLogger({
    service: "api",
    level: process.env["LOG_LEVEL"] ?? "info",
  });
  return rootLogger;
}

@Global()
@Module({
  providers: [{ provide: ROOT_LOGGER, useFactory: getRootLogger }],
  exports: [ROOT_LOGGER],
})
export class RootLoggerModule {}
