/**
 * context.controller.unit.spec.ts
 *
 * Docker-free unit coverage for ContextController.
 *
 * Strategy: minimal Nest HTTP app mounting only ContextController.
 * AuthGuard replaced with a scripted CanActivate double that supports
 * three modes:
 *   "ok"           — sets request.principal and returns true
 *   "reject"       — throws UnauthorizedException (guard rejects)
 *   "no-principal" — returns true but does NOT set request.principal
 *                    (exercises the controller's own defensive check)
 *
 * ContextService replaced with hand-written jest.fn() stubs.
 * ZodValidationPipe registered globally so per-route @Body(ZodPipe) works.
 * GlobalExceptionFilter registered so error envelopes match production shape.
 *
 * Tests:
 *   CC1  — GET  /me       happy path → calls getActiveContext, returns service result
 *   CC2  — GET  /me       AuthGuard rejects → 401
 *   CC3  — GET  /me       no-principal → 401 from controller defensive check
 *   CC4  — POST /tenant   happy path → calls switchTenant(principal, tenantId)
 *   CC5  — POST /tenant   AuthGuard rejects → 401
 *   CC6  — POST /tenant   no-principal → 401
 *   CC7  — POST /tenant   missing tenant_id → 400 validation_error
 *   CC8  — POST /tenant   non-UUID tenant_id → 400 validation_error
 *   CC9  — POST /store    happy path → calls switchStore(principal, storeId)
 *   CC10 — POST /store    AuthGuard rejects → 401
 *   CC11 — POST /store    no-principal → 401
 *   CC12 — POST /store    missing store_id → 400
 *   CC13 — DELETE /store  happy path → calls clearStore(principal)
 *   CC14 — DELETE /store  AuthGuard rejects → 401
 *   CC15 — DELETE /store  no-principal → 401
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import type { AuthedRequest, Principal } from "../../src/auth/auth.guard";
import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";
import { ContextController } from "../../src/context/context.controller";
import { ContextService } from "../../src/context/context.service";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

const USER_ID   = "0d000000-0000-7000-8000-000000000001";
const TENANT_ID = "0d000000-0000-7000-8000-000000000002";
const STORE_ID  = "0d000000-0000-7000-8000-000000000003";
const SESSION_ID = "0d000000-0000-7000-8000-000000000004";

// ---------------------------------------------------------------------------
// Fake ContextResponseBody
// ---------------------------------------------------------------------------

const FAKE_CONTEXT_RESPONSE = {
  user: {
    id: USER_ID,
    email: "user@example.com",
    display_name: null,
    is_platform_admin: false,
  },
  active_tenant: null,
  active_store: null,
  active_role_code: null,
  memberships: [],
};

// ---------------------------------------------------------------------------
// Scripted AuthGuard
// ---------------------------------------------------------------------------

class ScriptedAuthGuard implements CanActivate {
  mode: "ok" | "reject" | "no-principal" = "ok";
  principal: Principal = {
    kind: "session",
    sessionId: SESSION_ID,
    userId: USER_ID,
  };

  canActivate(ctx: ExecutionContext): boolean {
    if (this.mode === "reject") {
      throw new UnauthorizedException("Unauthorized");
    }
    if (this.mode === "no-principal") {
      // Deliberately do NOT attach principal — exercises the controller's
      // own defensive `if (!principal) throw new UnauthorizedException()`
      return true;
    }
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    req.principal = this.principal;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helper
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
// Fixture — one app per file; reset mocks/guard before each test
// ---------------------------------------------------------------------------

let app: INestApplication;
let guard: ScriptedAuthGuard;
let getActiveContextMock: jest.Mock;
let switchTenantMock: jest.Mock;
let switchStoreMock: jest.Mock;
let clearStoreMock: jest.Mock;

beforeAll(async () => {
  guard = new ScriptedAuthGuard();

  getActiveContextMock = jest.fn().mockResolvedValue(FAKE_CONTEXT_RESPONSE);
  switchTenantMock     = jest.fn().mockResolvedValue(FAKE_CONTEXT_RESPONSE);
  switchStoreMock      = jest.fn().mockResolvedValue(FAKE_CONTEXT_RESPONSE);
  clearStoreMock       = jest.fn().mockResolvedValue(FAKE_CONTEXT_RESPONSE);

  const fakeSvc = {
    getActiveContext: getActiveContextMock,
    switchTenant:     switchTenantMock,
    switchStore:      switchStoreMock,
    clearStore:       clearStoreMock,
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [ContextController],
    providers: [
      { provide: ContextService, useValue: fakeSvc },
    ],
  })
    .overrideGuard(DashboardAuthGuard).useValue(guard)
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
  guard.mode = "ok";
  guard.principal = {
    kind: "session",
    sessionId: SESSION_ID,
    userId: USER_ID,
  };
  getActiveContextMock.mockClear();
  switchTenantMock.mockClear();
  switchStoreMock.mockClear();
  clearStoreMock.mockClear();
  getActiveContextMock.mockResolvedValue(FAKE_CONTEXT_RESPONSE);
  switchTenantMock.mockResolvedValue(FAKE_CONTEXT_RESPONSE);
  switchStoreMock.mockResolvedValue(FAKE_CONTEXT_RESPONSE);
  clearStoreMock.mockResolvedValue(FAKE_CONTEXT_RESPONSE);
});

function http() {
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// CC1 — GET /me — happy path
// ---------------------------------------------------------------------------

describe("CC1 — GET /api/v1/context/me: happy path", () => {
  it("calls getActiveContext with principal and returns 200 service result", async () => {
    const res = await http().get("/api/v1/context/me");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(FAKE_CONTEXT_RESPONSE);
    expect(getActiveContextMock).toHaveBeenCalledTimes(1);
    expect(getActiveContextMock).toHaveBeenCalledWith(guard.principal);
  });
});

// ---------------------------------------------------------------------------
// CC2 — GET /me — AuthGuard rejects
// ---------------------------------------------------------------------------

describe("CC2 — GET /api/v1/context/me: AuthGuard rejects", () => {
  it("returns 401 when AuthGuard throws UnauthorizedException", async () => {
    guard.mode = "reject";
    const res = await http().get("/api/v1/context/me");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(getActiveContextMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CC3 — GET /me — no-principal mode
// ---------------------------------------------------------------------------

describe("CC3 — GET /api/v1/context/me: no-principal → 401 from controller", () => {
  it("returns 401 from the controller's own defensive check when principal is missing", async () => {
    guard.mode = "no-principal";
    const res = await http().get("/api/v1/context/me");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(getActiveContextMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CC4 — POST /tenant — happy path
// ---------------------------------------------------------------------------

describe("CC4 — POST /api/v1/context/tenant: happy path", () => {
  it("calls switchTenant(principal, tenantId) and returns 200", async () => {
    const res = await http()
      .post("/api/v1/context/tenant")
      .send({ tenant_id: TENANT_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(FAKE_CONTEXT_RESPONSE);
    expect(switchTenantMock).toHaveBeenCalledTimes(1);
    expect(switchTenantMock).toHaveBeenCalledWith(guard.principal, TENANT_ID, null);
  });
});

// ---------------------------------------------------------------------------
// CC5 — POST /tenant — AuthGuard rejects
// ---------------------------------------------------------------------------

describe("CC5 — POST /api/v1/context/tenant: AuthGuard rejects", () => {
  it("returns 401 when AuthGuard rejects — service not called", async () => {
    guard.mode = "reject";
    const res = await http()
      .post("/api/v1/context/tenant")
      .send({ tenant_id: TENANT_ID });

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(switchTenantMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CC6 — POST /tenant — no-principal
// ---------------------------------------------------------------------------

describe("CC6 — POST /api/v1/context/tenant: no-principal → 401", () => {
  it("returns 401 from controller defensive check when principal absent", async () => {
    guard.mode = "no-principal";
    const res = await http()
      .post("/api/v1/context/tenant")
      .send({ tenant_id: TENANT_ID });

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(switchTenantMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CC7 — POST /tenant — missing tenant_id
// ---------------------------------------------------------------------------

describe("CC7 — POST /api/v1/context/tenant: missing tenant_id → 400", () => {
  it("returns 400 validation_error when tenant_id is absent", async () => {
    const res = await http()
      .post("/api/v1/context/tenant")
      .send({});

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(switchTenantMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CC8 — POST /tenant — non-UUID tenant_id
// ---------------------------------------------------------------------------

describe("CC8 — POST /api/v1/context/tenant: non-UUID tenant_id → 400", () => {
  it("returns 400 validation_error when tenant_id is not a UUID", async () => {
    const res = await http()
      .post("/api/v1/context/tenant")
      .send({ tenant_id: "not-a-uuid" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(switchTenantMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CC9 — POST /store — happy path
// ---------------------------------------------------------------------------

describe("CC9 — POST /api/v1/context/store: happy path", () => {
  it("calls switchStore(principal, storeId) and returns 200", async () => {
    const res = await http()
      .post("/api/v1/context/store")
      .send({ store_id: STORE_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(FAKE_CONTEXT_RESPONSE);
    expect(switchStoreMock).toHaveBeenCalledTimes(1);
    expect(switchStoreMock).toHaveBeenCalledWith(guard.principal, STORE_ID, null);
  });
});

// ---------------------------------------------------------------------------
// CC10 — POST /store — AuthGuard rejects
// ---------------------------------------------------------------------------

describe("CC10 — POST /api/v1/context/store: AuthGuard rejects", () => {
  it("returns 401 when AuthGuard rejects — service not called", async () => {
    guard.mode = "reject";
    const res = await http()
      .post("/api/v1/context/store")
      .send({ store_id: STORE_ID });

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(switchStoreMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CC11 — POST /store — no-principal
// ---------------------------------------------------------------------------

describe("CC11 — POST /api/v1/context/store: no-principal → 401", () => {
  it("returns 401 from controller defensive check when principal absent", async () => {
    guard.mode = "no-principal";
    const res = await http()
      .post("/api/v1/context/store")
      .send({ store_id: STORE_ID });

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(switchStoreMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CC12 — POST /store — missing store_id
// ---------------------------------------------------------------------------

describe("CC12 — POST /api/v1/context/store: missing store_id → 400", () => {
  it("returns 400 validation_error when store_id is absent", async () => {
    const res = await http()
      .post("/api/v1/context/store")
      .send({});

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(switchStoreMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CC13 — DELETE /store — happy path
// ---------------------------------------------------------------------------

describe("CC13 — DELETE /api/v1/context/store: happy path", () => {
  it("calls clearStore(principal) and returns 200", async () => {
    const res = await http().delete("/api/v1/context/store");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(FAKE_CONTEXT_RESPONSE);
    expect(clearStoreMock).toHaveBeenCalledTimes(1);
    expect(clearStoreMock).toHaveBeenCalledWith(guard.principal);
  });
});

// ---------------------------------------------------------------------------
// CC14 — DELETE /store — AuthGuard rejects
// ---------------------------------------------------------------------------

describe("CC14 — DELETE /api/v1/context/store: AuthGuard rejects", () => {
  it("returns 401 when AuthGuard rejects — service not called", async () => {
    guard.mode = "reject";
    const res = await http().delete("/api/v1/context/store");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(clearStoreMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CC15 — DELETE /store — no-principal
// ---------------------------------------------------------------------------

describe("CC15 — DELETE /api/v1/context/store: no-principal → 401", () => {
  it("returns 401 from controller defensive check when principal absent", async () => {
    guard.mode = "no-principal";
    const res = await http().delete("/api/v1/context/store");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(clearStoreMock).not.toHaveBeenCalled();
  });
});
