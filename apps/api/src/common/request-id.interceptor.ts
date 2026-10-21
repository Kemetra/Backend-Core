import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { newId } from "@data-pulse-2/shared";
import type { Request, Response } from "express";
import { Observable } from "rxjs";

export const REQUEST_ID_HEADER = "x-request-id";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/**
 * The request id for an inbound `X-Request-Id` header value: the value itself
 * when it is a well-formed UUID (v4 or v7), otherwise a fresh UUIDv7. Shared
 * with ConsoleRateLimitGuard (RT-619), which must assign the id itself on a
 * guard-thrown 429 because this interceptor runs after guards.
 */
export function resolveRequestId(inbound: string | string[] | undefined): string {
  const inboundStr = Array.isArray(inbound) ? inbound[0] : inbound;
  return typeof inboundStr === "string" && UUID_RE.test(inboundStr) ? inboundStr : newId();
}

/**
 * Per-request UUID assignment.
 *
 *   - Honours an inbound well-formed `X-Request-Id` header (UUID v4 or v7).
 *   - Otherwise mints a fresh UUIDv7 via the shared adapter.
 *   - Stashes the ID on `request.requestId` for downstream interceptors and
 *     the exception filter.
 *   - Echoes the ID back on the response as `X-Request-Id`.
 */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    assignRequestId(http.getRequest<Request>(), http.getResponse<Response>());
    return next.handle();
  }
}

/**
 * Assign the request id once per request and echo it as `X-Request-Id`.
 * Guards run before this interceptor; one that must record the id (RT-414's
 * support-session audit rows, the RT-619 429) calls this first, and the
 * interceptor then keeps the id it assigned, so the audit row, the response
 * header and `error.request_id` carry the same value.
 */
export function assignRequestId(
  request: Pick<Request, "headers"> & { requestId?: string },
  response: Pick<Response, "setHeader">,
): string {
  const requestId = request.requestId ?? resolveRequestId(request.headers[REQUEST_ID_HEADER]);
  request.requestId = requestId;
  response.setHeader("X-Request-Id", requestId);
  return requestId;
}
