/**
 * T517 — Observability signals test.
 *
 * Verifies that the three idempotency counters increment in the correct paths:
 *   - idempotency_replay_total: incremented on replay path.
 *   - idempotency_conflict_total: incremented on 409 conflict path.
 *   - idempotency_in_progress_total: incremented on 425 path.
 *
 * Uses jest.spyOn to intercept the recorder functions in api.metrics.ts
 * without requiring a live OTel SDK.
 *
 * strategy.md §14 / FR-D-010.
 */
import "reflect-metadata";
import {
  type CanActivate,
  type ExecutionContext,
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
import * as apiMetrics from "../../src/observability/metrics/api.metrics";

const TENANT_ID = "0d000000-0000-7000-8000-000000000001";
const USER_ID = "0d000000-0000-7000-8000-000000000004";
const KEY_REPLAY    = "replay0000000000000000000000000001";
const KEY_CONFLICT  = "conflict000000000000000000000000001";
const KEY_PROGRESS  = "progress0000000000000000000000001";
const EXPIRES_AT = new Date("2026-05-17T00:00:00.000Z");

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

class ConfigurableMarker {
  public nextResult = true;
  async trySet(): Promise<boolean> { return this.nextResult; }
  async del(): Promise<void> {}
}

class FakeInvitationsService {
  async invite(): Promise<{ row: InvitationRow; roleCode: string }> {
    return {
      row: {
        id: "inv-1", tenantId: TENANT_ID, email: "user@example.com",
        roleId: "role-1", storeAccessKind: "all", invitedStoreIds: [],
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
class PassRolesGuard implements CanActivate { canActivate(): boolean { return true; } }

let app: INestApplication;
let fakeRedis: FakeRedis;
let configurableMarker: ConfigurableMarker;

beforeAll(async () => {
  fakeRedis = new FakeRedis();
  configurableMarker = new ConfigurableMarker();
  const svc = new FakeInvitationsService();

  const store = new IdempotencyKeyStore({
    redis: fakeRedis,
    pgWriter: { async insert() {} },
    pgReader: { async find() { return null; } },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });

  const reflector = new Reflector();
  const interceptor = new IdempotencyInterceptor(reflector, store, configurableMarker as unknown as InProgressMarker);

  const moduleRef = await Test.createTestingModule({
    controllers: [InvitationsController],
    providers: [
      { provide: InvitationsService, useValue: svc },
      { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: configurableMarker },
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
beforeEach(() => { fakeRedis.clear(); configurableMarker.nextResult = true; });

function http() { return request(app.getHttpServer()); }
const BODY = { email: "user@example.com", role_code: "tenant_admin", store_access_kind: "all" };

describe("T517 — observability signals: counters increment in the right paths", () => {
  it("idempotency_replay_total increments on replay path", async () => {
    const spy = jest.spyOn(apiMetrics, "recordIdempotencyReplay");
    spy.mockImplementation(() => {});

    // First request (no replay)
    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", KEY_REPLAY)
      .send(BODY);

    const before = spy.mock.calls.length;

    // Second request (replay)
    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", KEY_REPLAY)
      .send(BODY);

    expect(spy.mock.calls).toHaveLength(before + 1);
    expect(spy.mock.calls[spy.mock.calls.length - 1]![0]).toMatchObject({ route: expect.stringContaining("invite") });
    spy.mockRestore();
  });

  it("idempotency_conflict_total increments on 409 conflict path", async () => {
    const spy = jest.spyOn(apiMetrics, "recordIdempotencyConflict");
    spy.mockImplementation(() => {});

    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", KEY_CONFLICT)
      .send({ email: "alice@example.com", role_code: "tenant_admin", store_access_kind: "all" });

    const before = spy.mock.calls.length;

    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", KEY_CONFLICT)
      .send({ email: "bob@example.com", role_code: "tenant_admin", store_access_kind: "all" });

    expect(spy.mock.calls).toHaveLength(before + 1);
    spy.mockRestore();
  });

  it("idempotency_in_progress_total increments on 425 path", async () => {
    const spy = jest.spyOn(apiMetrics, "recordIdempotencyInProgress");
    spy.mockImplementation(() => {});

    configurableMarker.nextResult = false; // simulate in-flight

    const before = spy.mock.calls.length;
    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", KEY_PROGRESS)
      .send(BODY);

    expect(spy.mock.calls).toHaveLength(before + 1);
    spy.mockRestore();
  });

  it("replay counter carries route label", async () => {
    const calls: { route: string }[] = [];
    const spy = jest.spyOn(apiMetrics, "recordIdempotencyReplay")
      .mockImplementation((attrs) => { calls.push(attrs); });

    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", "replayroutecheck000000000000000001")
      .send(BODY);
    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", "replayroutecheck000000000000000001")
      .send(BODY);

    expect(calls.some((c) => c.route.includes("invite"))).toBe(true);
    spy.mockRestore();
  });

  it("three signals are registered in API_METRIC_NAMES", () => {
    expect(apiMetrics.API_METRIC_NAMES).toContain("idempotency_replay_total");
    expect(apiMetrics.API_METRIC_NAMES).toContain("idempotency_conflict_total");
    expect(apiMetrics.API_METRIC_NAMES).toContain("idempotency_in_progress_total");
  });
});
