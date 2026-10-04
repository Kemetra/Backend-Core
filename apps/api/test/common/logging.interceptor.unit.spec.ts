/**
 * logging.interceptor.unit.spec.ts
 *
 * Docker-free unit coverage for LoggingInterceptor.
 *
 * Strategy: mock `@data-pulse-2/shared` so that `withRequestContext` returns
 * the rootLogger unchanged. This allows us to assert on:
 *   - the args passed to withRequestContext (request_id binding)
 *   - the info/error log calls made by the interceptor
 *
 * Tests:
 *   LI1 – success path → childLogger.info called with "request completed"
 *   LI2 – success path → latency_ms is a number >= 0
 *   LI3 – success path → method and route taken from request
 *   LI4 – error path → childLogger.error called with "request errored" + err field
 *   LI5 – requestId absent → request_id is "unknown" passed to withRequestContext
 *   LI6 – requestId present → request_id matches in withRequestContext call
 *   LI7-LI11 – logged status matches GlobalExceptionFilter for PostgreSQL
 *              input errors (400) and for everything else (500) (RT-60)
 *   LI12-LI16 – RT-124 (RT-120 A10): route is the template, never the
 *              rendered URL; client errors log class + status/code only
 */
import "reflect-metadata";

import { BadRequestException, type CallHandler, type ExecutionContext } from "@nestjs/common";
import { z } from "zod";
import { of, throwError } from "rxjs";
import { LoggingInterceptor } from "../../src/common/logging.interceptor";

// ---------------------------------------------------------------------------
// Module mock — must be before any imports that depend on @data-pulse-2/shared
// ---------------------------------------------------------------------------

jest.mock("@data-pulse-2/shared", () => {
  // Minimal noop OTel instrument shape used by api.metrics.ts at module load.
  // The unit suite stays OTel-free; api.metrics is loaded transitively by
  // the interceptor (it imports the emission helpers), so getMeter and
  // assertMetricLabels must resolve to something callable.
  const noopCounter = { add: jest.fn() };
  const noopHistogram = { record: jest.fn() };
  const noopGauge = { addCallback: jest.fn() };
  const noopMeter = {
    createCounter: jest.fn(() => noopCounter),
    createHistogram: jest.fn(() => noopHistogram),
    createObservableGauge: jest.fn(() => noopGauge),
  };
  return {
    withRequestContext: jest.fn((logger: unknown) => logger),
    // T474: LoggingInterceptor now reads the active OTel trace-id to
    // populate `correlation_id`, falling back to the supplied request_id.
    // The unit suite stays Docker-free / OTel-free, so the helper is
    // stubbed to return its fallback verbatim — the interceptor's
    // behavior is unchanged from the unit's perspective.
    getCorrelationId: jest.fn((fallback: string) => fallback),
    // Required by api.metrics.ts module body (transitively imported by
    // the interceptor). The mock is a no-op — emission assertions live
    // in the integration spec, not here.
    getMeter: jest.fn(() => noopMeter),
    assertMetricLabels: jest.fn(),
  };
});

// Import AFTER mock registration so the mock is in place
import { withRequestContext } from "@data-pulse-2/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeRequest {
  method: string;
  url: string;
  originalUrl?: string;
  requestId?: string;
  route?: { path: string };
}

interface FakeResponse {
  statusCode: number;
}

function makeCtx(req: FakeRequest, res: FakeResponse): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
      getResponse: <T>() => res as unknown as T,
    }),
  } as unknown as ExecutionContext;
}

function subscribeToCompletion(
  interceptor: LoggingInterceptor,
  ctx: ExecutionContext,
  handler: CallHandler,
): Promise<void> {
  return new Promise<void>((resolve) => {
    interceptor.intercept(ctx, handler).subscribe({
      next: () => { /* noop */ },
      error: () => resolve(), // resolve on error too — we checked the log call
      complete: () => resolve(),
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LoggingInterceptor – unit", () => {
  let fakeLogger: { info: jest.Mock; error: jest.Mock; child: jest.Mock };
  let interceptor: LoggingInterceptor;

  beforeEach(() => {
    fakeLogger = {
      info: jest.fn(),
      error: jest.fn(),
      child: jest.fn(),
    };
    interceptor = new LoggingInterceptor(fakeLogger as never);
    // Reset the withRequestContext mock — restoreMocks only resets spies on real
    // objects, not module-level jest.fn()s; we do it manually.
    (withRequestContext as jest.Mock).mockClear();
    (withRequestContext as jest.Mock).mockImplementation((logger: unknown) => logger);
  });

  // LI1: success path → childLogger.info called with "request completed"
  it("LI1: success path → info logged with 'request completed'", async () => {
    const req: FakeRequest = {
      method: "GET",
      url: "/api/items",
      originalUrl: "/api/items?page=1",
      route: { path: "/api/items" },
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    const res: FakeResponse = { statusCode: 200 };
    const handler: CallHandler = { handle: () => of("response-value") };

    await subscribeToCompletion(interceptor, makeCtx(req, res), handler);

    expect(fakeLogger.info).toHaveBeenCalledTimes(1);
    const [obj, msg] = fakeLogger.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe("request completed");
    expect(obj.method).toBe("GET");
    expect(obj.route).toBe("/api/items");
    expect(obj.status).toBe(200);
  });

  // LI2: success path → latency_ms is a number >= 0
  it("LI2: success path → latency_ms is a non-negative number", async () => {
    const req: FakeRequest = { method: "GET", url: "/ping", requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab" };
    const res: FakeResponse = { statusCode: 200 };
    const handler: CallHandler = { handle: () => of(null) };

    await subscribeToCompletion(interceptor, makeCtx(req, res), handler);

    const [obj] = fakeLogger.info.mock.calls[0] as [Record<string, unknown>];
    expect(typeof obj.latency_ms).toBe("number");
    expect(obj.latency_ms as number).toBeGreaterThanOrEqual(0);
  });

  // LI3: success path → method and route are from the request
  it("LI3: method and route come from request fields", async () => {
    const req: FakeRequest = {
      method: "POST",
      url: "/api/tenants",
      originalUrl: "/api/tenants",
      route: { path: "/api/tenants" },
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    const res: FakeResponse = { statusCode: 201 };
    const handler: CallHandler = { handle: () => of({ id: "1" }) };

    await subscribeToCompletion(interceptor, makeCtx(req, res), handler);

    const [obj] = fakeLogger.info.mock.calls[0] as [Record<string, unknown>];
    expect(obj.method).toBe("POST");
    expect(obj.route).toBe("/api/tenants");
    expect(obj.status).toBe(201);
  });

  // LI4: error path → childLogger.error called with "request errored" + err field
  it("LI4: error path → error logged with 'request errored' and err field", async () => {
    const req: FakeRequest = {
      method: "DELETE",
      url: "/api/items/1",
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    const res: FakeResponse = { statusCode: 500 };
    const boom = new Error("database exploded");
    const handler: CallHandler = { handle: () => throwError(() => boom) };

    await subscribeToCompletion(interceptor, makeCtx(req, res), handler);

    expect(fakeLogger.error).toHaveBeenCalledTimes(1);
    const [obj, msg] = fakeLogger.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe("request errored");
    expect(obj.err).toBe(boom);
    expect(typeof obj.latency_ms).toBe("number");
  });

  // LI5: requestId absent → request_id is "unknown" in withRequestContext call
  it("LI5: requestId absent → withRequestContext receives request_id 'unknown'", async () => {
    const req: FakeRequest = { method: "GET", url: "/no-id" };
    const res: FakeResponse = { statusCode: 200 };
    const handler: CallHandler = { handle: () => of(undefined) };

    await subscribeToCompletion(interceptor, makeCtx(req, res), handler);

    expect(withRequestContext).toHaveBeenCalledWith(
      fakeLogger,
      expect.objectContaining({ request_id: "unknown" }),
    );
  });

  // LI6: requestId present → request_id matches in withRequestContext call
  it("LI6: requestId present → withRequestContext receives correct request_id", async () => {
    const reqId = "018f3b1d-7c2a-7e3a-9bcd-0123456789ab";
    const req: FakeRequest = { method: "GET", url: "/api/x", requestId: reqId };
    const res: FakeResponse = { statusCode: 200 };
    const handler: CallHandler = { handle: () => of(undefined) };

    await subscribeToCompletion(interceptor, makeCtx(req, res), handler);

    expect(withRequestContext).toHaveBeenCalledWith(
      fakeLogger,
      expect.objectContaining({ request_id: reqId }),
    );
  });

  // LI7-LI11 (RT-60): GlobalExceptionFilter answers a PostgreSQL input error
  // (22003 / 23514 / 22P02, and 22007 / 22008 since RT-180) with 400. The request log must record that 400,
  // not the unhandled-error 500.
  function pgError(code: string): Error & { code: string; severity: string } {
    return Object.assign(new Error(`pg ${code}`), { code, severity: "ERROR" });
  }

  async function loggedErrorStatus(err: unknown): Promise<unknown> {
    const req: FakeRequest = {
      method: "POST",
      url: "/api/v1/catalog/erpnext-item-mappings/x/confirm",
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    const handler: CallHandler = { handle: () => throwError(() => err) };
    await subscribeToCompletion(interceptor, makeCtx(req, { statusCode: 200 }), handler);
    expect(fakeLogger.error).toHaveBeenCalledTimes(1);
    const [obj] = fakeLogger.error.mock.calls[0] as [Record<string, unknown>];
    return obj.status;
  }

  it.each(["22003", "23514", "22P02", "22007", "22008"])(
    "LI7: PostgreSQL input error %s → logged status 400",
    async (code) => {
      expect(await loggedErrorStatus(pgError(code))).toBe(400);
    },
  );

  it("LI8: PostgreSQL input error wrapped in `cause` (Drizzle) → logged status 400", async () => {
    const wrapped = Object.assign(new Error("query failed"), { cause: pgError("22003") });
    expect(await loggedErrorStatus(wrapped)).toBe(400);
  });

  it("LI9: SQLSTATE-like code without a pg severity → still logged as 500", async () => {
    const notPg = Object.assign(new Error("looks like pg"), { code: "22003" });
    expect(await loggedErrorStatus(notPg)).toBe(500);
  });

  it("LI10: other PostgreSQL errors (e.g. 40P01) → still logged as 500", async () => {
    expect(await loggedErrorStatus(pgError("40P01"))).toBe(500);
  });

  it("LI11: genuine unhandled error → logged status 500", async () => {
    expect(await loggedErrorStatus(new Error("database exploded"))).toBe(500);
  });

  // LI12-LI16 (RT-124 / RT-120 A10)
  async function loggedError(err: unknown): Promise<Record<string, unknown>> {
    const req: FakeRequest = {
      method: "POST",
      url: "/api/v1/tenants/0190f1cf-0000-7000-8000-000000000001?email=a%40b.c",
      route: { path: "/api/v1/tenants/:id" },
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    const handler: CallHandler = { handle: () => throwError(() => err) };
    await subscribeToCompletion(interceptor, makeCtx(req, { statusCode: 200 }), handler);
    const [obj] = fakeLogger.error.mock.calls[0] as [Record<string, unknown>];
    return obj;
  }

  it("LI12: route is the matched template, never the rendered URL", async () => {
    const obj = await loggedError(new Error("x"));
    expect(obj.route).toBe("/api/v1/tenants/:id");
    expect(JSON.stringify(obj)).not.toContain("0190f1cf");
  });

  it("LI13: HttpException → class and status only, not its message", async () => {
    const obj = await loggedError(new BadRequestException("bad value: secret@example.com"));
    expect(obj).toMatchObject({ err_class: "BadRequestException", err_status: 400 });
    expect(obj).not.toHaveProperty("err");
    expect(JSON.stringify(obj)).not.toContain("secret@example.com");
  });

  it("LI14: ZodError → issue count only, not the issues", async () => {
    const parsed = z.object({ email: z.string().email() }).safeParse({ email: "not-an-email" });
    const obj = await loggedError(parsed.success ? new Error("unreachable") : parsed.error);
    expect(obj).toMatchObject({ err_class: "ZodError", err_issue_count: 1 });
    expect(JSON.stringify(obj)).not.toContain("not-an-email");
  });

  it("LI15: PostgreSQL input error → SQLSTATE only, not the quoted value", async () => {
    const obj = await loggedError(
      Object.assign(new Error('invalid input syntax for type uuid: "leaked-value"'), {
        code: "22P02",
        severity: "ERROR",
      }),
    );
    expect(obj).toMatchObject({ err_code: "22P02", status: 400 });
    expect(JSON.stringify(obj)).not.toContain("leaked-value");
  });

  it("LI16: genuine server fault keeps the err for diagnosis", async () => {
    const boom = new Error("database exploded");
    const obj = await loggedError(boom);
    expect(obj.err).toBe(boom);
  });
});
