/**
 * RT-369 — `@Idempotent(..., { clientScope: "device" })` partitions the replay
 * store by the authenticated device, not the (absent) user.
 *
 * A device principal has no user, so the default client is `"anonymous"`,
 * shared by every device of the tenant. The opt-in device scope keys by
 * `request.posDeviceId`; a route without it is unchanged (still the shared
 * partition), and a device-scoped route whose guard published no device fails
 * closed with 401.
 *
 * Docker-free: FakeRedis + FakeMarker, as the #530 partition spec.
 */
import "reflect-metadata";
import { Controller, Post, type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { IdempotencyKeyStore } from "@data-pulse-2/shared";

import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { IDEMPOTENCY_KEY_STORE, IdempotencyInterceptor } from "../../src/idempotency/idempotency.interceptor";
import { Idempotent } from "../../src/idempotency/idempotent.decorator";
import { INFLIGHT_REDIS, InProgressMarker } from "../../src/idempotency/in-progress-marker";

const TENANT = "0a000000-0000-7000-8000-000000036901";
const DEVICE_A = "0a000000-0000-7000-8000-0000000369a1";
const DEVICE_B = "0a000000-0000-7000-8000-0000000369b1";
const KEY = "rt369-scope-key-0000000001";

class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    return Promise.resolve(!e || Date.now() > e.expiresAt ? null : e.value);
  }
  set(key: string, value: string, options: { px: number }): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + options.px });
    return Promise.resolve("OK");
  }
  clear(): void {
    this.store.clear();
  }
}

class FakeMarker {
  trySet(): Promise<boolean> {
    return Promise.resolve(true);
  }
  async del(): Promise<void> {
    /* no-op */
  }
}

let calls = 0;

@Controller("/test/rt369")
class DeviceScopedController {
  @Post("device")
  @Idempotent("required", { replay: "forbid", clientScope: "device" })
  device(): { n: number } {
    calls += 1;
    return { n: calls };
  }

  @Post("default")
  @Idempotent("required", { replay: "forbid" })
  byUser(): { n: number } {
    calls += 1;
    return { n: calls };
  }
}

/** A device guard: no user, the device from a test header (absent = none published). */
class DevicePrincipalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      context?: unknown;
      posDeviceId?: string;
    }>();
    req.context = { userId: null, tenantId: TENANT, storeId: null, isPlatformAdmin: false, source: "token" };
    const device = req.headers["x-test-device"];
    if (device) req.posDeviceId = device;
    return true;
  }
}

describe("RT-369 — idempotency client scope `device`", () => {
  let app: INestApplication;
  let redis: FakeRedis;

  beforeAll(async () => {
    redis = new FakeRedis();
    const store = new IdempotencyKeyStore({
      redis,
      pgWriter: { async insert(): Promise<void> {} },
      pgReader: { find: () => Promise.resolve(null) },
      defaultTtlMs: 72 * 60 * 60 * 1000,
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [DeviceScopedController],
      providers: [
        Reflector,
        { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
        { provide: INFLIGHT_REDIS, useValue: new FakeRedis() },
        { provide: InProgressMarker, useFactory: () => new FakeMarker() },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalGuards(new DevicePrincipalGuard());
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    calls = 0;
    redis.clear();
  });

  const post = (path: string, device: string | null): request.Test => {
    const req = request(app.getHttpServer()).post(path).set("Idempotency-Key", KEY);
    return device === null ? req : req.set("X-Test-Device", device);
  };

  it("the same key from two devices runs twice; the same device again is 409", async () => {
    await post("/test/rt369/device", DEVICE_A).expect(201);
    await post("/test/rt369/device", DEVICE_B).expect(201);
    expect(calls).toBe(2);
    const again = await post("/test/rt369/device", DEVICE_A).expect(409);
    expect((again.body as { error: { code: string } }).error.code).toBe("idempotency_key_conflict");
    expect(calls).toBe(2);
  });

  it("a route without the option keeps the shared tenant partition (unchanged keys)", async () => {
    await post("/test/rt369/default", DEVICE_A).expect(201);
    await post("/test/rt369/default", DEVICE_B).expect(409);
    expect(calls).toBe(1);
  });

  it("fails closed with 401 when no device was published", async () => {
    const res = await post("/test/rt369/device", null).expect(401);
    expect((res.body as { error: { code: string } }).error.code).toBe("unauthorized");
    expect(calls).toBe(0);
  });
});
