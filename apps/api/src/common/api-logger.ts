/**
 * The api's pino loggers (RT-684, OBS-9 F-D).
 *
 * Every line carries the OBS-1 service name `backend-api` (D4), the same name
 * the api's OTel resource and Sentry events use. A module-local logger names
 * itself through the `component` binding, not through the service name.
 */
import { createLogger, type CreateLoggerOptions, type Logger } from "@data-pulse-2/shared";

export const API_SERVICE_NAME = "backend-api";

export function createApiLogger(
  component?: string,
  destination?: CreateLoggerOptions["destination"],
): Logger {
  return createLogger({
    service: API_SERVICE_NAME,
    level: process.env["LOG_LEVEL"] ?? "info",
    ...(component === undefined ? {} : { bindings: { component } }),
    ...(destination === undefined ? {} : { destination }),
  });
}
