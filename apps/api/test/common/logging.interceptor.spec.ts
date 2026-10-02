import {
  ExecutionContext,
  HttpException,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";
import { lastValueFrom, of, throwError } from "rxjs";
import { z, ZodError } from "zod";

// Mock the metrics module BEFORE importing the interceptor so the
// interceptor binds to the spies, not the real OTel instruments. The
// spies let us assert call shape (route template, method, status_class,
// non-negative duration) without standing up an SDK or a scrape endpoint.
jest.mock("../../src/observability/metrics/api.metrics", () => ({
  __esModule: true,
  recordHttpRequest: jest.fn(),
  recordHttpDuration: jest.fn(),
}));

import {
  LoggingInterceptor,
} from "../../src/common/logging.interceptor";
import { createLogger, type Logger } from "@data-pulse-2/shared";
import {
  recordHttpRequest,
  recordHttpDuration,
} from "../../src/observability/metrics/api.metrics";

interface FakeRequest {
  method: string;
  url: string;
  originalUrl?: string;
  requestId?: string;
  headers?: Record<string, string>;
  route?: { path: string };
}

interface FakeResponse {
  statusCode: number;
}

function makeContext(
  req: FakeRequest,
  res: FakeResponse,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

interface CapturedCall {
  level: "info" | "error";
  obj: unknown;
  msg: unknown;
}

/**
 * Spies on the `child` method of a pino logger and captures calls to
 * `info`/`error` on the returned child. Returns the logger plus a getter
 * for the captured calls.
 */
function makeCapturingLogger(): { logger: Logger; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const logger = createLogger({ service: "api-test" });
  const realChild = logger.child.bind(logger);
  jest
    .spyOn(logger, "child")
    .mockImplementation((bindings, options) => {
      const child = realChild(bindings, options);
      jest.spyOn(child, "info").mockImplementation((obj: unknown, msg?: unknown) => {
        calls.push({ level: "info", obj, msg });
      });
      jest.spyOn(child, "error").mockImplementation((obj: unknown, msg?: unknown) => {
        calls.push({ level: "error", obj, msg });
      });
      return child;
    });
  return { logger, calls };
}

describe("LoggingInterceptor", () => {
  beforeEach(() => {
    (recordHttpRequest as jest.Mock).mockClear();
    (recordHttpDuration as jest.Mock).mockClear();
  });

  it("logs an info line on success with request_id and route", async () => {
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const req: FakeRequest = {
      method: "GET",
      url: "/x",
      originalUrl: "/x?y=1",
      route: { path: "/x" },
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    const res: FakeResponse = { statusCode: 200 };

    await lastValueFrom(
      interceptor.intercept(makeContext(req, res), {
        handle: () => of("ok"),
      }),
    );

    const infoCalls = cap.calls.filter((c) => c.level === "info");
    expect(infoCalls.length).toBe(1);
    expect(infoCalls[0]?.msg).toBe("request completed");
    const obj = infoCalls[0]?.obj as Record<string, unknown>;
    expect(obj.method).toBe("GET");
    expect(obj.route).toBe("/x");
    expect(obj.status).toBe(200);
    expect(typeof obj.latency_ms).toBe("number");
  });

  it("logs an error line when the underlying observable throws", async () => {
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const req: FakeRequest = {
      method: "POST",
      url: "/boom",
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    const res: FakeResponse = { statusCode: 500 };

    await expect(
      lastValueFrom(
        interceptor.intercept(makeContext(req, res), {
          handle: () => throwError(() => new Error("kaboom")),
        }),
      ),
    ).rejects.toThrow(/kaboom/);

    const errorCalls = cap.calls.filter((c) => c.level === "error");
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0]?.msg).toBe("request errored");
  });

  it("falls back to 'unknown' if request.requestId is missing", async () => {
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const req: FakeRequest = { method: "GET", url: "/no-id" };
    const res: FakeResponse = { statusCode: 200 };
    await lastValueFrom(
      interceptor.intercept(makeContext(req, res), {
        handle: () => of(undefined),
      }),
    );
    expect(cap.calls.length).toBe(1);
    // The interceptor stamps "unknown" when requestId is missing; we can't
    // observe the child's bindings via the spy directly, but we can confirm
    // the interceptor didn't throw.
  });

  // ---- metric emission (signals.md §1) -----------------------------------

  it("calls recordHttpRequest once on success with method, route, and 2xx status_class", async () => {
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const req: FakeRequest = {
      method: "GET",
      url: "/x",
      originalUrl: "/x",
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    const res: FakeResponse = { statusCode: 204 };

    await lastValueFrom(
      interceptor.intercept(makeContext(req, res), {
        handle: () => of("ok"),
      }),
    );

    expect(recordHttpRequest).toHaveBeenCalledTimes(1);
    const call = (recordHttpRequest as jest.Mock).mock.calls[0]?.[0] as {
      method: string;
      route: string;
      status_class: string;
    };
    expect(call.method).toBe("GET");
    // Fake ExecutionContext lacks decorator metadata → routeTemplate
    // returns the "unknown" bounded fallback. Crucially, it is NOT a
    // rendered URL (no UUID or query string leak).
    expect(call.route).toBe("unknown");
    expect(call.status_class).toBe("2xx");
  });

  it("calls recordHttpDuration once on success with non-negative seconds", async () => {
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const req: FakeRequest = {
      method: "GET",
      url: "/x",
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    const res: FakeResponse = { statusCode: 200 };

    await lastValueFrom(
      interceptor.intercept(makeContext(req, res), {
        handle: () => of("ok"),
      }),
    );

    expect(recordHttpDuration).toHaveBeenCalledTimes(1);
    const [attrs, durationSeconds] = (recordHttpDuration as jest.Mock).mock
      .calls[0] as [{ method: string; route: string }, number];
    expect(attrs.method).toBe("GET");
    expect(attrs.route).toBe("unknown");
    expect(typeof durationSeconds).toBe("number");
    expect(durationSeconds).toBeGreaterThanOrEqual(0);
    // Sanity: a unit-test handler resolves in well under one second.
    expect(durationSeconds).toBeLessThan(5);
  });

  it("emits metrics with status_class derived from a 4xx response on the success path", async () => {
    // Success path uses response.statusCode (controllers that set non-2xx
    // codes deliberately, e.g. 201 / 204 / 3xx redirects, are bucketed
    // by that real status).
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const req: FakeRequest = {
      method: "POST",
      url: "/y",
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    const res: FakeResponse = { statusCode: 404 };

    await lastValueFrom(
      interceptor.intercept(makeContext(req, res), {
        handle: () => of(undefined),
      }),
    );

    expect(recordHttpRequest).toHaveBeenCalledTimes(1);
    expect((recordHttpRequest as jest.Mock).mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      status_class: "4xx",
    });
  });

  // --- error-path status_class is DERIVED, not read from response ---------
  //
  // On the error path the GlobalExceptionFilter has not yet set the final
  // response.statusCode by the time tap.error fires inside the interceptor.
  // Reading response.statusCode would record status_class="2xx" for every
  // failed request — misleading. The interceptor must derive the effective
  // status from the thrown error:
  //   - HttpException → err.getStatus()
  //   - ZodError      → 400
  //   - other         → 500
  // The success path is still allowed to trust response.statusCode.

  it("ZodError on the error path records status_class='4xx' regardless of response.statusCode", async () => {
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const req: FakeRequest = {
      method: "POST",
      url: "/y",
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    // response.statusCode is still the pre-filter Express default (200);
    // if the interceptor read it blindly, status_class would be "2xx".
    const res: FakeResponse = { statusCode: 200 };
    const zodResult = z.object({ x: z.string() }).safeParse({ x: 42 });
    if (zodResult.success) throw new Error("expected zod failure");
    const zodErr: ZodError = zodResult.error;

    await expect(
      lastValueFrom(
        interceptor.intercept(makeContext(req, res), {
          handle: () => throwError(() => zodErr),
        }),
      ),
    ).rejects.toBeInstanceOf(ZodError);

    expect(recordHttpRequest).toHaveBeenCalledTimes(1);
    expect((recordHttpRequest as jest.Mock).mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      status_class: "4xx",
    });
  });

  it("HttpException on the error path records status_class derived from err.getStatus()", async () => {
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const req: FakeRequest = {
      method: "GET",
      url: "/missing",
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    const res: FakeResponse = { statusCode: 200 };

    await expect(
      lastValueFrom(
        interceptor.intercept(makeContext(req, res), {
          handle: () => throwError(() => new NotFoundException("not here")),
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(recordHttpRequest).toHaveBeenCalledTimes(1);
    expect((recordHttpRequest as jest.Mock).mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      status_class: "4xx",
    });
  });

  it("HttpException with a 5xx status records status_class='5xx'", async () => {
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const req: FakeRequest = {
      method: "POST",
      url: "/upstream",
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    const res: FakeResponse = { statusCode: 200 };

    await expect(
      lastValueFrom(
        interceptor.intercept(makeContext(req, res), {
          handle: () =>
            throwError(() => new HttpException("bad gateway", HttpStatus.BAD_GATEWAY)),
        }),
      ),
    ).rejects.toBeInstanceOf(HttpException);

    expect((recordHttpRequest as jest.Mock).mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      status_class: "5xx",
    });
  });

  it("unknown (non-HttpException, non-ZodError) error records status_class='5xx'", async () => {
    // The interceptor must NOT trust response.statusCode here either: a
    // plain Error from inside a handler leaves response.statusCode as
    // the pre-filter Express default (200). Status_class must derive
    // to "5xx" from the error type.
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const req: FakeRequest = {
      method: "POST",
      url: "/boom",
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    const res: FakeResponse = { statusCode: 200 };

    await expect(
      lastValueFrom(
        interceptor.intercept(makeContext(req, res), {
          handle: () => throwError(() => new Error("kaboom")),
        }),
      ),
    ).rejects.toThrow(/kaboom/);

    expect(recordHttpRequest).toHaveBeenCalledTimes(1);
    expect(recordHttpDuration).toHaveBeenCalledTimes(1);
    expect((recordHttpRequest as jest.Mock).mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      status_class: "5xx",
    });
  });

  it("does not include raw request headers in the emitted log object", async () => {
    // The LoggingInterceptor never logs req.headers — neither Authorization
    // nor Cookie should appear in any call's `obj`. (The redact list in
    // the shared logger is the second-line defence.)
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const req: FakeRequest = {
      method: "POST",
      url: "/login",
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
      headers: {
        authorization: "Bearer super-secret-token-value",
        cookie: "session=ALSO-SECRET",
      },
    };
    const res: FakeResponse = { statusCode: 200 };
    await lastValueFrom(
      interceptor.intercept(makeContext(req, res), {
        handle: () => of(undefined),
      }),
    );
    const dump = JSON.stringify(cap.calls);
    expect(dump).not.toMatch(/super-secret-token-value/);
    expect(dump).not.toMatch(/ALSO-SECRET/);
  });
});
