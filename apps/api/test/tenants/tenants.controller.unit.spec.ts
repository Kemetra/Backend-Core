/**
 * tenants.controller.unit.spec.ts
 *
 * Docker-free unit coverage for TenantsController.
 *
 * Strategy: minimal Nest app mounting only TenantsController.
 * Guards replaced with scripted CanActivate doubles; TenantsService
 * replaced with a hand-written fake. No Testcontainers, no DB, no network.
 *
 * Guard chain: AuthGuard (class) + RolesGuard (per-method on
 *   POST, GET /:id/members, PATCH /:id, DELETE /:id).
 * NOTE: TenantsController does NOT mount TenantContextGuard — it is
 *   intentionally excluded. Path :id IS the tenant context here.
 *   Reads `request.principal` (not `request.context`).
 *
 * NOTE: The scripted RolesGuard always throws ForbiddenException for
 * simplicity. The real RolesGuard's `denyAs` logic (403 for POST/DELETE
 * via @PlatformAdminOnly, 404 for PATCH/listMembers via @RolesFromParam
 * per FR-ISO-4) is tested in the integration layer. These unit tests
 * cover guard-wiring, response-projection, and service-delegation only.
 *
 * Endpoints:
 *   GET    /api/v1/tenants               → 200 TenantSummaryBody[]
 *   POST   /api/v1/tenants               → 201 TenantBody
 *   GET    /api/v1/tenants/:id/members   → 200 MembershipDetailBody[]
 *   GET    /api/v1/tenants/:id           → 200 TenantBody
 *   PATCH  /api/v1/tenants/:id           → 200 TenantBody
 *   DELETE /api/v1/tenants/:id           → 204 No Content
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

import type { Principal } from "../../src/auth/auth.guard";
import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";
import { RolesGuard } from "../../src/auth/roles.guard";
import { PathTenantSupportSessionGuard } from "../../src/platform-support-sessions/path-tenant-support-session.guard";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";

import { TenantsController } from "../../src/tenants/tenants.controller";
import { TenantsService } from "../../src/tenants/tenants.service";
import type { TenantRecord } from "../../src/tenants/tenants.repository";
import type { MembershipDetail } from "../../src/context/membership.repository";

// ---------------------------------------------------------------------------
// Fixed UUIDs
// ---------------------------------------------------------------------------

const TENANT_ID    = "0f000000-0000-7000-8000-000000000001";
const MEMBERSHIP_ID = "0f000000-0000-7000-8000-000000000002";
const USER_ID      = "0f000000-0000-7000-8000-000000000003";
const STORE_ID     = "0f000000-0000-7000-8000-000000000004";
const NOT_A_UUID   = "not-a-uuid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeTenantRecord(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id: TENANT_ID,
    slug: "acme-corp",
    name: "Acme Corp",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeMembershipDetail(overrides: Partial<MembershipDetail> = {}): MembershipDetail {
  return {
    membershipId: MEMBERSHIP_ID,
    user: { id: USER_ID, email: "user@example.com", displayName: "User One" },
    roleCode: "owner",
    storeAccessKind: "all",
    accessibleStoreIds: [],
    revokedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class FakeTenantsService {
  public lastListArgs: { principal: Principal } | null = null;
  public lastCreateArgs: { principal: Principal; body: unknown } | null = null;
  public lastListMembersArgs: { principal: Principal; tenantId: string } | null = null;
  public lastReadArgs: { principal: Principal; tenantId: string } | null = null;
  public lastUpdateArgs: { principal: Principal; tenantId: string; body: unknown } | null = null;
  public lastSoftDeleteArgs: { principal: Principal; tenantId: string } | null = null;

  public listResult: TenantRecord[] = [makeTenantRecord()];
  public createResult: TenantRecord = makeTenantRecord();
  public listMembersResult: MembershipDetail[] = [makeMembershipDetail()];
  public readResult: TenantRecord = makeTenantRecord();
  public updateResult: TenantRecord = makeTenantRecord();

  async list(principal: Principal): Promise<TenantRecord[]> {
    this.lastListArgs = { principal };
    return this.listResult;
  }

  async create(principal: Principal, body: unknown): Promise<TenantRecord> {
    this.lastCreateArgs = { principal, body };
    return this.createResult;
  }

  async listMembers(principal: Principal, tenantId: string): Promise<MembershipDetail[]> {
    this.lastListMembersArgs = { principal, tenantId };
    return this.listMembersResult;
  }

  async read(principal: Principal, tenantId: string): Promise<TenantRecord> {
    this.lastReadArgs = { principal, tenantId };
    return this.readResult;
  }

  async update(principal: Principal, tenantId: string, body: unknown): Promise<TenantRecord> {
    this.lastUpdateArgs = { principal, tenantId, body };
    return this.updateResult;
  }

  async softDelete(principal: Principal, tenantId: string): Promise<void> {
    this.lastSoftDeleteArgs = { principal, tenantId };
  }
}

class ScriptedAuthGuard implements CanActivate {
  public mode: "ok" | "reject" | "no-principal" = "ok";
  public principal: Principal = { kind: "session", sessionId: "sess-1", userId: USER_ID };

  canActivate(ctx: ExecutionContext): boolean {
    if (this.mode === "reject") throw new UnauthorizedException("Unauthorized");
    if (this.mode === "no-principal") return true; // does NOT set request.principal
    const req = ctx.switchToHttp().getRequest<{ principal?: Principal }>();
    req.principal = this.principal;
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
let svc: FakeTenantsService;
let auth: ScriptedAuthGuard;
let roles: ScriptedRolesGuard;

beforeAll(async () => {
  svc   = new FakeTenantsService();
  auth  = new ScriptedAuthGuard();
  roles = new ScriptedRolesGuard();

  const moduleRef = await Test.createTestingModule({
    controllers: [TenantsController],
    providers: [
      { provide: TenantsService, useValue: svc },
    ],
  })
    .overrideGuard(DashboardAuthGuard).useValue(auth)
    .overrideGuard(RolesGuard).useValue(roles)
    .overrideGuard(PathTenantSupportSessionGuard).useValue({ canActivate: () => true })
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
  auth.mode  = "ok";
  roles.mode = "ok";
  auth.principal = { kind: "session", sessionId: "sess-1", userId: USER_ID };
  svc.lastListArgs        = null;
  svc.lastCreateArgs      = null;
  svc.lastListMembersArgs = null;
  svc.lastReadArgs        = null;
  svc.lastUpdateArgs      = null;
  svc.lastSoftDeleteArgs  = null;
  svc.listResult        = [makeTenantRecord()];
  svc.createResult      = makeTenantRecord();
  svc.listMembersResult = [makeMembershipDetail()];
  svc.readResult        = makeTenantRecord();
  svc.updateResult      = makeTenantRecord();
});

function http() {
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// GET /api/v1/tenants
// ---------------------------------------------------------------------------

describe("GET /api/v1/tenants", () => {
  it("happy path: returns 200 with summary array (id, slug, name only)", async () => {
    const res = await http().get("/api/v1/tenants");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: TENANT_ID, slug: "acme-corp", name: "Acme Corp" },
    ]);
    // Summary shape must NOT include status, created_at, etc.
    expect(res.body[0]).not.toHaveProperty("status");
    expect(res.body[0]).not.toHaveProperty("created_at");
  });

  it("forwards principal to service.list", async () => {
    await http().get("/api/v1/tenants");
    expect(svc.lastListArgs).not.toBeNull();
    expect(svc.lastListArgs!.principal).toMatchObject({ kind: "session" });
  });

  it("returns empty array when service returns []", async () => {
    svc.listResult = [];
    const res = await http().get("/api/v1/tenants");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    auth.mode = "reject";
    const res = await http().get("/api/v1/tenants");
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastListArgs).toBeNull();
  });

  it("returns 401 when request.principal is absent despite guard passing", async () => {
    auth.mode = "no-principal";
    const res = await http().get("/api/v1/tenants");
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/tenants
// ---------------------------------------------------------------------------

describe("POST /api/v1/tenants", () => {
  const VALID_BODY = { slug: "acme-corp", name: "Acme Corp" };

  it("happy path: returns 201 with full tenant body", async () => {
    const res = await http().post("/api/v1/tenants").send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: TENANT_ID,
      slug: "acme-corp",
      name: "Acme Corp",
      status: "active",
    });
    expect(res.body.created_at).toBe(NOW.toISOString());
    expect(res.body.deleted_at).toBeNull();
  });

  it("forwards principal and body to service.create", async () => {
    await http().post("/api/v1/tenants").send(VALID_BODY);
    expect(svc.lastCreateArgs).not.toBeNull();
    expect(svc.lastCreateArgs!.principal).toMatchObject({ kind: "session" });
    expect(svc.lastCreateArgs!.body).toMatchObject(VALID_BODY);
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    auth.mode = "reject";
    const res = await http().post("/api/v1/tenants").send(VALID_BODY);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastCreateArgs).toBeNull();
  });

  it("returns 403 when RolesGuard rejects — service not called", async () => {
    roles.mode = "forbid";
    const res = await http().post("/api/v1/tenants").send(VALID_BODY);
    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, "forbidden");
    expect(svc.lastCreateArgs).toBeNull();
  });

  it("returns 401 when request.principal is absent despite guard passing", async () => {
    auth.mode = "no-principal";
    const res = await http().post("/api/v1/tenants").send(VALID_BODY);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 400 for missing `slug` field", async () => {
    const res = await http().post("/api/v1/tenants").send({ name: "Acme Corp" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastCreateArgs).toBeNull();
  });

  it("returns 400 for slug with invalid format (uppercase)", async () => {
    const res = await http().post("/api/v1/tenants").send({ slug: "ACME-Corp", name: "Acme" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastCreateArgs).toBeNull();
  });

  it("returns 400 for slug too short (< 3 chars)", async () => {
    const res = await http().post("/api/v1/tenants").send({ slug: "ac", name: "Acme" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastCreateArgs).toBeNull();
  });

  it("returns 400 for extra key (strict schema — e.g. id in body)", async () => {
    const res = await http()
      .post("/api/v1/tenants")
      .send({ ...VALID_BODY, id: TENANT_ID });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastCreateArgs).toBeNull();
  });

  it("returns 400 for missing `name` field", async () => {
    const res = await http().post("/api/v1/tenants").send({ slug: "acme-corp" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastCreateArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/tenants/:id/members
// ---------------------------------------------------------------------------

describe("GET /api/v1/tenants/:id/members", () => {
  it("happy path: returns 200 with mapped membership array", async () => {
    const res = await http().get(`/api/v1/tenants/${TENANT_ID}/members`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        membership_id: MEMBERSHIP_ID,
        user: {
          id: USER_ID,
          email: "user@example.com",
          display_name: "User One",
        },
        role_code: "owner",
        store_access_kind: "all",
        accessible_store_ids: [],
        revoked_at: null,
      },
    ]);
  });

  it("maps revokedAt date to revoked_at ISO string", async () => {
    const revokedAt = new Date("2026-03-01T00:00:00.000Z");
    svc.listMembersResult = [makeMembershipDetail({ revokedAt })];
    const res = await http().get(`/api/v1/tenants/${TENANT_ID}/members`);
    expect(res.status).toBe(200);
    expect(res.body[0].revoked_at).toBe(revokedAt.toISOString());
  });

  it("maps specific store access with ids correctly", async () => {
    svc.listMembersResult = [
      makeMembershipDetail({
        storeAccessKind: "specific",
        accessibleStoreIds: [STORE_ID],
      }),
    ];
    const res = await http().get(`/api/v1/tenants/${TENANT_ID}/members`);
    expect(res.status).toBe(200);
    expect(res.body[0].store_access_kind).toBe("specific");
    expect(res.body[0].accessible_store_ids).toEqual([STORE_ID]);
  });

  it("forwards principal and tenant_id to service.listMembers", async () => {
    await http().get(`/api/v1/tenants/${TENANT_ID}/members`);
    expect(svc.lastListMembersArgs).not.toBeNull();
    expect(svc.lastListMembersArgs!.tenantId).toBe(TENANT_ID);
    expect(svc.lastListMembersArgs!.principal).toMatchObject({ kind: "session" });
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    auth.mode = "reject";
    const res = await http().get(`/api/v1/tenants/${TENANT_ID}/members`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastListMembersArgs).toBeNull();
  });

  it("returns 403 when RolesGuard rejects — service not called", async () => {
    roles.mode = "forbid";
    const res = await http().get(`/api/v1/tenants/${TENANT_ID}/members`);
    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, "forbidden");
    expect(svc.lastListMembersArgs).toBeNull();
  });

  it("returns 401 when request.principal is absent despite guard passing", async () => {
    auth.mode = "no-principal";
    const res = await http().get(`/api/v1/tenants/${TENANT_ID}/members`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 400 for non-UUID tenant id — service not called", async () => {
    const res = await http().get(`/api/v1/tenants/${NOT_A_UUID}/members`);
    expect(res.status).toBe(400);
    expect(svc.lastListMembersArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/tenants/:id
// ---------------------------------------------------------------------------

describe("GET /api/v1/tenants/:id", () => {
  it("happy path: returns 200 with full tenant body", async () => {
    const res = await http().get(`/api/v1/tenants/${TENANT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: TENANT_ID,
      slug: "acme-corp",
      name: "Acme Corp",
      status: "active",
    });
    expect(res.body.created_at).toBe(NOW.toISOString());
    expect(res.body.deleted_at).toBeNull();
  });

  it("maps deletedAt to deleted_at ISO string when set", async () => {
    const deletedAt = new Date("2026-04-01T00:00:00.000Z");
    svc.readResult = makeTenantRecord({ deletedAt });
    const res = await http().get(`/api/v1/tenants/${TENANT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted_at).toBe(deletedAt.toISOString());
  });

  it("forwards principal and tenant_id to service.read", async () => {
    await http().get(`/api/v1/tenants/${TENANT_ID}`);
    expect(svc.lastReadArgs).not.toBeNull();
    expect(svc.lastReadArgs!.tenantId).toBe(TENANT_ID);
    expect(svc.lastReadArgs!.principal).toMatchObject({ kind: "session" });
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    auth.mode = "reject";
    const res = await http().get(`/api/v1/tenants/${TENANT_ID}`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastReadArgs).toBeNull();
  });

  it("returns 401 when request.principal is absent despite guard passing", async () => {
    auth.mode = "no-principal";
    const res = await http().get(`/api/v1/tenants/${TENANT_ID}`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 400 for non-UUID tenant id — service not called", async () => {
    const res = await http().get(`/api/v1/tenants/${NOT_A_UUID}`);
    expect(res.status).toBe(400);
    expect(svc.lastReadArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/tenants/:id
// ---------------------------------------------------------------------------

describe("PATCH /api/v1/tenants/:id", () => {
  it("happy path (name only): returns 200 with updated full body", async () => {
    svc.updateResult = makeTenantRecord({ name: "Renamed Corp" });
    const res = await http().patch(`/api/v1/tenants/${TENANT_ID}`).send({ name: "Renamed Corp" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Renamed Corp");
  });

  it("happy path (status only): returns 200", async () => {
    svc.updateResult = makeTenantRecord({ status: "suspended" });
    const res = await http().patch(`/api/v1/tenants/${TENANT_ID}`).send({ status: "suspended" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("suspended");
  });

  it("forwards principal, tenant_id, and body to service.update", async () => {
    await http().patch(`/api/v1/tenants/${TENANT_ID}`).send({ name: "Updated" });
    expect(svc.lastUpdateArgs).not.toBeNull();
    expect(svc.lastUpdateArgs!.tenantId).toBe(TENANT_ID);
    expect(svc.lastUpdateArgs!.principal).toMatchObject({ kind: "session" });
    expect(svc.lastUpdateArgs!.body).toMatchObject({ name: "Updated" });
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    auth.mode = "reject";
    const res = await http().patch(`/api/v1/tenants/${TENANT_ID}`).send({ name: "X" });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("returns 403 when RolesGuard rejects — service not called", async () => {
    roles.mode = "forbid";
    const res = await http().patch(`/api/v1/tenants/${TENANT_ID}`).send({ name: "X" });
    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, "forbidden");
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("returns 401 when request.principal is absent despite guard passing", async () => {
    auth.mode = "no-principal";
    const res = await http().patch(`/api/v1/tenants/${TENANT_ID}`).send({ name: "X" });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 400 for non-UUID tenant id — service not called", async () => {
    const res = await http().patch(`/api/v1/tenants/${NOT_A_UUID}`).send({ name: "X" });
    expect(res.status).toBe(400);
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("returns 400 for empty body (at-least-one-field rule)", async () => {
    const res = await http().patch(`/api/v1/tenants/${TENANT_ID}`).send({});
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("returns 400 for slug in body (not in update schema — strict)", async () => {
    const res = await http()
      .patch(`/api/v1/tenants/${TENANT_ID}`)
      .send({ slug: "new-slug" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("returns 400 for invalid status value", async () => {
    const res = await http()
      .patch(`/api/v1/tenants/${TENANT_ID}`)
      .send({ status: "deleted" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastUpdateArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/tenants/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/tenants/:id", () => {
  it("happy path: returns 204 with empty body", async () => {
    const res = await http().delete(`/api/v1/tenants/${TENANT_ID}`);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it("forwards principal and tenant_id to service.softDelete", async () => {
    await http().delete(`/api/v1/tenants/${TENANT_ID}`);
    expect(svc.lastSoftDeleteArgs).not.toBeNull();
    expect(svc.lastSoftDeleteArgs!.tenantId).toBe(TENANT_ID);
    expect(svc.lastSoftDeleteArgs!.principal).toMatchObject({ kind: "session" });
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    auth.mode = "reject";
    const res = await http().delete(`/api/v1/tenants/${TENANT_ID}`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastSoftDeleteArgs).toBeNull();
  });

  it("returns 403 when RolesGuard rejects — service not called", async () => {
    roles.mode = "forbid";
    const res = await http().delete(`/api/v1/tenants/${TENANT_ID}`);
    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, "forbidden");
    expect(svc.lastSoftDeleteArgs).toBeNull();
  });

  it("returns 401 when request.principal is absent despite guard passing", async () => {
    auth.mode = "no-principal";
    const res = await http().delete(`/api/v1/tenants/${TENANT_ID}`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 400 for non-UUID tenant id — service not called", async () => {
    const res = await http().delete(`/api/v1/tenants/${NOT_A_UUID}`);
    expect(res.status).toBe(400);
    expect(svc.lastSoftDeleteArgs).toBeNull();
  });
});
