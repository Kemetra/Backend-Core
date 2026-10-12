/**
 * stores.controller.unit.spec.ts
 *
 * Docker-free unit coverage for StoresController.
 *
 * Strategy: minimal Nest app mounting only StoresController.
 * Guards replaced with scripted CanActivate doubles; StoresService
 * replaced with a hand-written fake. No Testcontainers, no DB, no network.
 *
 * Guard chain: DashboardAuthGuard (class) → TenantContextGuard (class) →
 *   RolesGuard (per-method on POST/PATCH/DELETE).
 *
 * NOTE: The scripted RolesGuard always throws ForbiddenException for
 * simplicity. The real RolesGuard's `denyAs` logic (403 for POST, 404
 * for PATCH/DELETE per FR-ISO-4) is tested in the integration layer, not
 * here. These unit tests cover the controller's guard-wiring, request-body
 * projection, and service-delegation responsibilities only.
 *
 * Endpoints:
 *   GET    /api/v1/stores                → 200 StoreBody[]
 *   POST   /api/v1/stores                → 201 StoreBody
 *   GET    /api/v1/stores/:store_id      → 200 StoreBody
 *   PATCH  /api/v1/stores/:store_id      → 200 StoreBody
 *   DELETE /api/v1/stores/:store_id      → 204 No Content
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  type INestApplication,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import type { AuthTokenRow, SessionRow } from "@data-pulse-2/db/schema";
import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";
import { RolesGuard } from "../../src/auth/roles.guard";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../src/context/types";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { SessionRepository } from "../../src/auth/session.repository";
import { AuthTokenRepository } from "../../src/auth/auth-token.repository";

import { StoresController } from "../../src/stores/stores.controller";
import { StoresService } from "../../src/stores/stores.service";
import type { StoreRecord } from "../../src/stores/stores.repository";

// ---------------------------------------------------------------------------
// Fixed UUIDs
// ---------------------------------------------------------------------------

const TENANT_ID = "0e000000-0000-7000-8000-000000000001";
const STORE_ID  = "0e000000-0000-7000-8000-000000000002";
const NOT_A_UUID = "not-a-uuid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeRecord(overrides: Partial<StoreRecord> = {}): StoreRecord {
  return {
    id: STORE_ID,
    tenantId: TENANT_ID,
    code: "MAIN",
    name: "Main Store",
    timezone: "UTC",
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class FakeStoresService {
  public lastListArgs: { ctx: ResolvedContext } | null = null;
  public lastCreateArgs: { ctx: ResolvedContext; body: unknown } | null = null;
  public lastReadArgs: { ctx: ResolvedContext; storeId: string } | null = null;
  public lastUpdateArgs: { ctx: ResolvedContext; storeId: string; body: unknown } | null = null;
  public lastSoftDeleteArgs: { ctx: ResolvedContext; storeId: string } | null = null;

  public listResult: StoreRecord[] = [makeRecord()];
  public createResult: StoreRecord = makeRecord();
  public readResult: StoreRecord = makeRecord();
  public updateResult: StoreRecord = makeRecord();

  async list(ctx: ResolvedContext): Promise<StoreRecord[]> {
    this.lastListArgs = { ctx };
    return this.listResult;
  }

  async create(ctx: ResolvedContext, body: unknown): Promise<StoreRecord> {
    this.lastCreateArgs = { ctx, body };
    return this.createResult;
  }

  async read(ctx: ResolvedContext, storeId: string): Promise<StoreRecord> {
    this.lastReadArgs = { ctx, storeId };
    return this.readResult;
  }

  async update(ctx: ResolvedContext, storeId: string, body: unknown): Promise<StoreRecord> {
    this.lastUpdateArgs = { ctx, storeId, body };
    return this.updateResult;
  }

  async softDelete(ctx: ResolvedContext, storeId: string): Promise<void> {
    this.lastSoftDeleteArgs = { ctx, storeId };
  }
}

class ScriptedAuthGuard implements CanActivate {
  public mode: "ok" | "reject" = "ok";
  canActivate(ctx: ExecutionContext): boolean {
    if (this.mode === "reject") throw new UnauthorizedException("Unauthorized");
    const req = ctx.switchToHttp().getRequest<{ principal?: object }>();
    req.principal = { kind: "session", sessionId: "sess-1", userId: "user-1" };
    return true;
  }
}

class ScriptedTenantContextGuard implements CanActivate {
  public mode: "ok" | "no-tenant" | "no-context" = "ok";
  public context: ResolvedContext = {
    userId: "user-1",
    tenantId: TENANT_ID,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
  };

  canActivate(ctx: ExecutionContext): boolean {
    if (this.mode === "no-tenant") throw new UnauthorizedException("Unauthorized");
    if (this.mode === "no-context") return true; // does NOT set request.context
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext }>();
    req.context = this.context;
    return true;
  }
}

class ScriptedRolesGuard implements CanActivate {
  public mode: "ok" | "forbid" = "ok";
  canActivate(_ctx: ExecutionContext): boolean {
    if (this.mode === "forbid") throw new ForbiddenException("Insufficient role.");
    return true;
  }
}

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

function expectErrorEnvelope(body: unknown, expectedCode: string): void {
  expect(body).toMatchObject({
    error: {
      code: expectedCode,
      message: expect.any(String),
      request_id: expect.any(String),
    },
  });
}

// ---------------------------------------------------------------------------
// Fixture — one app for all tests in this file
// ---------------------------------------------------------------------------

let app: INestApplication;
let svc: FakeStoresService;
let auth: ScriptedAuthGuard;
let tenant: ScriptedTenantContextGuard;
let roles: ScriptedRolesGuard;

beforeAll(async () => {
  svc    = new FakeStoresService();
  auth   = new ScriptedAuthGuard();
  tenant = new ScriptedTenantContextGuard();
  roles  = new ScriptedRolesGuard();

  const moduleRef = await Test.createTestingModule({
    controllers: [StoresController],
    providers: [
      { provide: StoresService, useValue: svc },
    ],
  })
    .overrideGuard(DashboardAuthGuard).useValue(auth)
    .overrideGuard(TenantContextGuard).useValue(tenant)
    .overrideGuard(RolesGuard).useValue(roles)
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(() => {
  auth.mode   = "ok";
  tenant.mode = "ok";
  roles.mode  = "ok";
  tenant.context = {
    userId: "user-1",
    tenantId: TENANT_ID,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
  };
  svc.lastListArgs       = null;
  svc.lastCreateArgs     = null;
  svc.lastReadArgs       = null;
  svc.lastUpdateArgs     = null;
  svc.lastSoftDeleteArgs = null;
  svc.listResult   = [makeRecord()];
  svc.createResult = makeRecord();
  svc.readResult   = makeRecord();
  svc.updateResult = makeRecord();
});

function http() {
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// GET /api/v1/stores
// ---------------------------------------------------------------------------

describe("GET /api/v1/stores", () => {
  it("happy path: returns 200 with projected store array", async () => {
    const res = await http().get("/api/v1/stores");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: STORE_ID,
        tenant_id: TENANT_ID,
        code: "MAIN",
        name: "Main Store",
        timezone: "UTC",
        is_active: true,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
        deleted_at: null,
      },
    ]);
  });

  it("forwards resolved context to service.list", async () => {
    await http().get("/api/v1/stores");
    expect(svc.lastListArgs).not.toBeNull();
    expect(svc.lastListArgs!.ctx.tenantId).toBe(TENANT_ID);
  });

  it("returns empty array when service returns []", async () => {
    svc.listResult = [];
    const res = await http().get("/api/v1/stores");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("maps deletedAt to deleted_at ISO string when set", async () => {
    const deletedAt = new Date("2026-02-01T00:00:00.000Z");
    svc.listResult = [makeRecord({ deletedAt })];
    const res = await http().get("/api/v1/stores");
    expect(res.status).toBe(200);
    expect(res.body[0].deleted_at).toBe(deletedAt.toISOString());
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    auth.mode = "reject";
    const res = await http().get("/api/v1/stores");
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastListArgs).toBeNull();
  });

  it("returns 401 when TenantContextGuard rejects — service not called", async () => {
    tenant.mode = "no-tenant";
    const res = await http().get("/api/v1/stores");
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastListArgs).toBeNull();
  });

  it("returns 401 when request.context is absent despite guards passing", async () => {
    tenant.mode = "no-context";
    const res = await http().get("/api/v1/stores");
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/stores
// ---------------------------------------------------------------------------

describe("POST /api/v1/stores", () => {
  const VALID_BODY = { code: "EAST", name: "East Branch" };

  it("happy path: returns 201 with projected store body", async () => {
    svc.createResult = makeRecord({ code: "EAST", name: "East Branch" });
    const res = await http().post("/api/v1/stores").send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: STORE_ID,
      tenant_id: TENANT_ID,
      code: "EAST",
      name: "East Branch",
      is_active: true,
    });
  });

  it("forwards resolved context and body to service.create", async () => {
    await http().post("/api/v1/stores").send(VALID_BODY);
    expect(svc.lastCreateArgs).not.toBeNull();
    expect(svc.lastCreateArgs!.ctx.tenantId).toBe(TENANT_ID);
    expect(svc.lastCreateArgs!.body).toMatchObject(VALID_BODY);
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    auth.mode = "reject";
    const res = await http().post("/api/v1/stores").send(VALID_BODY);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastCreateArgs).toBeNull();
  });

  it("returns 401 when TenantContextGuard rejects — service not called", async () => {
    tenant.mode = "no-tenant";
    const res = await http().post("/api/v1/stores").send(VALID_BODY);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastCreateArgs).toBeNull();
  });

  it("returns 403 when RolesGuard rejects — service not called", async () => {
    roles.mode = "forbid";
    const res = await http().post("/api/v1/stores").send(VALID_BODY);
    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, "forbidden");
    expect(svc.lastCreateArgs).toBeNull();
  });

  it("returns 401 when request.context is absent despite guards passing", async () => {
    tenant.mode = "no-context";
    const res = await http().post("/api/v1/stores").send(VALID_BODY);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 400 for missing `code` field", async () => {
    const res = await http().post("/api/v1/stores").send({ name: "East Branch" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastCreateArgs).toBeNull();
  });

  it("returns 400 for missing `name` field", async () => {
    const res = await http().post("/api/v1/stores").send({ code: "EAST" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastCreateArgs).toBeNull();
  });

  it("returns 400 for extra key (strict schema — e.g. tenant_id in body)", async () => {
    const res = await http()
      .post("/api/v1/stores")
      .send({ ...VALID_BODY, tenant_id: TENANT_ID });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastCreateArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/stores/:store_id
// ---------------------------------------------------------------------------

describe("GET /api/v1/stores/:store_id", () => {
  it("happy path: returns 200 with projected store body", async () => {
    const res = await http().get(`/api/v1/stores/${STORE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: STORE_ID,
      tenant_id: TENANT_ID,
    });
  });

  it("forwards resolved context and store_id to service.read", async () => {
    await http().get(`/api/v1/stores/${STORE_ID}`);
    expect(svc.lastReadArgs).not.toBeNull();
    expect(svc.lastReadArgs!.ctx.tenantId).toBe(TENANT_ID);
    expect(svc.lastReadArgs!.storeId).toBe(STORE_ID);
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    auth.mode = "reject";
    const res = await http().get(`/api/v1/stores/${STORE_ID}`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastReadArgs).toBeNull();
  });

  it("returns 401 when TenantContextGuard rejects — service not called", async () => {
    tenant.mode = "no-tenant";
    const res = await http().get(`/api/v1/stores/${STORE_ID}`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastReadArgs).toBeNull();
  });

  it("returns 401 when request.context is absent despite guards passing", async () => {
    tenant.mode = "no-context";
    const res = await http().get(`/api/v1/stores/${STORE_ID}`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 400 for non-UUID store_id — service not called", async () => {
    const res = await http().get(`/api/v1/stores/${NOT_A_UUID}`);
    expect(res.status).toBe(400);
    expect(svc.lastReadArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/stores/:store_id
// ---------------------------------------------------------------------------

describe("PATCH /api/v1/stores/:store_id", () => {
  it("happy path (name only): returns 200 with updated store body", async () => {
    svc.updateResult = makeRecord({ name: "Renamed Store" });
    const res = await http()
      .patch(`/api/v1/stores/${STORE_ID}`)
      .send({ name: "Renamed Store" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Renamed Store");
  });

  it("happy path (is_active only): returns 200", async () => {
    svc.updateResult = makeRecord({ isActive: false });
    const res = await http()
      .patch(`/api/v1/stores/${STORE_ID}`)
      .send({ is_active: false });
    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(false);
  });

  it("forwards context, store_id, and body to service.update", async () => {
    await http()
      .patch(`/api/v1/stores/${STORE_ID}`)
      .send({ name: "Updated" });
    expect(svc.lastUpdateArgs).not.toBeNull();
    expect(svc.lastUpdateArgs!.ctx.tenantId).toBe(TENANT_ID);
    expect(svc.lastUpdateArgs!.storeId).toBe(STORE_ID);
    expect(svc.lastUpdateArgs!.body).toMatchObject({ name: "Updated" });
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    auth.mode = "reject";
    const res = await http().patch(`/api/v1/stores/${STORE_ID}`).send({ name: "X" });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("returns 401 when TenantContextGuard rejects — service not called", async () => {
    tenant.mode = "no-tenant";
    const res = await http().patch(`/api/v1/stores/${STORE_ID}`).send({ name: "X" });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("returns 403 when RolesGuard rejects — service not called", async () => {
    roles.mode = "forbid";
    const res = await http().patch(`/api/v1/stores/${STORE_ID}`).send({ name: "X" });
    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, "forbidden");
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("returns 401 when request.context is absent despite guards passing", async () => {
    tenant.mode = "no-context";
    const res = await http().patch(`/api/v1/stores/${STORE_ID}`).send({ name: "X" });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 400 for non-UUID store_id — service not called", async () => {
    const res = await http().patch(`/api/v1/stores/${NOT_A_UUID}`).send({ name: "X" });
    expect(res.status).toBe(400);
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("returns 400 for empty body (at-least-one-field rule)", async () => {
    const res = await http().patch(`/api/v1/stores/${STORE_ID}`).send({});
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("returns 400 for tenant_id in body (strict schema — FR-STORE-4)", async () => {
    const res = await http()
      .patch(`/api/v1/stores/${STORE_ID}`)
      .send({ name: "X", tenant_id: TENANT_ID });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastUpdateArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/stores/:store_id
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/stores/:store_id", () => {
  it("happy path: returns 204 with empty body", async () => {
    const res = await http().delete(`/api/v1/stores/${STORE_ID}`);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it("forwards resolved context and store_id to service.softDelete", async () => {
    await http().delete(`/api/v1/stores/${STORE_ID}`);
    expect(svc.lastSoftDeleteArgs).not.toBeNull();
    expect(svc.lastSoftDeleteArgs!.ctx.tenantId).toBe(TENANT_ID);
    expect(svc.lastSoftDeleteArgs!.storeId).toBe(STORE_ID);
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    auth.mode = "reject";
    const res = await http().delete(`/api/v1/stores/${STORE_ID}`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastSoftDeleteArgs).toBeNull();
  });

  it("returns 401 when TenantContextGuard rejects — service not called", async () => {
    tenant.mode = "no-tenant";
    const res = await http().delete(`/api/v1/stores/${STORE_ID}`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastSoftDeleteArgs).toBeNull();
  });

  it("returns 403 when RolesGuard rejects — service not called", async () => {
    roles.mode = "forbid";
    const res = await http().delete(`/api/v1/stores/${STORE_ID}`);
    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, "forbidden");
    expect(svc.lastSoftDeleteArgs).toBeNull();
  });

  it("returns 401 when request.context is absent despite guards passing", async () => {
    tenant.mode = "no-context";
    const res = await http().delete(`/api/v1/stores/${STORE_ID}`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 400 for non-UUID store_id — service not called", async () => {
    const res = await http().delete(`/api/v1/stores/${NOT_A_UUID}`);
    expect(res.status).toBe(400);
    expect(svc.lastSoftDeleteArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scope regression: pos_operator bearer must be rejected by DashboardAuthGuard
// ---------------------------------------------------------------------------
// This block uses the REAL DashboardAuthGuard (not a scripted double) with
// fake repositories so that the scope-filtering logic is actually exercised.
// TenantContextGuard is still scripted — we only need to prove the guard
// rejects before the route handler is reached.
// ---------------------------------------------------------------------------

describe("stores route — DashboardAuthGuard scope regression", () => {
  const REGRESSION_TENANT_ID = "0e000000-0000-7000-8000-000000000099";
  const REGRESSION_TOKEN_ID  = "0e000000-0000-7000-8000-000000000077";
  const REGRESSION_USER_ID   = "0e000000-0000-7000-8000-000000000088";

  let posApp: INestApplication;
  let posTokens: { findActiveByRawToken: jest.Mock };

  beforeAll(async () => {
    const posSessions = {
      findActiveById: jest.fn<Promise<SessionRow | null>, [string]>().mockResolvedValue(null),
    };
    posTokens = {
      findActiveByRawToken: jest.fn<Promise<AuthTokenRow | null>, [string]>(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [StoresController],
      providers: [
        { provide: StoresService,         useValue: svc },
        { provide: SessionRepository,     useValue: posSessions },
        { provide: AuthTokenRepository,   useValue: posTokens },
        DashboardAuthGuard,
      ],
    })
      .overrideGuard(TenantContextGuard).useValue(tenant)
      .overrideGuard(RolesGuard).useValue(roles)
      .compile();

    posApp = moduleRef.createNestApplication({ bufferLogs: true });
    posApp.useGlobalFilters(new GlobalExceptionFilter());
    await posApp.init();
  });

  afterAll(async () => {
    if (posApp) await posApp.close();
  });

  it("REG-1: pos_operator bearer token → 401 on GET /api/v1/stores", async () => {
    posTokens.findActiveByRawToken.mockResolvedValue({
      id: REGRESSION_TOKEN_ID,
      tenantId: REGRESSION_TENANT_ID,
      userId: REGRESSION_USER_ID,
      scope: "pos_operator",
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
    } as unknown as AuthTokenRow);

    const res = await request(posApp.getHttpServer())
      .get("/api/v1/stores")
      .set("Authorization", "Bearer pos-operator-device-token");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: { code: "unauthorized" },
    });
  });

  it("REG-2: pos bearer token → 401 on GET /api/v1/stores", async () => {
    posTokens.findActiveByRawToken.mockResolvedValue({
      id: REGRESSION_TOKEN_ID,
      tenantId: REGRESSION_TENANT_ID,
      userId: null,
      scope: "pos",
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
    } as unknown as AuthTokenRow);

    const res = await request(posApp.getHttpServer())
      .get("/api/v1/stores")
      .set("Authorization", "Bearer pos-device-token");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: { code: "unauthorized" },
    });
  });
});
