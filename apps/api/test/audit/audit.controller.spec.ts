/**
 * audit.controller.spec.ts — T235 controller integration.
 *
 * Strategy: build a minimal Nest app that mounts ONLY `AuditController`,
 * with the auth/tenant/roles guards and `AuditService` swapped for
 * scriptable test doubles. This pins the controller's actual
 * responsibilities — guard chain wiring, query validation, response
 * shape — without taking on a Testcontainers boot. The DB-level RLS
 * behaviour is exercised by `audit.repository.spec.ts`.
 *
 * Coverage:
 *   - 200 with the OpenAPI `ListAuditEventsResponse` shape.
 *   - 401 when AuthGuard rejects (no principal).
 *   - 401 when TenantContextGuard rejects (no active tenant).
 *   - 403 when RolesGuard rejects (insufficient role).
 *   - 400 envelope on malformed query.
 *   - tenant_admin sees only the active tenant context's rows
 *     (verified via service input forwarding).
 *   - listAuditEvents handler is NOT @Auditable (Reflector probe).
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  INestApplication,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";
import { RolesGuard } from "../../src/auth/roles.guard";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../src/context/types";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";

import { AuditController } from "../../src/audit/audit.controller";
import { AuditService } from "../../src/audit/audit.service";
import {
  AUDITABLE_KEY,
} from "../../src/audit/auditable.decorator";
import {
  encodeCursor,
} from "../../src/audit/audit.query.schema";
import type {
  ListAuditEventsResponse,
} from "../../src/audit/audit.dto";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const TENANT_A = "0a000000-0000-7000-8000-0000000000a1";
const ROW_ID = "0a000000-0000-7000-8000-0000000000b1";
const ACTOR = "0a000000-0000-7000-8000-00000000aa01";

class FakeAuditService {
  public lastInput: unknown = null;
  public toReturn: ListAuditEventsResponse = { items: [], next_cursor: null };

  async list(input: unknown): Promise<ListAuditEventsResponse> {
    this.lastInput = input;
    return this.toReturn;
  }
}

/** Toggle pattern shared with `auth.controller.spec` style — ergonomic for "next request rejects". */
class ScriptedAuthGuard implements CanActivate {
  public mode: "ok" | "reject" = "ok";
  public principal: { kind: "session"; sessionId: string; userId: string } = {
    kind: "session",
    sessionId: "sess-1",
    userId: "user-1",
  };

  canActivate(ctx: ExecutionContext): boolean {
    if (this.mode === "reject") {
      throw new UnauthorizedException("Unauthorized");
    }
    const request = ctx.switchToHttp().getRequest();
    request.principal = this.principal;
    return true;
  }
}

class ScriptedTenantContextGuard implements CanActivate {
  public mode: "ok" | "no-tenant" = "ok";
  public context: ResolvedContext = {
    userId: "user-1",
    tenantId: TENANT_A,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
  };

  canActivate(ctx: ExecutionContext): boolean {
    if (this.mode === "no-tenant") {
      throw new UnauthorizedException("Unauthorized");
    }
    const request = ctx.switchToHttp().getRequest();
    request.context = this.context;
    return true;
  }
}

class ScriptedRolesGuard implements CanActivate {
  public mode: "ok" | "forbid" = "ok";
  canActivate(_ctx: ExecutionContext): boolean {
    if (this.mode === "forbid") {
      throw new ForbiddenException("Insufficient role.");
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let app: INestApplication;
let auditService: FakeAuditService;
let auth: ScriptedAuthGuard;
let tenant: ScriptedTenantContextGuard;
let roles: ScriptedRolesGuard;

beforeAll(async () => {
  auditService = new FakeAuditService();
  auth = new ScriptedAuthGuard();
  tenant = new ScriptedTenantContextGuard();
  roles = new ScriptedRolesGuard();

  const moduleRef = await Test.createTestingModule({
    controllers: [AuditController],
    providers: [
      { provide: AuditService, useValue: auditService },
      { provide: DashboardAuthGuard, useValue: auth },
      { provide: TenantContextGuard, useValue: tenant },
      { provide: RolesGuard, useValue: roles },
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue(auth)
    .overrideGuard(TenantContextGuard)
    .useValue(tenant)
    .overrideGuard(RolesGuard)
    .useValue(roles)
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
  auth.mode = "ok";
  tenant.mode = "ok";
  roles.mode = "ok";
  tenant.context = {
    userId: "user-1",
    tenantId: TENANT_A,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
  };
  auditService.lastInput = null;
  auditService.toReturn = { items: [], next_cursor: null };
});

function http() {
  return request(app.getHttpServer());
}

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
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/audit/events — happy path", () => {
  it("returns 200 with the OpenAPI ListAuditEventsResponse shape", async () => {
    auditService.toReturn = {
      items: [
        {
          id: ROW_ID,
          occurred_at: "2026-05-01T12:00:00.000Z",
          actor_user_id: ACTOR,
          actor_label: null,
          tenant_id: TENANT_A,
          store_id: null,
          action: "auth.signin.ok",
          kind: "change",
          target_type: null,
          target_id: null,
          request_id: null,
          metadata: { ip: "1.2.3.4" },
        },
      ],
      next_cursor: null,
    };

    const res = await http().get("/api/v1/audit/events");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [
        {
          id: ROW_ID,
          occurred_at: "2026-05-01T12:00:00.000Z",
          actor_user_id: ACTOR,
          actor_label: null,
          tenant_id: TENANT_A,
          store_id: null,
          action: "auth.signin.ok",
          kind: "change",
          target_type: null,
          target_id: null,
          request_id: null,
          metadata: { ip: "1.2.3.4" },
        },
      ],
      next_cursor: null,
    });
  });

  it("forwards tenant_id from the resolved context (NOT from a query param)", async () => {
    await http().get("/api/v1/audit/events");
    const input = auditService.lastInput as { tenantId: string; isPlatformAdmin: boolean };
    expect(input.tenantId).toBe(TENANT_A);
    expect(input.isPlatformAdmin).toBe(false);
  });

  it("forwards parsed query filters (action prefix / actor / store / from / to / limit)", async () => {
    const cursor = encodeCursor(new Date("2026-05-01T10:00:00Z"), ROW_ID);
    await http()
      .get("/api/v1/audit/events")
      .query({
        action: "auth.",
        actor_user_id: ACTOR,
        store_id: "0a000000-0000-7000-8000-0000000000c1",
        from: "2026-05-01T00:00:00Z",
        to: "2026-05-31T23:59:59Z",
        cursor,
        limit: "100",
      });

    const input = auditService.lastInput as Record<string, unknown>;
    expect(input["action"]).toBe("auth.");
    expect(input["actor_user_id"]).toBe(ACTOR);
    expect(input["store_id"]).toBe("0a000000-0000-7000-8000-0000000000c1");
    expect(input["from"]).toBeInstanceOf(Date);
    expect(input["to"]).toBeInstanceOf(Date);
    expect(input["limit"]).toBe(100);
    expect(input["cursor"]).toBeDefined();
  });
});

describe("guard rejections", () => {
  it("returns 401 when AuthGuard rejects", async () => {
    auth.mode = "reject";
    const res = await http().get("/api/v1/audit/events");
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 401 when TenantContextGuard rejects (no active tenant)", async () => {
    tenant.mode = "no-tenant";
    const res = await http().get("/api/v1/audit/events");
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 403 when RolesGuard rejects (insufficient role)", async () => {
    roles.mode = "forbid";
    const res = await http().get("/api/v1/audit/events");
    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, "forbidden");
  });

  it("never reaches the service when any guard rejects", async () => {
    auth.mode = "reject";
    await http().get("/api/v1/audit/events");
    expect(auditService.lastInput).toBeNull();
  });
});

describe("query validation", () => {
  it("returns 400 for limit=0", async () => {
    const res = await http().get("/api/v1/audit/events").query({ limit: "0" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
  });

  it("returns 400 for limit=201", async () => {
    const res = await http().get("/api/v1/audit/events").query({ limit: "201" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
  });

  it("returns 400 for non-UUID actor_user_id", async () => {
    const res = await http()
      .get("/api/v1/audit/events")
      .query({ actor_user_id: "not-a-uuid" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
  });

  it("returns 400 for non-UUID store_id", async () => {
    const res = await http()
      .get("/api/v1/audit/events")
      .query({ store_id: "abc" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
  });

  it("returns 400 for malformed from", async () => {
    const res = await http()
      .get("/api/v1/audit/events")
      .query({ from: "yesterday" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
  });

  it("returns 400 for malformed cursor", async () => {
    const res = await http()
      .get("/api/v1/audit/events")
      .query({ cursor: "$$bad-cursor$$" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
  });
});

describe("audit recursion guard", () => {
  it("listAuditEvents handler does NOT carry @Auditable metadata", () => {
    const reflector = new Reflector();
    const meta = reflector.get(
      AUDITABLE_KEY,
      AuditController.prototype.listAuditEvents,
    );
    expect(meta).toBeUndefined();
  });
});
