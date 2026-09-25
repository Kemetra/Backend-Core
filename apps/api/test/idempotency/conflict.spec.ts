/**
 * T511 — Conflict test.
 *
 * Same key, different body → 409 Conflict.
 * Original mutation preserved (service not re-invoked).
 * 409 response body MUST NOT leak original request fields.
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
import type { InvitationRow } from "@data-pulse-2/db/schema";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import type { ResolvedContext } from "../../src/context/types";
import { assertIdempotencyRedisRetains } from "./require-retaining-redis";

const TENANT_ID = "0d000000-0000-7000-8000-000000000001";
const INVITATION_ID = "0d000000-0000-7000-8000-000000000002";
const ROLE_ID = "0d000000-0000-7000-8000-000000000003";
const USER_ID = "0d000000-0000-7000-8000-000000000004";
const IDEMPOTENCY_KEY = "abcdef1234567890abcdef1234567890";
const EXPIRES_AT = new Date("2026-05-17T00:00:00.000Z");

const BODY_A = { email: "alice@example.com", role_code: "tenant_admin", store_access_kind: "all" };
const BODY_B = { email: "bob@example.com",   role_code: "tenant_admin", store_access_kind: "all" };

class FakeRedis {
  private store: Map<string, { value: string; expiresAt: number }> = new Map();
  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e || Date.now() > e.expiresAt) { this.store.delete(key); return null; }
    return e.value;
  }
  async set(key: string, value: string, opts: { px: number }): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + opts.px });
    return "OK";
  }
  clear(): void { this.store.clear(); }
}

class FakeMarker {
  async trySet(): Promise<boolean> { return true; }
  async del(): Promise<void> { /* no-op */ }
}

class FakeInvitationsService {
  public callCount = 0;
  async invite(): Promise<{ row: InvitationRow; roleCode: string }> {
    this.callCount++;
    return {
      row: {
        id: INVITATION_ID, tenantId: TENANT_ID, email: "alice@example.com",
        roleId: ROLE_ID, storeAccessKind: "all", invitedStoreIds: [],
        invitedByUserId: USER_ID, tokenHash: Buffer.alloc(0),
        status: "pending", expiresAt: EXPIRES_AT,
        acceptedByUserId: null, acceptedAt: null,
        createdAt: EXPIRES_AT, updatedAt: EXPIRES_AT, deletedAt: null,
      },
      roleCode: "tenant_admin",
    };
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
class PassRolesGuard implements CanActivate {
  canActivate(): boolean { return true; }
}

let app: INestApplication;
let svc: FakeInvitationsService;
let fakeRedis: FakeRedis;

beforeAll(async () => {
  svc = new FakeInvitationsService();
  fakeRedis = new FakeRedis();
  await assertIdempotencyRedisRetains(fakeRedis, "conflict.spec.ts");
  const fakeMarker = new FakeMarker();

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
beforeEach(() => { svc.callCount = 0; fakeRedis.clear(); });

function http() { return request(app.getHttpServer()); }

describe("T511 — conflict: same key, different body → 409", () => {
  it("first request succeeds", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(BODY_A);
    expect(res.status).toBe(HttpStatus.CREATED);
  });

  it("second request with same key but different body → 409 Conflict", async () => {
    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(BODY_A);

    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(BODY_B);

    expect(res.status).toBe(HttpStatus.CONFLICT);
    expect(res.body).toHaveProperty("error");
  });

  it("409 body contains idempotency_key_conflict error code", async () => {
    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(BODY_A);

    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(BODY_B);

    // The exception filter wraps the error in a uniform envelope.
    // Post-PR #360: GlobalExceptionFilter honors the user-supplied
    // fine-grained code from `IdempotencyInterceptor` (Constitution §IV),
    // so the wire envelope reads `error.code: "idempotency_key_conflict"`.
    expect(res.body.error).toMatchObject({
      code: "idempotency_key_conflict",
      message: expect.any(String),
    });
  });

  it("409 body does NOT contain original email or request fields", async () => {
    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(BODY_A);

    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(BODY_B);

    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain("alice@example.com");
    expect(bodyStr).not.toContain("bob@example.com");
  });

  it("service is only called once (original mutation preserved)", async () => {
    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(BODY_A);
    const callsAfterFirst = svc.callCount;

    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(BODY_B);

    expect(svc.callCount).toBe(callsAfterFirst); // no second invocation
  });
});
