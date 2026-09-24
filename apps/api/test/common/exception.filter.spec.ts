import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";

// Mock metric helpers BEFORE importing the filter so the filter binds
// to the spies. Lets us assert call shape without standing up an OTel
// SDK or scrape endpoint.
jest.mock("../../src/observability/metrics/api.metrics", () => ({
  __esModule: true,
  recordHttp4xxError: jest.fn(),
  recordHttp5xxError: jest.fn(),
  recordValidationFailure: jest.fn(),
}));

import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import {
  recordHttp4xxError,
  recordHttp5xxError,
  recordValidationFailure,
} from "../../src/observability/metrics/api.metrics";

interface CapturedResponse {
  statusCode?: number;
  body?: unknown;
}

interface FakeRequest {
  requestId?: string;
  /**
   * Mirrors Express's matched-route record. When present, the global
   * exception filter feeds this through to `routeTemplate` so error-path
   * metrics can recover the bounded route template even when Nest's
   * ArgumentsHost has already lost the controller-bound handler (PR-E).
   */
  route?: { path?: string };
}

interface FakeResponse {
  status: jest.Mock;
  json: jest.Mock;
  headersSent: boolean;
}

function makeHost(
  req: FakeRequest,
  captured: CapturedResponse,
  headersSent = false,
): {
  host: ArgumentsHost;
  res: FakeResponse;
} {
  const res: FakeResponse = {
    headersSent,
    status: jest.fn(function status(code: number) {
      captured.statusCode = code;
      return res;
    }),
    json: jest.fn(function json(body: unknown) {
      captured.body = body;
      return res;
    }),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

const REQ_ID = "018f3b1d-7c2a-7e3a-9bcd-0123456789ab";

function postgresError(code: string): Error {
  return Object.assign(new Error("SQL fragment: secret_inventory_column"), {
    code,
    severity: "ERROR",
    detail: "private row data",
    constraint: "secret_constraint",
  });
}

describe("GlobalExceptionFilter", () => {
  beforeEach(() => {
    (recordHttp4xxError as jest.Mock).mockClear();
    (recordHttp5xxError as jest.Mock).mockClear();
    (recordValidationFailure as jest.Mock).mockClear();
  });

  it("formats a NotFoundException as a 404 envelope", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    filter.catch(new NotFoundException("Tenant not found"), host);

    expect(captured.statusCode).toBe(HttpStatus.NOT_FOUND);
    expect(captured.body).toEqual({
      error: {
        code: "not_found",
        message: "Tenant not found",
        request_id: REQ_ID,
      },
    });
  });

  it("formats a ForbiddenException with the same envelope shape as a 404", () => {
    // FR-ISO-4: 403 and 404 share envelope shape.
    const filter = new GlobalExceptionFilter();
    const a: CapturedResponse = {};
    const b: CapturedResponse = {};
    filter.catch(
      new ForbiddenException("nope"),
      makeHost({ requestId: REQ_ID }, a).host,
    );
    filter.catch(
      new NotFoundException("nope"),
      makeHost({ requestId: REQ_ID }, b).host,
    );
    expect(Object.keys((a.body as { error: object }).error).sort()).toEqual(
      Object.keys((b.body as { error: object }).error).sort(),
    );
  });

  it("includes details when HttpException response carries them", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    filter.catch(
      new BadRequestException({
        message: "validation failed",
        details: { field: "email" },
      }),
      host,
    );
    expect(captured.statusCode).toBe(HttpStatus.BAD_REQUEST);
    const body = captured.body as {
      error: { code: string; details?: unknown };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details).toEqual({ field: "email" });
  });

  it("formats a ZodError as 400 with issues in details", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    const zodResult = z.object({ x: z.string() }).safeParse({ x: 42 });
    if (zodResult.success) throw new Error("expected zod failure");
    filter.catch(zodResult.error, host);

    expect(captured.statusCode).toBe(HttpStatus.BAD_REQUEST);
    const body = captured.body as {
      error: { code: string; details?: unknown[] };
    };
    expect(body.error.code).toBe("validation_error");
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  it("formats unknown errors as 500 with a generic message (no internal leak)", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    filter.catch(
      new Error("DB connection refused: secret-internal-detail"),
      host,
    );
    expect(captured.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = captured.body as { error: { message: string; code: string } };
    expect(body.error.code).toBe("internal_error");
    // No leakage of internal error message.
    expect(body.error.message).toBe("Internal Server Error");
  });

  it.each(["22003", "23514", "22P02"])(
    "maps PostgreSQL input error %s to a non-disclosing 400 envelope",
    (sqlState) => {
      const captured: CapturedResponse = {};
      const { host } = makeHost({ requestId: REQ_ID }, captured);
      new GlobalExceptionFilter().catch(postgresError(sqlState), host);

      expect(captured.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(captured.body).toEqual({
        error: {
          code: "validation_error",
          message: "Request validation failed",
          request_id: REQ_ID,
        },
      });
      expect(recordHttp4xxError).toHaveBeenCalledWith({
        route: "unknown",
        status: "400",
      });
      expect(recordHttp5xxError).not.toHaveBeenCalled();
    },
  );

  it("recognizes a PostgreSQL input error wrapped as an ORM cause", () => {
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    new GlobalExceptionFilter().catch(
      Object.assign(new Error("ORM query failed"), { cause: postgresError("22003") }),
      host,
    );
    expect(captured.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(captured.body).toMatchObject({
      error: { code: "validation_error", request_id: REQ_ID },
    });
  });

  it("keeps non-Postgres and unrelated SQLSTATE errors on the generic 500 path", () => {
    for (const error of [
      Object.assign(new Error("application failure"), { code: "22003" }),
      postgresError("23505"),
    ]) {
      const captured: CapturedResponse = {};
      new GlobalExceptionFilter().catch(
        error,
        makeHost({ requestId: REQ_ID }, captured).host,
      );
      expect(captured.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captured.body).toEqual({
        error: {
          code: "internal_error",
          message: "Internal Server Error",
          request_id: REQ_ID,
        },
      });
    }
  });

  it("mints a fresh request_id when the request is missing one", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({}, captured);
    filter.catch(new NotFoundException(), host);
    const body = captured.body as { error: { request_id: string } };
    expect(body.error.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  // ---- metric emission (signals.md §1) -----------------------------------

  it("calls recordHttp4xxError with the exact status for HttpException 4xx", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    filter.catch(new NotFoundException("nope"), host);

    expect(recordHttp4xxError).toHaveBeenCalledTimes(1);
    const call = (recordHttp4xxError as jest.Mock).mock.calls[0]?.[0] as {
      route: string;
      status: string;
    };
    // Fake ArgumentsHost lacks decorator metadata → routeTemplate returns
    // the "unknown" bounded fallback. Crucially NOT a rendered URL.
    expect(call.route).toBe("unknown");
    expect(call.status).toBe("404");
    expect(recordHttp5xxError).not.toHaveBeenCalled();
    expect(recordValidationFailure).not.toHaveBeenCalled();
  });

  it("calls recordHttp5xxError with status='500' for an unhandled Error", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    filter.catch(new Error("boom"), host);

    expect(recordHttp5xxError).toHaveBeenCalledTimes(1);
    expect((recordHttp5xxError as jest.Mock).mock.calls[0]?.[0]).toEqual({
      route: "unknown",
      status: "500",
    });
    expect(recordHttp4xxError).not.toHaveBeenCalled();
  });

  it("calls recordHttp5xxError for an HttpException 5xx", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    filter.catch(new HttpException("upstream", HttpStatus.BAD_GATEWAY), host);

    expect(recordHttp5xxError).toHaveBeenCalledTimes(1);
    expect((recordHttp5xxError as jest.Mock).mock.calls[0]?.[0]).toMatchObject({
      status: "502",
    });
    expect(recordHttp4xxError).not.toHaveBeenCalled();
  });

  it("calls recordValidationFailure and recordHttp4xxError on a ZodError", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    const zodResult = z.object({ x: z.string() }).safeParse({ x: 42 });
    if (zodResult.success) throw new Error("expected zod failure");
    filter.catch(zodResult.error, host);

    expect(recordValidationFailure).toHaveBeenCalledTimes(1);
    expect((recordValidationFailure as jest.Mock).mock.calls[0]?.[0]).toEqual({
      route: "unknown",
    });
    expect(recordHttp4xxError).toHaveBeenCalledTimes(1);
    expect((recordHttp4xxError as jest.Mock).mock.calls[0]?.[0]).toEqual({
      route: "unknown",
      status: "400",
    });
    expect(recordHttp5xxError).not.toHaveBeenCalled();
  });

  it("never records a forbidden label (no field_name on validation_failure_total)", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    const zodResult = z
      .object({ email: z.string().email() })
      .safeParse({ email: "not-an-email" });
    if (zodResult.success) throw new Error("expected zod failure");
    filter.catch(zodResult.error, host);

    // The attributes object MUST contain only `route` — no `field_name`,
    // no `email`, no field path. FR-B-006 + signals.md §1 note.
    const attrs = (recordValidationFailure as jest.Mock).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(Object.keys(attrs ?? {})).toEqual(["route"]);
  });

  it("envelope shape always has exactly { error: { code, message, request_id } } at minimum", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    filter.catch(new HttpException("x", HttpStatus.UNAUTHORIZED), host);
    expect(captured.body).toMatchObject({
      error: {
        code: "unauthorized",
        message: "x",
        request_id: REQ_ID,
      },
    });
    expect(Object.keys(captured.body as object)).toEqual(["error"]);
  });

  // ---- PR-E — route label uses request.route fallback --------------------
  // When a matched controller throws, Nest's ArgumentsHost loses
  // getClass/getHandler at the exception-filter boundary — but Express
  // has already populated `request.route.path` with the matched route
  // template. The filter feeds the request through `routeTemplate`, so
  // error-path metrics now carry the real route instead of "unknown".

  describe("route label — request.route fallback (PR-E)", () => {
    it("records the matched route template on http_error_4xx_total when request.route is bound", () => {
      const filter = new GlobalExceptionFilter();
      const captured: CapturedResponse = {};
      const { host } = makeHost(
        { requestId: REQ_ID, route: { path: "/api/v1/auth/signin" } },
        captured,
      );
      filter.catch(new HttpException("nope", HttpStatus.UNAUTHORIZED), host);

      expect(recordHttp4xxError).toHaveBeenCalledTimes(1);
      expect((recordHttp4xxError as jest.Mock).mock.calls[0]?.[0]).toEqual({
        route: "/api/v1/auth/signin",
        status: "401",
      });
    });

    it("records the matched route template on validation_failure_total when request.route is bound", () => {
      const filter = new GlobalExceptionFilter();
      const captured: CapturedResponse = {};
      const { host } = makeHost(
        { requestId: REQ_ID, route: { path: "/api/v1/auth/signin" } },
        captured,
      );
      const zodResult = z.object({ x: z.string() }).safeParse({ x: 42 });
      if (zodResult.success) throw new Error("expected zod failure");
      filter.catch(zodResult.error, host);

      expect(recordValidationFailure).toHaveBeenCalledTimes(1);
      expect((recordValidationFailure as jest.Mock).mock.calls[0]?.[0]).toEqual({
        route: "/api/v1/auth/signin",
      });
      expect((recordHttp4xxError as jest.Mock).mock.calls[0]?.[0]).toEqual({
        route: "/api/v1/auth/signin",
        status: "400",
      });
    });

    it("falls back to 'unknown' for genuine unmatched 404s (no request.route)", () => {
      // An unmatched URL never gets a `route` record bound by Express.
      // The filter must still emit a bounded label — "unknown" is correct.
      const filter = new GlobalExceptionFilter();
      const captured: CapturedResponse = {};
      const { host } = makeHost({ requestId: REQ_ID }, captured);
      filter.catch(new NotFoundException("nope"), host);

      expect((recordHttp4xxError as jest.Mock).mock.calls[0]?.[0]).toEqual({
        route: "unknown",
        status: "404",
      });
    });
  });

  // ---- headersSent guard — post-response race (fix for ERR_HTTP_HEADERS_SENT) ----
  // When IdempotencyInterceptor (or any tap.next) commits a response before an
  // async throw reaches this filter, response.headersSent is already true.
  // The filter must return without emitting a second response or recording a
  // spurious http_error_5xx_total increment.

  describe("headersSent guard — post-response race", () => {
    it("returns without calling status/json or recording any metric when headersSent=true and exception is an Error", () => {
      const filter = new GlobalExceptionFilter();
      const captured: CapturedResponse = {};
      const { host, res } = makeHost({ requestId: REQ_ID }, captured, true);
      filter.catch(new Error("async post-response throw"), host);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(recordHttp5xxError).not.toHaveBeenCalled();
      expect(recordHttp4xxError).not.toHaveBeenCalled();
      expect(recordValidationFailure).not.toHaveBeenCalled();
      expect(captured.statusCode).toBeUndefined();
      expect(captured.body).toBeUndefined();
    });

    it("returns without calling status/json or recording any metric when headersSent=true and exception is an HttpException 5xx", () => {
      const filter = new GlobalExceptionFilter();
      const captured: CapturedResponse = {};
      const { host, res } = makeHost({ requestId: REQ_ID }, captured, true);
      filter.catch(new HttpException("upstream down", HttpStatus.BAD_GATEWAY), host);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(recordHttp5xxError).not.toHaveBeenCalled();
      expect(recordHttp4xxError).not.toHaveBeenCalled();
      expect(captured.statusCode).toBeUndefined();
    });
  });
});
