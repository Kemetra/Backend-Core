import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import {
  getCorrelationId,
  withRequestContext,
  type Logger,
} from "@data-pulse-2/shared";
import type { Request, Response } from "express";
import { Observable, tap } from "rxjs";
import { ZodError } from "zod";
import type { TenantContextRequest } from "../context/types";
import {
  recordHttpDuration,
  recordHttpRequest,
  type HttpStatusClass,
} from "../observability/metrics/api.metrics";
import { isPostgresInputError } from "./postgres-input-error";
import { routeTemplate } from "./route-template";

/**
 * Map an HTTP status code to its bounded status_class label
 * (`2xx`/`3xx`/`4xx`/`5xx`). Per signals.md §1 the only permitted
 * values for `status_class` are these four buckets.
 */
function httpStatusClass(statusCode: number): HttpStatusClass {
  if (statusCode >= 500) return "5xx";
  if (statusCode >= 400) return "4xx";
  if (statusCode >= 300) return "3xx";
  return "2xx";
}

/**
 * Derive the effective HTTP status code for a thrown error, mirroring
 * the logic the GlobalExceptionFilter will use to set the final
 * response status. The exception filter runs AFTER tap.error in this
 * interceptor, so `response.statusCode` is still the Express default
 * (200) when tap.error fires — reading it would bucket every error
 * into `status_class="2xx"` (misleading).
 *
 * - HttpException          → err.getStatus()
 * - ZodError               → 400 (matches GlobalExceptionFilter's ZodError branch)
 * - PostgreSQL input error → 400 (matches its isPostgresInputError branch)
 * - other                  → 500 (matches the unhandled-error branch)
 */
function effectiveErrorStatus(err: unknown): number {
  if (err instanceof HttpException) return err.getStatus();
  if (err instanceof ZodError) return 400;
  if (isPostgresInputError(err)) return 400;
  return 500;
}

/**
 * DI token for the root logger, registered in `app.module.ts` via
 * `provide: ROOT_LOGGER, useValue: createLogger(...)`.
 */
export const ROOT_LOGGER = Symbol.for("api.rootLogger");

/**
 * Logs one structured line per request, on response.
 *
 * Structured-log fields (FR-B-004 / Track B / P4 / T474):
 *   - `request_id`   — always (from `RequestIdInterceptor`)
 *   - `tenant_id`    — when established (from `TenantContextGuard`'s
 *                       `request.context.tenantId`, null otherwise)
 *   - `store_id`     — when established
 *   - `user_id`      — when authenticated
 *   - `actor_id`     — when authenticated (mirrors `user_id` for audit-
 *                       relevant call sites; matrix §3.4)
 *   - `correlation_id` — active OTel trace-id when one exists, else
 *                        falls back to `request_id`
 *
 * `request.context` is set synchronously by `TenantContextGuard.canActivate`
 * (which runs BEFORE interceptors); we can read it directly without ALS
 * bridging. Routes without that guard simply leave `request.context`
 * undefined and the structured fields stay null.
 *
 * Secrets / PII are redacted at the logger boundary by the shared
 * logger's `redact.paths` and per-emit-site serializers (T473).
 *
 * Constitution VII: structured logs with `tenant_id`/`request_id`.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(@Inject(ROOT_LOGGER) private readonly rootLogger: Logger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<
      Request & { requestId?: string } & Partial<TenantContextRequest>
    >();
    const response = http.getResponse<Response>();

    const start = process.hrtime.bigint();
    const requestId = request.requestId ?? "unknown";
    const ctx = request.context;
    const childLogger = withRequestContext(this.rootLogger, {
      request_id: requestId,
      tenant_id: ctx?.tenantId ?? null,
      user_id: ctx?.userId ?? null,
      store_id: ctx?.storeId ?? null,
      actor_id: ctx?.userId ?? null,
      correlation_id: getCorrelationId(requestId),
    });

    return next.handle().pipe(
      tap({
        next: () => {
          const latencyNs = process.hrtime.bigint() - start;
          const latencyMs = Number(latencyNs / 1_000_000n);
          childLogger.info(
            {
              method: request.method,
              route: routeTemplate(context, request),
              status: response.statusCode,
              latency_ms: latencyMs,
            },
            "request completed",
          );
          emitHttpMetrics(context, request.method, response.statusCode, latencyNs);
        },
        error: (err: unknown) => {
          const latencyNs = process.hrtime.bigint() - start;
          const latencyMs = Number(latencyNs / 1_000_000n);
          // tap.error fires BEFORE the GlobalExceptionFilter sets the
          // final response.statusCode — derive the effective status from
          // the error itself so http_request_count is bucketed honestly.
          const errorStatus = effectiveErrorStatus(err);
          childLogger.error(
            {
              method: request.method,
              route: routeTemplate(context, request),
              status: errorStatus,
              latency_ms: latencyMs,
              ...safeErrorFields(err),
            },
            "request errored",
          );
          emitHttpMetrics(context, request.method, errorStatus, latencyNs);
        },
      }),
    );
  }
}

/**
 * RT-124 (RT-120 A10): what a request log line may say about an error.
 *
 * Client errors are expected and their raw text can echo client input
 * (a Postgres input error quotes the offending value; a Zod error describes
 * the submitted body), so only the class and status / SQLSTATE are logged.
 * Genuine server faults keep the boundary `err` serializer's type, message
 * and stack — the diagnostics an operator needs — which already strips any
 * custom properties (e.g. a driver's `detail` carrying row values).
 */
function safeErrorFields(err: unknown): Record<string, unknown> {
  if (err instanceof HttpException) {
    return { err_class: err.constructor.name, err_status: err.getStatus() };
  }
  if (err instanceof ZodError) {
    return { err_class: "ZodError", err_issue_count: err.issues.length };
  }
  if (isPostgresInputError(err)) {
    return {
      err_class: err instanceof Error ? err.constructor.name : "PostgresError",
      err_code: (err as { code?: unknown }).code ?? null,
    };
  }
  return { err };
}

/**
 * Emit `http_request_count` + `http_request_duration_seconds`.
 *
 * Called from both the success and error paths so a failed request is
 * still counted and timed (the exception filter separately counts
 * `http_error_4xx_total` / `http_error_5xx_total` by exact status code).
 *
 * - `route` is the decorator-derived template (NEVER `req.url`).
 * - `status_class` is bucketed (`2xx`/`3xx`/`4xx`/`5xx`) — bounded, safe.
 * - `method` is the HTTP verb — bounded by HTTP spec.
 * - Duration is converted from `bigint` nanoseconds to a number in
 *   seconds (the histogram bucket unit declared in api.metrics.ts).
 */
function emitHttpMetrics(
  context: ExecutionContext,
  method: string,
  statusCode: number,
  latencyNs: bigint,
): void {
  const route = routeTemplate(context);
  const status_class = httpStatusClass(statusCode);
  const durationSeconds = Number(latencyNs) / 1_000_000_000;
  recordHttpRequest({ route, method, status_class });
  recordHttpDuration({ route, method }, durationSeconds);
}
