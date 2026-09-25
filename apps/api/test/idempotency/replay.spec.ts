/**
 * T510 — Replay test.
 *
 * Same (tenant, route, clientId, key) + same body → identical response
 * status + body; handler invoked exactly once.
 *
 * Docker-free unit test. Uses Nest testing module with fake IdempotencyKeyStore
 * and InProgressMarker injected. No DB, no Redis, no network.
 */
import "reflect-metadata";
import {
  Controller,
  HttpStatus,
  Post,
  Res,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Response } from "express";
import request from "supertest";

import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import { RolesGuard } from "../../src/auth/roles.guard";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";

import { InvitationsController } from "../../src/memberships/invitations.controller";
import { InvitationsService } from "../../src/memberships/invitations.service";
import { Idempotent } from "../../src/idempotency/idempotent.decorator";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../src/idempotency/idempotency.interceptor";
import { InProgressMarker, INFLIGHT_REDIS } from "../../src/idempotency/in-progress-marker";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import type { InvitationRow } from "@data-pulse-2/db/schema";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import type { ResolvedContext } from "../../src/context/types";
import { assertIdempotencyRedisRetains } from "./require-retaining-redis";

// ---------------------------------------------------------------------------
// Fixed constants
// ---------------------------------------------------------------------------
const TENANT_ID = "0d000000-0000-7000-8000-000000000001";
const INVITATION_ID = "0d000000-0000-7000-8000-000000000002";
const ROLE_ID = "0d000000-0000-7000-8000-000000000003";
const USER_ID = "0d000000-0000-7000-8000-000000000004";
const IDEMPOTENCY_KEY = "abcdef1234567890abcdef1234567890"; // 32 chars, valid
const EXPIRES_AT = new Date("2026-05-17T00:00:00.000Z");

const VALID_BODY = { email: "user@example.com", role_code: "tenant_admin", store_access_kind: "all" };

// ---------------------------------------------------------------------------
// In-memory fake Redis for IdempotencyKeyStore
// ---------------------------------------------------------------------------
class FakeRedis {
  private store: Map<string, { value: string; expiresAt: number }> = new Map();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this.store.delete(key); return null; }
    return entry.value;
  }
  async set(key: string, value: string, options: { px: number }): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + options.px });
    return "OK";
  }
  clear(): void { this.store.clear(); }
}

// ---------------------------------------------------------------------------
// Fake InProgressMarker — always returns true (owns marker)
// ---------------------------------------------------------------------------
class FakeMarker {
  public trySetResult = true;
  async trySet(_tuple: string, _ttl?: number): Promise<boolean> { return this.trySetResult; }
  async del(_tuple: string): Promise<void> { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Fake InvitationsService
// ---------------------------------------------------------------------------
const FAKE_ROW: InvitationRow = {
  id: INVITATION_ID,
  tenantId: TENANT_ID,
  email: "user@example.com",
  roleId: ROLE_ID,
  storeAccessKind: "all",
  invitedStoreIds: [],
  invitedByUserId: USER_ID,
  tokenHash: Buffer.alloc(0),
  status: "pending",
  expiresAt: EXPIRES_AT,
  acceptedByUserId: null,
  acceptedAt: null,
  createdAt: EXPIRES_AT,
  updatedAt: EXPIRES_AT,
  deletedAt: null,
};

class FakeInvitationsService {
  public callCount = 0;
  async invite(_ctx: ResolvedContext, _dto: unknown): Promise<{ row: InvitationRow; roleCode: string }> {
    this.callCount++;
    return { row: FAKE_ROW, roleCode: "tenant_admin" };
  }
}

// ---------------------------------------------------------------------------
// Guard stubs
// ---------------------------------------------------------------------------
class PassAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ principal?: object }>();
    req.principal = { kind: "session", sessionId: "sess-1", userId: USER_ID };
    return true;
  }
}
class PassTenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext }>();
    req.context = {
      userId: USER_ID, tenantId: TENANT_ID, storeId: null,
      isPlatformAdmin: false, source: "session",
    };
    return true;
  }
}
class PassRolesGuard implements CanActivate {
  canActivate(): boolean { return true; }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
let app: INestApplication;
let svc: FakeInvitationsService;
let fakeRedis: FakeRedis;
let fakeMarker: FakeMarker;

beforeAll(async () => {
  svc = new FakeInvitationsService();
  fakeRedis = new FakeRedis();
  await assertIdempotencyRedisRetains(fakeRedis, "replay.spec.ts");
  fakeMarker = new FakeMarker();

  const store = new IdempotencyKeyStore({
    redis: fakeRedis,
    pgWriter: { async insert() {} },
    pgReader: { async find() { return null; } },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });

  const reflector = new Reflector();
  const interceptor = new IdempotencyInterceptor(reflector, store, fakeMarker as unknown as InProgressMarker);

  const moduleRef = await Test.createTestingModule({
    controllers: [InvitationsController],
    providers: [
      { provide: InvitationsService, useValue: svc },
      { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
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

beforeEach(() => {
  svc.callCount = 0;
  fakeRedis.clear();
  fakeMarker.trySetResult = true;
});

function http() {
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T510 — Replay tests
// ---------------------------------------------------------------------------
describe("T510 — replay: same key + same body → handler runs once, replay returns cached response", () => {
  it("first request returns 201 and service is called once", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(VALID_BODY);
    expect(res.status).toBe(HttpStatus.CREATED);
    expect(svc.callCount).toBe(1);
  });

  it("second request with same key + same body returns 201 with Idempotent-Replayed: true; service NOT called again", async () => {
    // First call populates the store
    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(VALID_BODY);
    const firstCallCount = svc.callCount;

    // Second call (replay)
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(VALID_BODY);

    expect(res.status).toBe(HttpStatus.CREATED);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    // Service was NOT invoked again
    expect(svc.callCount).toBe(firstCallCount);
  });

  it("replay response body matches original response body", async () => {
    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(VALID_BODY);

    const replay = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(VALID_BODY);

    expect(replay.body.id).toBe(INVITATION_ID);
    expect(replay.body.tenant_id).toBe(TENANT_ID);
    expect(replay.body.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// T539a — non-201 successful status preservation through replay.
//
// Regression test for `005-IDEMP-STATUS-CAPTURE-DEFECT`: prior to the fix in
// 005-WAVE1-IDEMP-STATUS-CAPTURE, `IdempotencyInterceptor` hard-coded the
// stored response status to `HttpStatus.CREATED`, so any handler that
// returned a non-201 successful status (e.g., 200 via `@Res({ passthrough })`
// + `res.status(HttpStatus.OK)`) replayed as 201. The fix reads the actual
// `res.statusCode` at capture time, so this test asserts that a 200-returning
// handler replays as 200 (not 201).
// ---------------------------------------------------------------------------

@Controller("test-200")
class Test200Controller {
  public callCount = 0;

  @Post()
  @Idempotent("required")
  async create(
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true; n: number }> {
    this.callCount += 1;
    res.status(HttpStatus.OK);
    return { ok: true, n: this.callCount };
  }
}

describe("T539a — replay preserves non-201 successful status (regression for IDEMP-STATUS-CAPTURE-DEFECT)", () => {
  let app200: INestApplication;
  let controller: Test200Controller;
  let fakeRedis200: FakeRedis;
  const KEY_200 = "abcdef1234567890abcdef1234567200"; // 32 chars

  beforeAll(async () => {
    fakeRedis200 = new FakeRedis();
    const fakeMarker200 = new FakeMarker();
    const store200 = new IdempotencyKeyStore({
      redis: fakeRedis200,
      pgWriter: { async insert() {} },
      pgReader: { async find() { return null; } },
      defaultTtlMs: 72 * 60 * 60 * 1000,
    });
    const reflector = new Reflector();
    const interceptor = new IdempotencyInterceptor(
      reflector,
      store200,
      fakeMarker200 as unknown as InProgressMarker,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [Test200Controller],
      providers: [
        { provide: IDEMPOTENCY_KEY_STORE, useValue: store200 },
        { provide: INFLIGHT_REDIS, useValue: fakeRedis200 },
        { provide: InProgressMarker, useValue: fakeMarker200 },
        { provide: APP_INTERCEPTOR, useValue: interceptor },
      ],
    }).compile();

    controller = moduleRef.get(Test200Controller);
    app200 = moduleRef.createNestApplication({ bufferLogs: true });
    app200.useGlobalFilters(new GlobalExceptionFilter());
    await app200.init();
  });

  afterAll(async () => {
    if (app200) await app200.close();
  });

  beforeEach(() => {
    fakeRedis200.clear();
    controller.callCount = 0;
  });

  it("preserves non-201 successful status code (200) through replay (T539a, fixes IDEMP-STATUS-CAPTURE-DEFECT)", async () => {
    const first = await request(app200.getHttpServer())
      .post("/test-200")
      .set("Idempotency-Key", KEY_200)
      .send({});
    expect(first.status).toBe(HttpStatus.OK);
    expect(first.body).toEqual({ ok: true, n: 1 });
    expect(controller.callCount).toBe(1);

    // Drain the interceptor's fire-and-forget `store.save` tap so the second
    // call sees the stored entry (same pattern used in capture-resolves-to-alias).
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const second = await request(app200.getHttpServer())
      .post("/test-200")
      .set("Idempotency-Key", KEY_200)
      .send({});
    // Pre-fix this would be 201 — the defect's exact signature.
    expect(second.status).toBe(HttpStatus.OK);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    // Handler invoked exactly once across both calls.
    expect(controller.callCount).toBe(1);
  });
});
