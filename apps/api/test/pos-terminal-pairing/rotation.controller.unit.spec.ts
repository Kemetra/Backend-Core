/**
 * RT-369 — the rotate route's wiring, Docker-free: the per-device rotation
 * budget (429 `RATE_LIMITED` + `Retry-After`, before the idempotency checks
 * and before any rotation), the no-store headers on the 200, and the
 * idempotency options (non-replayable, device-scoped, no token in the
 * replay marker). The device guard is stubbed; the rate-limit guard is real
 * over a fake limiter.
 */
import "reflect-metadata";

import { type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { OPERATOR_CONTEXT_RESOLVER } from "../../src/auth/operator-context-resolver";
import { POS_WRITE_RATE_LIMIT_BUCKET_KEY } from "../../src/auth/pos-write-rate-limit.decorator";
import { PosWriteRateLimitGuard } from "../../src/auth/pos-write-rate-limit.guard";
import { POS_WRITE_RATE_LIMIT_BUCKETS, RateLimiter } from "../../src/auth/rate-limit";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { ROOT_LOGGER } from "../../src/common/logging.interceptor";
import { IDEMPOTENT_OPTIONS_KEY } from "../../src/idempotency/idempotent.decorator";
import { DeviceRotationAuthGuard } from "../../src/pos-terminal-pairing/device-rotation-auth.guard";
import { RotationController } from "../../src/pos-terminal-pairing/rotation.controller";
import { RotationService } from "../../src/pos-terminal-pairing/rotation.service";

const TENANT = "0a000000-0000-7000-8000-000000036911";
const STORE = "0a000000-0000-7000-8000-000000036912";
const DEVICE = "0a000000-0000-7000-8000-000000036913";

/** Publishes what DeviceRotationAuthGuard publishes on success. */
class StubDeviceGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Record<string, unknown>>();
    req["principal"] = { kind: "token", tokenId: DEVICE, tenantId: TENANT, userId: null, storeId: STORE, scope: "pos" };
    req["context"] = { userId: null, tenantId: TENANT, storeId: STORE, isPlatformAdmin: false, source: "token" };
    req["posDeviceId"] = DEVICE;
    req["rotationPresentedHash"] = Buffer.alloc(32, 1);
    return true;
  }
}

describe("RT-369 — rotate route wiring", () => {
  let app: INestApplication;
  const rotate = jest.fn();
  let allowed = true;
  const check = jest.fn(() => Promise.resolve({ allowed, remaining: 0, resetMs: 42_000 }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RotationController],
      providers: [
        Reflector,
        PosWriteRateLimitGuard,
        { provide: RotationService, useValue: { rotate } },
        { provide: RateLimiter, useValue: { check } },
        { provide: OPERATOR_CONTEXT_RESOLVER, useValue: { recoverDeviceId: jest.fn() } },
      ],
    })
      .overrideGuard(DeviceRotationAuthGuard)
      .useValue(new StubDeviceGuard())
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    rotate.mockReset();
    check.mockClear();
    allowed = true;
  });

  it("over the device's rotation budget is 429 RATE_LIMITED with Retry-After, and nothing rotates", async () => {
    allowed = false;
    const res = await request(app.getHttpServer()).post("/api/pos/v1/terminals/rotate").expect(429);
    expect((res.body as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    expect(res.headers["retry-after"]).toBe("42");
    expect(rotate).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledWith("posRotateDevice", DEVICE, POS_WRITE_RATE_LIMIT_BUCKETS.posRotateDevice);
  });

  it("a 200 is never cached: Cache-Control no-store, Pragma no-cache", async () => {
    rotate.mockResolvedValue({
      kind: "rotated",
      body: { device_token: "t".repeat(43), terminal_id: DEVICE, expires_at: "x", rotate_after: "y" },
    });
    const res = await request(app.getHttpServer()).post("/api/pos/v1/terminals/rotate").expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["pragma"]).toBe("no-cache");
    expect(rotate).toHaveBeenCalledWith({ tenantId: TENANT, storeId: STORE, deviceId: DEVICE }, Buffer.alloc(32, 1));
  });

  it("is non-replayable, device-scoped, with no token in the replay marker", () => {
    const handler = RotationController.prototype.rotate as object;
    expect(Reflect.getMetadata(IDEMPOTENT_OPTIONS_KEY, handler)).toEqual({
      replay: "forbid",
      replayMarkerFields: ["terminal_id"],
      clientScope: "device",
    });
    expect(Reflect.getMetadata(POS_WRITE_RATE_LIMIT_BUCKET_KEY, handler)).toBe("posRotateDevice");
  });

  it("the rotation budget is small: a till rotates about once per 75 days", () => {
    expect(POS_WRITE_RATE_LIMIT_BUCKETS.posRotateDevice).toEqual({ limit: 10, windowMs: 60 * 60 * 1000 });
  });
});

/** An in-memory Redis for the real RateLimiter. */
class CountingRedis {
  private readonly counts = new Map<string, number>();
  incrWindow(key: string): Promise<{ count: number; ttlMs: number }> {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return Promise.resolve({ count: n, ttlMs: 30_000 });
  }
  pttl(): Promise<number> {
    return Promise.resolve(30_000);
  }
  decr(key: string): Promise<number> {
    const n = (this.counts.get(key) ?? 0) - 1;
    this.counts.set(key, n);
    return Promise.resolve(n);
  }
  del(key: string): Promise<number> {
    return Promise.resolve(this.counts.delete(key) ? 1 : 0);
  }
}

describe("RT-369 — the real per-device budget on the device principal", () => {
  async function boot(rateLimiter: unknown, warn: jest.Mock): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [RotationController],
      providers: [
        Reflector,
        PosWriteRateLimitGuard,
        {
          provide: RotationService,
          useValue: {
            rotate: () =>
              Promise.resolve({
                kind: "rotated",
                body: { device_token: "t".repeat(43), terminal_id: DEVICE, expires_at: "x", rotate_after: "y" },
              }),
          },
        },
        { provide: RateLimiter, useValue: rateLimiter },
        { provide: OPERATOR_CONTEXT_RESOLVER, useValue: { recoverDeviceId: jest.fn() } },
        { provide: ROOT_LOGGER, useValue: { warn } },
      ],
    })
      .overrideGuard(DeviceRotationAuthGuard)
      .useValue(new StubDeviceGuard())
      .compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
    return app;
  }

  it("ten rotations in an hour pass; the 11th is 429 RATE_LIMITED", async () => {
    const app = await boot(new RateLimiter(new CountingRedis()), jest.fn());
    try {
      for (let i = 0; i < 10; i += 1) {
        await request(app.getHttpServer()).post("/api/pos/v1/terminals/rotate").expect(200);
      }
      const res = await request(app.getHttpServer()).post("/api/pos/v1/terminals/rotate").expect(429);
      expect((res.body as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
      expect(res.headers["retry-after"]).toBe("30");
    } finally {
      await app.close();
    }
  });

  it("a limiter outage fails open with a warn log", async () => {
    const warn = jest.fn();
    const app = await boot({ check: () => Promise.reject(new Error("redis down")) }, warn);
    try {
      await request(app.getHttpServer()).post("/api/pos/v1/terminals/rotate").expect(200);
      expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("failing open"));
    } finally {
      await app.close();
    }
  });
});
