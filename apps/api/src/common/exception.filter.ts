import {
  ArgumentsHost,
  Catch,
  type ExecutionContext,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { ErrorCodes, errorEnvelope, newId } from "@data-pulse-2/shared";
import type { Request, Response } from "express";
import { ZodError } from "zod";

import {
  recordHttp4xxError,
  recordHttp5xxError,
  recordValidationFailure,
} from "../observability/metrics/api.metrics";
import { routeTemplate } from "./route-template";

/**
 * Map HTTP status codes to canonical error codes used in the envelope.
 * Anything not listed becomes `internal_error`.
 */
function statusToCode(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ErrorCodes.VALIDATION;
    case HttpStatus.UNAUTHORIZED:
      return ErrorCodes.UNAUTHORIZED;
    case HttpStatus.FORBIDDEN:
      return ErrorCodes.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ErrorCodes.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ErrorCodes.CONFLICT;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ErrorCodes.RATE_LIMITED;
    default:
      return ErrorCodes.INTERNAL;
  }
}

/**
 * Pull usable envelope fields (code, message, details) from an
 * HttpException's response payload. Nest stores the response as either
 * a string or an object. When callers supply a structured object —
 *
 *   throw new ConflictException({ code: "alias_conflict", message: "..." })
 *
 * — the `code` field is the contract-of-record fine-grained code that
 * MUST surface in the response envelope (Constitution §IV). When the
 * response payload does not supply a `code`, the caller falls back to
 * the canonical status-derived code via `statusToCode`.
 */
function extractEnvelopeFields(
  exception: HttpException,
  fallback: string,
): { code: string | undefined; message: string; details?: unknown } {
  const response = exception.getResponse();
  if (typeof response === "string") {
    return { code: undefined, message: response };
  }
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    const code =
      typeof r["code"] === "string" ? (r["code"] as string) : undefined;
    const msg = r["message"];
    if (typeof msg === "string") {
      return { code, message: msg, details: r["details"] };
    }
    if (Array.isArray(msg)) {
      return {
        code,
        message: msg.length > 0 ? String(msg[0]) : fallback,
        details: msg.length > 1 ? msg : r["details"],
      };
    }
    return { code, message: fallback, details: r["details"] };
  }
  return { code: undefined, message: fallback };
}

/**
 * A node-postgres DatabaseError carries both SQLSTATE `code` and `severity`.
 * Drizzle may wrap it in `cause`, so inspect a short, bounded cause chain.
 * Only the input/constraint codes named here are safe to classify as 400.
 */
function isPostgresInputError(exception: unknown): boolean {
  let current = exception;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current === null || typeof current !== "object") return false;
    const error = current as { code?: unknown; severity?: unknown; cause?: unknown };
    if (
      typeof error.severity === "string" &&
      (error.code === "22003" || error.code === "23514" || error.code === "22P02")
    ) {
      return true;
    }
    current = error.cause;
  }
  return false;
}

/**
 * Global exception filter — formats every uncaught error into the uniform
 * `{ error: { code, message, request_id, details? } }` envelope.
 *
 * 403 and 404 share the envelope shape per FR-ISO-4. The decision of
 * which status to return for cross-tenant access lives in the future
 * tenant-context guard, not in this filter.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { requestId?: string }>();
    const response = http.getResponse<Response>();
    // Post-response race: IdempotencyInterceptor (and similar) can emit a
    // response via tap.next before an async throw reaches this filter.
    // Attempting res.json() on an already-committed response raises
    // ERR_HTTP_HEADERS_SENT and falsely increments http_error_5xx_total.
    if (response.headersSent) {
      return;
    }
    const requestId = request.requestId ?? newId();
    // In an HTTP transport, the host Nest passes here is structurally an
    // ExecutionContext, but at the exception-filter boundary
    // `getClass`/`getHandler` are often undefined (the handler that
    // threw has already unwound). `routeTemplate` reads Nest Reflect
    // metadata first and falls back to Express's `request.route.path` —
    // the matched-route template Express attaches when routing succeeds
    // (identical fallback to `idempotency.interceptor.ts`). Genuine
    // unmatched 404s yield "unknown", which is a bounded label value.
    const execCtx = host as ExecutionContext;
    const route = routeTemplate(execCtx, request);

    if (exception instanceof ZodError) {
      recordValidationFailure({ route });
      recordHttp4xxError({ route, status: "400" });
      const envelope = errorEnvelope({
        code: ErrorCodes.VALIDATION,
        message: "Request validation failed",
        requestId,
        details: exception.issues,
      });
      response.status(HttpStatus.BAD_REQUEST).json(envelope);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const {
        code: userCode,
        message,
        details,
      } = extractEnvelopeFields(exception, statusDefaultMessage(status));
      // Honor user-supplied fine-grained code (e.g., "alias_conflict") when
      // present; fall back to the canonical status-derived code otherwise.
      // Constitution §IV: OpenAPI contract-of-record specifies fine-grained
      // codes; the filter must surface them rather than overwriting with
      // statusToCode (silently discarding contract-of-record).
      const code = userCode ?? statusToCode(status);
      if (status >= 500) {
        recordHttp5xxError({ route, status: String(status) });
      } else if (status >= 400) {
        recordHttp4xxError({ route, status: String(status) });
      }
      const envelope = errorEnvelope({
        code,
        message,
        requestId,
        ...(details !== undefined ? { details } : {}),
      });
      response.status(status).json(envelope);
      return;
    }

    if (isPostgresInputError(exception)) {
      recordValidationFailure({ route });
      recordHttp4xxError({ route, status: "400" });
      const envelope = errorEnvelope({
        code: ErrorCodes.VALIDATION,
        message: "Request validation failed",
        requestId,
      });
      response.status(HttpStatus.BAD_REQUEST).json(envelope);
      return;
    }

    // Unhandled — never leak internals to the client.
    // exception.message must not be copied into the response body.
    recordHttp5xxError({ route, status: "500" });
    const envelope = errorEnvelope({
      code: ErrorCodes.INTERNAL,
      message: "Internal Server Error",
      requestId,
    });
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(envelope);
  }
}

function statusDefaultMessage(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return "Bad Request";
    case HttpStatus.UNAUTHORIZED:
      return "Unauthorized";
    case HttpStatus.FORBIDDEN:
      return "Forbidden";
    case HttpStatus.NOT_FOUND:
      return "Not Found";
    case HttpStatus.CONFLICT:
      return "Conflict";
    case HttpStatus.TOO_MANY_REQUESTS:
      return "Too Many Requests";
    default:
      return "Internal Server Error";
  }
}
