/**
 * exception.filter.unit.spec.ts
 *
 * Docker-free unit coverage for GlobalExceptionFilter.
 *
 * Strategy: construct the filter directly (no DI container), supply hand-
 * built ArgumentsHost fakes, and assert on the captured status + body.
 * Real `errorEnvelope` / `ErrorCodes` are used — no mocking of shared.
 *
 * Tests:
 *   EF1  – ZodError → 400 + validation_error + issues in details
 *   EF2  – HttpException 401 → 401 + unauthorized code
 *   EF3  – HttpException 403 → 403 + forbidden code
 *   EF4  – HttpException 404 → 404 + not_found code
 *   EF5  – HttpException 409 → 409 + conflict code
 *   EF6  – HttpException 429 → 429 + rate_limited code
 *   EF7  – HttpException unknown status (503) → internal_error + default message
 *   EF8  – HttpException with string response body → message from string
 *   EF9  – HttpException with object body + string message field
 *   EF10 – HttpException with array message field (1 item) → no details
 *   EF11 – HttpException with array message field (2+ items) → full array as details
 *   EF12 – HttpException with object body, no message field → falls back to statusDefaultMessage
 *   EF13 – Unhandled Error → 500 + internal_error + generic message (no leak)
 *   EF14 – Unhandled non-Error (thrown string) → 500 + internal_error
 *   EF15 – request.requestId present → used in envelope
 *   EF16 – request.requestId absent → newId() is called, envelope still has a requestId
 */
import "reflect-metadata";

import {
  ArgumentsHost,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { z } from "zod";
import { ErrorCodes } from "@data-pulse-2/shared";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedResponse {
  statusCode?: number;
  body?: unknown;
}

function makeHost(
  req: object,
  captured: CapturedResponse,
): ArgumentsHost {
  const res = {
    status: (code: number) => {
      captured.statusCode = code;
      return { json: (b: unknown) => { captured.body = b; } };
    },
  };
  return {
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
      getResponse: <T>() => res as unknown as T,
    }),
  } as unknown as ArgumentsHost;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQ_ID = "018f3b1d-7c2a-7e3a-9bcd-0123456789ab";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GlobalExceptionFilter – unit", () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
  });

  // EF1: ZodError → 400 + VALIDATION code + issues in details
  it("EF1: ZodError → 400 + validation_error + issues in details", () => {
    const captured: CapturedResponse = {};
    const host = makeHost({ requestId: REQ_ID }, captured);

    const result = z.object({ x: z.string() }).safeParse({ x: 42 });
    if (result.success) throw new Error("expected zod failure");

    filter.catch(result.error, host);

    expect(captured.statusCode).toBe(HttpStatus.BAD_REQUEST);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.code).toBe(ErrorCodes.VALIDATION);
    expect(body.error.message).toBe("Request validation failed");
    expect(body.error.request_id).toBe(REQ_ID);
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  // EF2: HttpException 401 → 401 + UNAUTHORIZED code
  it("EF2: HttpException 401 → 401 + unauthorized code", () => {
    const captured: CapturedResponse = {};
    filter.catch(new UnauthorizedException("Not allowed"), makeHost({ requestId: REQ_ID }, captured));
    expect(captured.statusCode).toBe(401);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.code).toBe(ErrorCodes.UNAUTHORIZED);
  });

  // EF3: HttpException 403 → 403 + FORBIDDEN code
  it("EF3: HttpException 403 → 403 + forbidden code", () => {
    const captured: CapturedResponse = {};
    filter.catch(new ForbiddenException("No access"), makeHost({ requestId: REQ_ID }, captured));
    expect(captured.statusCode).toBe(403);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.code).toBe(ErrorCodes.FORBIDDEN);
  });

  // EF4: HttpException 404 → 404 + NOT_FOUND code
  it("EF4: HttpException 404 → 404 + not_found code", () => {
    const captured: CapturedResponse = {};
    filter.catch(new NotFoundException("Not here"), makeHost({ requestId: REQ_ID }, captured));
    expect(captured.statusCode).toBe(404);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.code).toBe(ErrorCodes.NOT_FOUND);
  });

  // EF5: HttpException 409 → 409 + CONFLICT code
  it("EF5: HttpException 409 → 409 + conflict code", () => {
    const captured: CapturedResponse = {};
    filter.catch(new ConflictException("Duplicate"), makeHost({ requestId: REQ_ID }, captured));
    expect(captured.statusCode).toBe(409);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.code).toBe(ErrorCodes.CONFLICT);
  });

  // EF6: HttpException 429 → 429 + RATE_LIMITED code
  it("EF6: HttpException 429 → 429 + rate_limited code", () => {
    const captured: CapturedResponse = {};
    // HttpStatus.TOO_MANY_REQUESTS = 429; use raw HttpException to get exact status
    filter.catch(
      new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS),
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(429);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.code).toBe(ErrorCodes.RATE_LIMITED);
  });

  // EF7: HttpException with unknown status (503) → statusToCode default → INTERNAL code
  //      and statusDefaultMessage default branch → "Internal Server Error"
  it("EF7: HttpException 503 → internal_error code + statusDefaultMessage default", () => {
    const captured: CapturedResponse = {};
    // Object body with no message field → falls to statusDefaultMessage
    filter.catch(
      new HttpException({ statusCode: 503 }, 503),
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(503);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.code).toBe(ErrorCodes.INTERNAL);
    expect(body.error.message).toBe("Internal Server Error");
  });

  // EF8: HttpException with string response body → message taken from string
  it("EF8: HttpException with string response body → message from string", () => {
    const captured: CapturedResponse = {};
    // new HttpException("string-message", status) → getResponse() returns the string
    filter.catch(
      new HttpException("custom message", HttpStatus.NOT_FOUND),
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(404);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.message).toBe("custom message");
    expect(body.error.code).toBe(ErrorCodes.NOT_FOUND);
  });

  // EF9: HttpException with object response + string message field
  it("EF9: HttpException with object body + string message field", () => {
    const captured: CapturedResponse = {};
    filter.catch(
      new HttpException({ message: "validation failed", details: { field: "email" } }, HttpStatus.BAD_REQUEST),
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(400);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.message).toBe("validation failed");
    expect(body.error.details).toEqual({ field: "email" });
  });

  // EF10: HttpException with array message field (single item) → first item as message, no details
  it("EF10: array message field (1 item) → first item as message, no details", () => {
    const captured: CapturedResponse = {};
    filter.catch(
      new HttpException({ message: ["only error"] }, HttpStatus.BAD_REQUEST),
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(400);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.message).toBe("only error");
    // Single item array → details should be undefined (not present in envelope)
    expect(body.error.details).toBeUndefined();
  });

  // EF11: HttpException with array message field (multiple items) → first item + full array as details
  it("EF11: array message field (2+ items) → first item as message, full array as details", () => {
    const captured: CapturedResponse = {};
    filter.catch(
      new HttpException({ message: ["err1", "err2", "err3"] }, HttpStatus.BAD_REQUEST),
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(400);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.message).toBe("err1");
    expect(body.error.details).toEqual(["err1", "err2", "err3"]);
  });

  // EF12: HttpException with object body, no message field → falls back to statusDefaultMessage
  //       This exercises statusDefaultMessage non-default cases (lines 131-133)
  it("EF12a: object body + no message field (400) → statusDefaultMessage BAD_REQUEST", () => {
    const captured: CapturedResponse = {};
    filter.catch(
      new HttpException({ statusCode: 400 }, HttpStatus.BAD_REQUEST),
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(400);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.message).toBe("Bad Request");
  });

  it("EF12b: object body + no message field (401) → statusDefaultMessage UNAUTHORIZED", () => {
    const captured: CapturedResponse = {};
    filter.catch(
      new HttpException({ statusCode: 401 }, HttpStatus.UNAUTHORIZED),
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(401);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.message).toBe("Unauthorized");
  });

  it("EF12c: object body + no message field (403) → statusDefaultMessage FORBIDDEN", () => {
    const captured: CapturedResponse = {};
    filter.catch(
      new HttpException({ statusCode: 403 }, HttpStatus.FORBIDDEN),
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(403);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.message).toBe("Forbidden");
  });

  it("EF12d: object body + no message field (404) → statusDefaultMessage NOT_FOUND", () => {
    const captured: CapturedResponse = {};
    filter.catch(
      new HttpException({ statusCode: 404 }, HttpStatus.NOT_FOUND),
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(404);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.message).toBe("Not Found");
  });

  it("EF12e: object body + no message field (409) → statusDefaultMessage CONFLICT", () => {
    const captured: CapturedResponse = {};
    filter.catch(
      new HttpException({ statusCode: 409 }, HttpStatus.CONFLICT),
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(409);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.message).toBe("Conflict");
  });

  it("EF12f: object body + no message field (429) → statusDefaultMessage TOO_MANY_REQUESTS", () => {
    const captured: CapturedResponse = {};
    filter.catch(
      new HttpException({ statusCode: 429 }, HttpStatus.TOO_MANY_REQUESTS),
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(429);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.message).toBe("Too Many Requests");
  });

  // EF10b: HttpException with empty array message field → fallback to statusDefaultMessage
  it("EF10b: empty array message field → falls back to statusDefaultMessage", () => {
    const captured: CapturedResponse = {};
    filter.catch(
      new HttpException({ message: [] }, HttpStatus.BAD_REQUEST),
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(400);
    const body = captured.body as { error: Record<string, unknown> };
    // msg.length === 0 → fallback = statusDefaultMessage(400) = "Bad Request"
    expect(body.error.message).toBe("Bad Request");
    expect(body.error.details).toBeUndefined();
  });

  // EF13: Unhandled Error → 500 + INTERNAL + "Internal Server Error" (no leak)
  it("EF13: Unhandled Error → 500 + internal_error + generic message (no internal leak)", () => {
    const captured: CapturedResponse = {};
    filter.catch(
      new Error("DB connection refused: secret-internal-detail"),
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(500);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.code).toBe(ErrorCodes.INTERNAL);
    expect(body.error.message).toBe("Internal Server Error");
    expect(JSON.stringify(body)).not.toContain("secret-internal-detail");
  });

  it("EF13b: unhandled Error with SQL and a secret stays a generic 500", () => {
    const captured: CapturedResponse = {};
    filter.catch(
      new Error("password=secret SELECT token"),
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(500);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.message).toBe("Internal Server Error");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("SELECT");
  });

  // EF14: Unhandled non-Error (string thrown) → 500 + INTERNAL
  it("EF14: thrown string (non-Error) → 500 + internal_error", () => {
    const captured: CapturedResponse = {};
    filter.catch(
      "oops, something went wrong",
      makeHost({ requestId: REQ_ID }, captured),
    );
    expect(captured.statusCode).toBe(500);
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.code).toBe(ErrorCodes.INTERNAL);
    expect(body.error.message).toBe("Internal Server Error");
  });

  // EF15: request.requestId present → used as requestId in envelope
  it("EF15: request.requestId present → used in envelope", () => {
    const captured: CapturedResponse = {};
    filter.catch(
      new NotFoundException("test"),
      makeHost({ requestId: REQ_ID }, captured),
    );
    const body = captured.body as { error: Record<string, unknown> };
    expect(body.error.request_id).toBe(REQ_ID);
  });

  // EF16: request.requestId absent → newId() is called, envelope still has a valid requestId
  it("EF16: request.requestId absent → envelope has a generated requestId", () => {
    const captured: CapturedResponse = {};
    filter.catch(
      new NotFoundException("test"),
      makeHost({}, captured),
    );
    const body = captured.body as { error: Record<string, unknown> };
    expect(typeof body.error.request_id).toBe("string");
    expect(body.error.request_id as string).toMatch(UUID_RE);
    // Must not be the fixed REQ_ID since it was not on the request
    expect(body.error.request_id).not.toBe(REQ_ID);
  });
});
