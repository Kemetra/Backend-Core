/**
 * audit.controller.unit.spec.ts
 *
 * Docker-free unit coverage for AuditController.
 *
 * Strategy: minimal Nest HTTP app mounting only AuditController.
 * Guards replaced with scripted CanActivate doubles.
 * AuditService replaced with jest.fn() stubs.
 * ZodValidationPipe registered globally so per-route @Query(ZodPipe) works.
 * GlobalExceptionFilter registered so error envelopes match production shape.
 *
 * Tests:
 *   AuditC1  — GET /events happy path → 200, calls service.list with correct args
 *   AuditC2  — default limit=50 when omitted
 *   AuditC3  — all optional query params forwarded correctly
 *   AuditC4  — isPlatformAdmin forwarded from resolved context
 *   AuditC5  — response shape is service result verbatim
 *   AuditC6  — AuthGuard rejects → 401, service not called
 *   AuditC7  — TenantContextGuard rejects → 401, service not called
 *   AuditC8  — RolesGuard rejects → 403, service not called
 *   AuditC9  — request.context absent despite guards passing → 401
 *   AuditC10 — ctx.tenantId null despite guards passing → 401
 *   AuditC11 — invalid actor_user_id (not UUID) → 400
 *   AuditC12 — invalid store_id (not UUID) → 400
 *   AuditC13 — limit out of range (0) → 400
 *   AuditC14 — limit out of range (201) → 400
 *   AuditC15 — malformed cursor → 400
 *   AuditC16 — @Auditable decorator NOT present on listAuditEvents (no self-audit)
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
import { Reflector } from "@nestjs/core";
import request from "supertest";

import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";
import { RolesGuard } from "../../src/auth/roles.guard";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../src/context/types";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";

import { AuditController } from "../../src/audit/audit.controller";
import { AuditService } from "../../src/audit/audit.service";
import { AUDITABLE_KEY } from "../../src/audit/auditable.decorator";
import { encodeCursor } from "../../src/audit/audit.query.schema";
import type { ListAuditEventsResponse } from "../../src/audit/audit.dto";

// ---------------------------------------------------------------------------
// Fixed UUIDs
// ---------------------------------------------------------------------------

const TENANT_ID      = "0e000000-0000-7000-8000-000000000001";
const USER_ID        = "0e000000-0000-7000-8000-000000000002";
const STORE_ID       = "0e000000-0000-7000-8000-000000000003";
const AUDIT_ID       = "0e000000-0000-7000-8000-000000000004";
const NOT_A_UUID     = "not-a-uuid";

// ---------------------------------------------------------------------------
// Fake service response
// ---------------------------------------------------------------------------

const FAKE_LIST_RESPONSE: ListAuditEventsResponse = {
  items: [
    {
      id: AUDIT_ID,
      occurred_at: "2024-01-15T12:00:00.000Z",
      actor_user_id: USER_ID,
      actor_label: null,
      tenant_id: TENANT_ID,
      store_id: null,
      action: "context.switch.tenant",
      kind: "change",
      target_type: null,
      target_id: null,
      request_id: "req-1",
      metadata: {},
    },
  ],
  next_cursor: null,
};

// ---------------------------------------------------------------------------
// Scripted guards
// ---------------------------------------------------------------------------

class ScriptedAuthGuard implements CanActivate {
  mode: "ok" | "reject" = "ok";

  canActivate(ctx: ExecutionContext): boolean {
    if (this.mode === "reject") throw new UnauthorizedException("Unauthorized");
    const req = ctx.switchToHttp().getRequest<{ principal?: object }>();
    req.principal = { kind: "session", sessionId: "sess-1", userId: USER_ID };
    return true;
  }
}

class ScriptedTenantContextGuard implements CanActivate {
  mode: "ok" | "no-tenant" | "no-context" | "null-tenant-id" = "ok";
  context: ResolvedContext = {
    userId: USER_ID,
    tenantId: TENANT_ID,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
  };

  canActivate(ctx: ExecutionContext): boolean {
    if (this.mode === "no-tenant") throw new UnauthorizedException("Unauthorized");
    if (this.mode === "no-context") return true;
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext }>();
    if (this.mode === "null-tenant-id") {
      req.context = { ...this.context, tenantId: null as unknown as string };
    } else {
      req.context = this.context;
    }
    return true;
  }
}

class ScriptedRolesGuard implements CanActivate {
  mode: "ok" | "forbid" = "ok";

  canActivate(_ctx: ExecutionContext): boolean {
    if (this.mode === "forbid") throw new ForbiddenException("Insufficient role.");
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helper — assert error envelope shape
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
// Fixture — one app for all tests
// ---------------------------------------------------------------------------

let app: INestApplication;
let auth: ScriptedAuthGuard;
let tenant: ScriptedTenantContextGuard;
let roles: ScriptedRolesGuard;
let listMock: jest.Mock;

beforeAll(async () => {
  auth   = new ScriptedAuthGuard();
  tenant = new ScriptedTenantContextGuard();
  roles  = new ScriptedRolesGuard();

  listMock = jest.fn().mockResolvedValue(FAKE_LIST_RESPONSE);

  const fakeSvc = { list: listMock };

  const moduleRef = await Test.createTestingModule({
    controllers: [AuditController],
    providers: [
      { provide: AuditService, useValue: fakeSvc },
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
    userId: USER_ID,
    tenantId: TENANT_ID,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
  };
  listMock.mockClear();
  listMock.mockResolvedValue(FAKE_LIST_RESPONSE);
});

function http() {
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// AuditC1 — Happy path: returns 200 with service result
// ---------------------------------------------------------------------------

describe("AuditC1 — GET /api/v1/audit/events: happy path 200", () => {
  it("returns 200 and calls service.list with correct tenantId", async () => {
    const res = await http().get("/api/v1/audit/events");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(FAKE_LIST_RESPONSE);
    expect(listMock).toHaveBeenCalledTimes(1);
    const arg = listMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.tenantId).toBe(TENANT_ID);
  });
});

// ---------------------------------------------------------------------------
// AuditC2 — Default limit=50 when omitted
// ---------------------------------------------------------------------------

describe("AuditC2 — default limit=50 when not provided", () => {
  it("forwards limit=50 to service.list when query has no limit", async () => {
    await http().get("/api/v1/audit/events");

    const arg = listMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.limit).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// AuditC3 — All optional query params forwarded correctly
// ---------------------------------------------------------------------------

describe("AuditC3 — optional query params forwarded to service", () => {
  it("forwards action, actor_user_id, store_id, from, to, and limit correctly", async () => {
    const fromDate = "2024-01-01T00:00:00.000Z";
    const toDate   = "2024-01-31T23:59:59.999Z";

    await http()
      .get("/api/v1/audit/events")
      .query({
        action: "context.switch",
        actor_user_id: USER_ID,
        store_id: STORE_ID,
        from: fromDate,
        to: toDate,
        limit: "10",
      });

    expect(listMock).toHaveBeenCalledTimes(1);
    const arg = listMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.action).toBe("context.switch");
    expect(arg.actor_user_id).toBe(USER_ID);
    expect(arg.store_id).toBe(STORE_ID);
    expect(arg.limit).toBe(10);
    expect(arg.from).toBeInstanceOf(Date);
    expect(arg.to).toBeInstanceOf(Date);
    expect((arg.from as Date).toISOString()).toBe(fromDate);
    expect((arg.to as Date).toISOString()).toBe(toDate);
  });
});

// ---------------------------------------------------------------------------
// AuditC4 — isPlatformAdmin forwarded from resolved context
// ---------------------------------------------------------------------------

describe("AuditC4 — isPlatformAdmin forwarded to service", () => {
  it("forwards isPlatformAdmin=true from resolved context", async () => {
    tenant.context = { ...tenant.context, isPlatformAdmin: true };

    await http().get("/api/v1/audit/events");

    const arg = listMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.isPlatformAdmin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AuditC5 — Response shape is service result verbatim
// ---------------------------------------------------------------------------

describe("AuditC5 — response is service result verbatim", () => {
  it("returns the exact shape returned by auditService.list", async () => {
    const customResponse: ListAuditEventsResponse = {
      items: [],
      next_cursor: "somebase64cursor",
    };
    listMock.mockResolvedValueOnce(customResponse);

    const res = await http().get("/api/v1/audit/events");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(customResponse);
  });
});

// ---------------------------------------------------------------------------
// AuditC6 — AuthGuard rejects → 401, service not called
// ---------------------------------------------------------------------------

describe("AuditC6 — AuthGuard rejects: 401, service not called", () => {
  it("returns 401 when AuthGuard throws UnauthorizedException", async () => {
    auth.mode = "reject";
    const res = await http().get("/api/v1/audit/events");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(listMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AuditC7 — TenantContextGuard rejects → 401, service not called
// ---------------------------------------------------------------------------

describe("AuditC7 — TenantContextGuard rejects: 401, service not called", () => {
  it("returns 401 when TenantContextGuard throws UnauthorizedException", async () => {
    tenant.mode = "no-tenant";
    const res = await http().get("/api/v1/audit/events");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(listMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AuditC8 — RolesGuard rejects → 403, service not called
// ---------------------------------------------------------------------------

describe("AuditC8 — RolesGuard rejects: 403, service not called", () => {
  it("returns 403 when RolesGuard throws ForbiddenException", async () => {
    roles.mode = "forbid";
    const res = await http().get("/api/v1/audit/events");

    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, "forbidden");
    expect(listMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AuditC9 — request.context absent despite guards passing → 401
// ---------------------------------------------------------------------------

describe("AuditC9 — request.context absent: 401 from controller defensive check", () => {
  it("returns 401 from the controller's own check when context is missing", async () => {
    tenant.mode = "no-context";
    const res = await http().get("/api/v1/audit/events");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(listMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AuditC10 — ctx.tenantId null despite guards passing → 401
// ---------------------------------------------------------------------------

describe("AuditC10 — ctx.tenantId null: 401 from controller defensive check", () => {
  it("returns 401 when tenantId is null inside resolved context", async () => {
    tenant.mode = "null-tenant-id";
    const res = await http().get("/api/v1/audit/events");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(listMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AuditC11 — invalid actor_user_id (not UUID) → 400
// ---------------------------------------------------------------------------

describe("AuditC11 — invalid actor_user_id: 400 validation_error", () => {
  it("returns 400 when actor_user_id is not a UUID", async () => {
    const res = await http()
      .get("/api/v1/audit/events")
      .query({ actor_user_id: NOT_A_UUID });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(listMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AuditC12 — invalid store_id (not UUID) → 400
// ---------------------------------------------------------------------------

describe("AuditC12 — invalid store_id: 400 validation_error", () => {
  it("returns 400 when store_id is not a UUID", async () => {
    const res = await http()
      .get("/api/v1/audit/events")
      .query({ store_id: NOT_A_UUID });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(listMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AuditC13 — limit out of range (0) → 400
// ---------------------------------------------------------------------------

describe("AuditC13 — limit=0: 400 validation_error", () => {
  it("returns 400 when limit is below minimum (0)", async () => {
    const res = await http()
      .get("/api/v1/audit/events")
      .query({ limit: "0" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(listMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AuditC14 — limit out of range (201) → 400
// ---------------------------------------------------------------------------

describe("AuditC14 — limit=201: 400 validation_error", () => {
  it("returns 400 when limit exceeds maximum (201)", async () => {
    const res = await http()
      .get("/api/v1/audit/events")
      .query({ limit: "201" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(listMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AuditC15 — malformed cursor → 400
// ---------------------------------------------------------------------------

describe("AuditC15 — malformed cursor: 400 validation_error", () => {
  it("returns 400 when cursor cannot be decoded", async () => {
    const res = await http()
      .get("/api/v1/audit/events")
      .query({ cursor: "!!!not-base64url!!!" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(listMock).not.toHaveBeenCalled();
  });

  it("decodes and forwards a valid cursor to service.list", async () => {
    const occurredAt = new Date("2024-01-15T12:00:00.000Z");
    const validCursor = encodeCursor(occurredAt, AUDIT_ID);

    await http()
      .get("/api/v1/audit/events")
      .query({ cursor: validCursor });

    expect(listMock).toHaveBeenCalledTimes(1);
    const arg = listMock.mock.calls[0]![0] as Record<string, unknown>;
    const cursor = arg.cursor as { occurredAt: Date; id: string };
    expect(cursor).toBeDefined();
    expect(cursor.occurredAt).toBeInstanceOf(Date);
    expect(cursor.occurredAt.toISOString()).toBe(occurredAt.toISOString());
    expect(cursor.id).toBe(AUDIT_ID);
  });
});

// ---------------------------------------------------------------------------
// AuditC16 — listAuditEvents does NOT carry @Auditable (no self-audit)
// ---------------------------------------------------------------------------

describe("AuditC16 — listAuditEvents has no @Auditable decorator", () => {
  it("Reflector returns undefined for AUDITABLE_KEY on listAuditEvents — no self-audit loop", () => {
    const reflector = new Reflector();
    // Reflector.get reads metadata set by NestJS decorators on the handler
    const meta = reflector.get<string | undefined>(
      AUDITABLE_KEY,
      AuditController.prototype.listAuditEvents,
    );
    expect(meta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AuditC17 — RT-567 kind filter
// ---------------------------------------------------------------------------

describe("AuditC17 — kind query param (RT-567)", () => {
  it.each(["read", "change"])("forwards kind=%s to service.list", async (kind) => {
    const res = await http().get("/api/v1/audit/events").query({ kind });

    expect(res.status).toBe(200);
    const arg = listMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.kind).toBe(kind);
  });

  it("omitted kind reaches service.list as undefined", async () => {
    await http().get("/api/v1/audit/events");

    const arg = listMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.kind).toBeUndefined();
  });

  it("returns 400 validation_error for kind=bogus", async () => {
    const res = await http().get("/api/v1/audit/events").query({ kind: "bogus" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(listMock).not.toHaveBeenCalled();
  });

  it("still returns 403 for an insufficient role with kind set", async () => {
    roles.mode = "forbid";
    const res = await http().get("/api/v1/audit/events").query({ kind: "change" });

    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, "forbidden");
    expect(listMock).not.toHaveBeenCalled();
  });
});
