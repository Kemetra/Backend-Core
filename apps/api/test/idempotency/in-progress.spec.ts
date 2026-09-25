/**
 * T512 — In-progress test.
 *
 * When InProgressMarker.trySet returns false (marker already present),
 * the interceptor returns 425 Too Early with Retry-After header.
 * The 425 response body MUST NOT leak original-request data.
 *
 * The Redis double used to match AlwaysAllowRedis (get null, set "OK") and
 * was never read: the marker stub forced the 425 path. A non-retaining
 * client now fails beforeAll. Redis SET NX is proved only with REDIS_URL
 * (real-redis.guard.spec.ts); without it that file skips and says so.
 */
import "reflect-metadata";
import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import { RolesGuard } from "../../src/auth/roles.guard";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";

import { InvitationsController } from "../../src/memberships/invitations.controller";
import { InvitationsService } from "../../src/memberships/invitations.service";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../src/idempotency/idempotency.interceptor";
import { InProgressMarker, INFLIGHT_REDIS } from "../../src/idempotency/in-progress-marker";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import type { ResolvedContext } from "../../src/context/types";
import { assertIdempotencyRedisRetains } from "./require-retaining-redis";

const TENANT_ID = "0d000000-0000-7000-8000-000000000001";
const USER_ID = "0d000000-0000-7000-8000-000000000004";
const IDEMPOTENCY_KEY = "abcdef1234567890abcdef1234567890";

const VALID_BODY = { email: "user@example.com", role_code: "tenant_admin", store_access_kind: "all" };

class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }
  async set(key: string, value: string, options: { px: number }): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + options.px });
    return "OK";
  }
}

/** Marker that always says "already in flight" (trySet → false). */
class AlwaysInFlightMarker {
  async trySet(): Promise<boolean> { return false; }
  async del(): Promise<void> { /* no-op */ }
}

class FakeInvitationsService {
  public callCount = 0;
  async invite(): Promise<never> {
    this.callCount++;
    throw new Error("service should not be called when 425");
  }
}

class PassAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest<{ principal?: object }>().principal = { userId: USER_ID };
    return true;
  }
}
class PassTenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest<{ context?: ResolvedContext }>().context = {
      userId: USER_ID, tenantId: TENANT_ID, storeId: null,
      isPlatformAdmin: false, source: "session",
    };
    return true;
  }
}
class PassRolesGuard implements CanActivate { canActivate(): boolean { return true; } }

let app: INestApplication;
let svc: FakeInvitationsService;

beforeAll(async () => {
  svc = new FakeInvitationsService();
  const fakeRedis = new FakeRedis();
  await assertIdempotencyRedisRetains(fakeRedis, "in-progress.spec.ts");
  const marker = new AlwaysInFlightMarker();

  const store = new IdempotencyKeyStore({
    redis: fakeRedis as unknown as import("@data-pulse-2/shared").RedisLike,
    pgWriter: { async insert() {} },
    pgReader: { async find() { return null; } },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });

  const reflector = new Reflector();
  const interceptor = new IdempotencyInterceptor(reflector, store, marker as unknown as InProgressMarker);

  const moduleRef = await Test.createTestingModule({
    controllers: [InvitationsController],
    providers: [
      { provide: InvitationsService, useValue: svc },
      { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: marker },
      { provide: APP_INTERCEPTOR, useValue: interceptor },
    ],
  })
    .overrideGuard(DashboardAuthGuard).useValue(new PassAuthGuard())
    .overrideGuard(TenantContextGuard).useValue(new PassTenantGuard())
    .overrideGuard(RolesGuard).useValue(new PassRolesGuard())
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => { if (app) await app.close(); });
beforeEach(() => { svc.callCount = 0; });

function http() { return request(app.getHttpServer()); }

describe("T512 — in-progress: duplicate during flight → 425 Too Early", () => {
  it("returns 425 when marker is already set", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(VALID_BODY);

    expect(res.status).toBe(425);
  });

  it("425 response includes Retry-After header", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(VALID_BODY);

    expect(res.status).toBe(425);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("425 body contains idempotency_in_progress error code", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(VALID_BODY);

    expect(res.body).toMatchObject({
      error: "idempotency_in_progress",
      retryAfterSec: expect.any(Number),
    });
  });

  it("425 body does NOT contain original email or request body fields", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(VALID_BODY);

    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain("user@example.com");
    expect(bodyStr).not.toContain("tenant_admin");
  });

  it("425 body does NOT contain actor_id or request_id from original", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(VALID_BODY);

    expect(res.body).not.toHaveProperty("actor_id");
    expect(res.body).not.toHaveProperty("request_id");
    expect(res.body).not.toHaveProperty("user_id");
  });

  it("service handler is NOT called (short-circuit before handler)", async () => {
    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(VALID_BODY);

    expect(svc.callCount).toBe(0);
  });
});
