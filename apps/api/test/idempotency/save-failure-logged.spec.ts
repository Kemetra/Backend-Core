/**
 * ADR 0010 D1 — idempotency store save-failure is LOGGED, not silently swallowed.
 *
 * Audit finding M-5: `IdempotencyInterceptor` persists the replay record
 * best-effort. If `store.save` fails (Redis outage), the OLD behaviour was a bare
 * `.catch(() => undefined)` — the degradation was invisible, so a subsequent retry
 * silently re-executes the handler (for settlement intents → duplicate rows, since
 * they have no second dedup layer; see ADR 0010 context).
 *
 * D1 (the ungated mitigation) replaces the silent catch with a structured WARN log
 * so the degraded state is observable. The three D1 guarantees this pins:
 *   (a) on save failure, `logger.warn` fires with the error;
 *   (b) the handler response is STILL returned (no behaviour change for the caller);
 *   (c) nothing throws — D1 explicitly ruled out 503-hard-fail (the side effect
 *       already happened; failing the request just hides it and is incoherent with
 *       ADR 0009 D3). The catch must log-AND-SWALLOW.
 *
 * The metric/alert counter (the other half of D1) is AD-TOOL-003-phase-gated and is
 * NOT in this slice — warn-log only.
 *
 * Docker-free unit test. Fake store whose save rejects; spy logger.
 */
import "reflect-metadata";
import {
  Controller,
  HttpStatus,
  Post,
  Res,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Response } from "express";
import request from "supertest";

import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { ROOT_LOGGER } from "../../src/common/logging.interceptor";
import { Idempotent } from "../../src/idempotency/idempotent.decorator";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../src/idempotency/idempotency.interceptor";
import { InProgressMarker, INFLIGHT_REDIS } from "../../src/idempotency/in-progress-marker";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";

const KEY = "abcdef1234567890abcdef1234567510"; // 32 chars, valid

/**
 * Redis fake whose GET always misses (lookup → handler runs) but whose SET
 * REJECTS — this is the Redis-outage-on-write the D1 mitigation must log+swallow.
 * Using the REAL IdempotencyKeyStore over this fake keeps the findOrCreate /
 * save contract faithful (a hand-rolled store would diverge from the interceptor's
 * expected FindOrCreateResult shape).
 */
class SaveFailingRedis {
  public setCalls = 0;
  async get(): Promise<string | null> { return null; } // always a miss → handler runs
  async set(): Promise<never> {
    this.setCalls += 1;
    throw new Error("redis down: save failed");
  }
}

class FakeMarker {
  async trySet(): Promise<boolean> { return true; }
  async del(): Promise<void> { /* no-op */ }
}

@Controller("test-save-fail")
class TestController {
  public callCount = 0;
  @Post()
  @Idempotent("required")
  async create(@Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    this.callCount += 1;
    res.status(HttpStatus.CREATED);
    return { ok: true };
  }
}

describe("ADR 0010 D1 — store.save failure is logged + swallowed, response still returned", () => {
  let app: INestApplication;
  let controller: TestController;
  let failingRedis: SaveFailingRedis;
  let pgInsertCalls = 0;
  let warnSpy: jest.Mock;
  let errorSpy: jest.Mock;

  beforeAll(async () => {
    failingRedis = new SaveFailingRedis();
    warnSpy = jest.fn();
    errorSpy = jest.fn();
    const logger = { warn: warnSpy, error: errorSpy, info: jest.fn(), debug: jest.fn() };
    // Real store over the failing redis + a failing pg mirror. `save` writes the
    // durable pg mirror first, so its rejection surfaces before Redis is touched;
    // the interceptor's catch is the only thing standing between the failure and
    // the response. Lookup (`get` → null) still misses → handler runs.
    const store = new IdempotencyKeyStore({
      redis: failingRedis,
      pgWriter: {
        async insert() {
          pgInsertCalls += 1;
          throw new Error("pg down: insert failed");
        },
      },
      pgReader: { async find() { return null; } },
      defaultTtlMs: 72 * 60 * 60 * 1000,
    });
    const reflector = new Reflector();
    const interceptor = new IdempotencyInterceptor(
      reflector,
      store,
      new FakeMarker() as unknown as InProgressMarker,
      undefined, // auditEnqueuer
      logger, // ROOT_LOGGER
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [TestController],
      providers: [
        { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
        { provide: INFLIGHT_REDIS, useValue: failingRedis },
        { provide: InProgressMarker, useValue: new FakeMarker() },
        { provide: ROOT_LOGGER, useValue: logger },
        { provide: APP_INTERCEPTOR, useValue: interceptor },
      ],
    }).compile();

    controller = moduleRef.get(TestController);
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => { if (app) await app.close(); });

  beforeEach(() => {
    controller.callCount = 0;
    failingRedis.setCalls = 0;
    pgInsertCalls = 0;
    warnSpy.mockClear();
    errorSpy.mockClear();
  });

  it("(b) returns the handler response even though save failed (no hard-fail)", async () => {
    const res = await request(app.getHttpServer())
      .post("/test-save-fail")
      .set("Idempotency-Key", KEY)
      .send({});
    expect(res.status).toBe(HttpStatus.CREATED);
    expect(res.body).toEqual({ ok: true });
    expect(controller.callCount).toBe(1);
  });

  it("(a) logs a warning with the error when save fails", async () => {
    await request(app.getHttpServer())
      .post("/test-save-fail")
      .set("Idempotency-Key", KEY)
      .send({});
    // Drain the fire-and-forget save tap.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    // save was attempted (pg mirror is written first and rejects).
    expect(pgInsertCalls).toBeGreaterThanOrEqual(1);
    expect(warnSpy).toHaveBeenCalled();
    // First arg is the structured payload carrying the error.
    const [payload] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload).toHaveProperty("err");
  });

  it("(c) does not throw / does not 5xx on save failure", async () => {
    const res = await request(app.getHttpServer())
      .post("/test-save-fail")
      .set("Idempotency-Key", KEY)
      .send({});
    expect(res.status).toBeLessThan(500);
  });
});
