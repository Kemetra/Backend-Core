/**
 * RT-616 — successful `GET /api/v1/health/live` probes are not request-logged.
 *
 * VN-S6 POS terminals probe the liveness route every 10 s (owner decision on
 * RT-600, 2026-10-17). A 2xx/3xx answer on that route writes no "request
 * completed" line; a failure on it is still logged, and every other route
 * (including `/api/v1/health/ready`) logs exactly as before.
 */
import "reflect-metadata";

import {
  Controller,
  Get,
  ServiceUnavailableException,
  type CallHandler,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { lastValueFrom, of, throwError } from "rxjs";
import request from "supertest";

// Keep the interceptor off the real OTel instruments (same as logging.interceptor.spec.ts).
jest.mock("../../src/observability/metrics/api.metrics", () => ({
  __esModule: true,
  recordHttpRequest: jest.fn(),
  recordHttpDuration: jest.fn(),
}));

import { createLogger, type Logger } from "@data-pulse-2/shared";
import { LoggingInterceptor } from "../../src/common/logging.interceptor";
import { HealthController } from "../../src/health/health.controller";
import { HealthService } from "../../src/health/health.service";
import { recordHttpRequest } from "../../src/observability/metrics/api.metrics";

interface CapturedCall {
  level: "info" | "error";
  obj: Record<string, unknown>;
  msg: unknown;
}

function makeCapturingLogger(): { logger: Logger; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const logger = createLogger({ service: "api-test" });
  const realChild = logger.child.bind(logger);
  jest.spyOn(logger, "child").mockImplementation((bindings, options) => {
    const child = realChild(bindings, options);
    jest.spyOn(child, "info").mockImplementation((obj: unknown, msg?: unknown) => {
      calls.push({ level: "info", obj: obj as Record<string, unknown>, msg });
    });
    jest.spyOn(child, "error").mockImplementation((obj: unknown, msg?: unknown) => {
      calls.push({ level: "error", obj: obj as Record<string, unknown>, msg });
    });
    return child;
  });
  return { logger, calls };
}

@Controller("api/v1/probe-other")
class OtherController {
  @Get()
  ok(): { ok: true } {
    return { ok: true };
  }
}

describe("LoggingInterceptor — /api/v1/health/live over HTTP", () => {
  let app: INestApplication;
  let cap: ReturnType<typeof makeCapturingLogger>;
  let readiness: jest.Mock;

  beforeEach(async () => {
    cap = makeCapturingLogger();
    readiness = jest.fn().mockResolvedValue({ status: "ready", checks: {} });
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController, OtherController],
      providers: [{ provide: HealthService, useValue: { readiness } }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalInterceptors(new LoggingInterceptor(cap.logger));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("a 200 on /api/v1/health/live writes no request log line", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(cap.calls).toEqual([]);
  });

  it("a query string does not bring the probe log back", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/health/live?t=1");
    expect(res.status).toBe(200);
    expect(cap.calls).toEqual([]);
  });

  it("still counts the probe in the HTTP metrics", async () => {
    await request(app.getHttpServer()).get("/api/v1/health/live");
    expect(recordHttpRequest).toHaveBeenCalledWith({
      route: "/api/v1/health/live",
      method: "GET",
      status_class: "2xx",
    });
  });

  it("other routes are still logged", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/probe-other");
    expect(res.status).toBe(200);
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0]).toMatchObject({
      level: "info",
      msg: "request completed",
      obj: { method: "GET", route: "/api/v1/probe-other", status: 200 },
    });
  });

  it("/api/v1/health/ready is still logged, ready or not", async () => {
    await request(app.getHttpServer()).get("/api/v1/health/ready").expect(200);
    readiness.mockResolvedValueOnce({ status: "not_ready", checks: {} });
    await request(app.getHttpServer()).get("/api/v1/health/ready").expect(503);

    expect(cap.calls.map((c) => [c.level, c.obj["route"], c.obj["status"]])).toEqual([
      ["info", "/api/v1/health/ready", 200],
      ["info", "/api/v1/health/ready", 503],
    ]);
  });
});

describe("LoggingInterceptor — failures on /api/v1/health/live", () => {
  function liveContext(statusCode: number): ExecutionContext {
    const req = { method: "GET", url: "/api/v1/health/live", requestId: "rid" };
    return {
      getClass: () => HealthController,
      getHandler: () => HealthController.prototype.live,
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({ statusCode }),
      }),
    } as unknown as ExecutionContext;
  }

  it("an error thrown on the route is still logged", async () => {
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const handler: CallHandler = {
      handle: () => throwError(() => new ServiceUnavailableException()),
    };

    await expect(lastValueFrom(interceptor.intercept(liveContext(200), handler))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0]).toMatchObject({
      level: "error",
      msg: "request errored",
      obj: { route: "/api/v1/health/live", status: 503 },
    });
  });

  it("a non-error response with a 4xx/5xx status on the route is still logged", async () => {
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);

    await lastValueFrom(interceptor.intercept(liveContext(503), { handle: () => of({}) }));

    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0]).toMatchObject({
      level: "info",
      msg: "request completed",
      obj: { route: "/api/v1/health/live", status: 503 },
    });
  });
});
