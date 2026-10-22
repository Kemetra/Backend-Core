/**
 * T152 — ContextController spec.
 *
 * Pure unit-level. We instantiate `ContextController` directly with a
 * fake `ContextService`, exercise each route, and assert:
 *   - the right service method is invoked with the right args,
 *   - DTO validation pinning (the service spec covers business logic),
 *   - error → HTTP shape comes from the service (controller is thin),
 *   - `@UseGuards(DashboardAuthGuard)` is applied at the class level so
 *     unauthenticated requests are rejected by the guard upstream.
 *
 * This complements `context.service.spec.ts` which owns the meat —
 * auto-clear semantics, FR-ISO-4 404s, 409 / 400 / 401 mapping.
 */
import "reflect-metadata";
import {
  GUARDS_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import {
  BadRequestException,
  UnauthorizedException,
} from "@nestjs/common";
import type { AuthedRequest, Principal } from "../../src/auth/auth.guard";
import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";
import { ContextController } from "../../src/context/context.controller";
import {
  type ContextResponseBody,
  ContextService,
} from "../../src/context/context.service";
import {
  SwitchStoreSchema,
  SwitchTenantSchema,
} from "../../src/context/dto";

// Real UUIDv7-shaped values — the Zod schemas validate format, so
// the placeholder-style "ten01" / "sto01" fixtures used in the
// service spec wouldn't survive `z.string().uuid()`.
const USER_ID = "0a000000-0000-7000-8000-00000000aa01";
const TENANT_ID = "0a000000-0000-7000-8000-0000000a1001";
const STORE_ID = "0a000000-0000-7000-8000-0000000c5001";
const SESSION_ID = "0a000000-0000-7000-8000-0000000bf501";

const SAMPLE_RESPONSE: ContextResponseBody = {
  user: {
    id: USER_ID,
    email: "alice@example.com",
    display_name: "Alice",
    is_platform_admin: false,
  },
  active_tenant: { id: TENANT_ID, slug: "acme", name: "Acme" },
  active_store: null,
  active_role_code: "tenant_admin",
  memberships: [],
  support_session: null,
};

class FakeContextService {
  getActiveContextResult: ContextResponseBody = SAMPLE_RESPONSE;
  switchTenantResult: ContextResponseBody = SAMPLE_RESPONSE;
  switchStoreResult: ContextResponseBody = SAMPLE_RESPONSE;
  clearStoreResult: ContextResponseBody = SAMPLE_RESPONSE;

  getActiveContextCalls: Principal[] = [];
  switchTenantCalls: Array<{ principal: Principal; tenantId: string }> = [];
  switchStoreCalls: Array<{ principal: Principal; storeId: string }> = [];
  clearStoreCalls: Principal[] = [];

  rejectWith?: Error;

  async getActiveContext(p: Principal): Promise<ContextResponseBody> {
    this.getActiveContextCalls.push(p);
    if (this.rejectWith) throw this.rejectWith;
    return this.getActiveContextResult;
  }
  async switchTenant(
    p: Principal,
    tenantId: string,
  ): Promise<ContextResponseBody> {
    this.switchTenantCalls.push({ principal: p, tenantId });
    if (this.rejectWith) throw this.rejectWith;
    return this.switchTenantResult;
  }
  async switchStore(
    p: Principal,
    storeId: string,
  ): Promise<ContextResponseBody> {
    this.switchStoreCalls.push({ principal: p, storeId });
    if (this.rejectWith) throw this.rejectWith;
    return this.switchStoreResult;
  }
  async clearStore(p: Principal): Promise<ContextResponseBody> {
    this.clearStoreCalls.push(p);
    if (this.rejectWith) throw this.rejectWith;
    return this.clearStoreResult;
  }
}

const SESSION_PRINCIPAL: Principal = {
  kind: "session",
  sessionId: SESSION_ID,
  userId: USER_ID,
};

function makeRequest(principal?: Principal): AuthedRequest {
  const r: Partial<AuthedRequest> = {};
  if (principal) r.principal = principal;
  return r as AuthedRequest;
}

let service: FakeContextService;
let controller: ContextController;

beforeEach(() => {
  service = new FakeContextService();
  controller = new ContextController(service as unknown as ContextService);
});

// --- Class-level guard pin -------------------------------------------

describe("ContextController — wiring", () => {
  it("applies DashboardAuthGuard at the class level so unauthenticated requests are blocked upstream", () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ContextController,
    ) as unknown[];
    expect(guards).toBeDefined();
    expect(guards).toContain(DashboardAuthGuard);
  });

  it("is mounted at /api/v1/context", () => {
    const path = Reflect.getMetadata(
      PATH_METADATA,
      ContextController,
    ) as string;
    expect(path).toBe("api/v1/context");
  });
});

// --- GET /me ----------------------------------------------------------

describe("ContextController.me — GET /api/v1/context/me", () => {
  it("returns the service result for an authenticated principal", async () => {
    const out = await controller.me(makeRequest(SESSION_PRINCIPAL));
    expect(out).toBe(SAMPLE_RESPONSE);
    expect(service.getActiveContextCalls).toEqual([SESSION_PRINCIPAL]);
  });

  it("throws 401 when the request has no principal (defensive — AuthGuard would normally have rejected)", async () => {
    await expect(controller.me(makeRequest(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("propagates service errors verbatim (e.g., 401 from a TOCTOU revoked session)", async () => {
    service.rejectWith = new UnauthorizedException("boom");
    await expect(
      controller.me(makeRequest(SESSION_PRINCIPAL)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// --- POST /tenant -----------------------------------------------------

describe("ContextController.switchTenant — POST /api/v1/context/tenant", () => {
  it("forwards (principal, tenant_id) to ContextService.switchTenant", async () => {
    const out = await controller.switchTenant(
      makeRequest(SESSION_PRINCIPAL),
      { tenant_id: TENANT_ID },
    );
    expect(out).toBe(SAMPLE_RESPONSE);
    expect(service.switchTenantCalls).toEqual([
      { principal: SESSION_PRINCIPAL, tenantId: TENANT_ID },
    ]);
  });

  it("throws 401 when no principal is present", async () => {
    await expect(
      controller.switchTenant(makeRequest(undefined), {
        tenant_id: TENANT_ID,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe("ContextController — SwitchTenantSchema validation", () => {
  it("accepts a valid UUID body", () => {
    const result = SwitchTenantSchema.safeParse({ tenant_id: TENANT_ID });
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID tenant_id", () => {
    const result = SwitchTenantSchema.safeParse({ tenant_id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects extra unknown fields (strict)", () => {
    const result = SwitchTenantSchema.safeParse({
      tenant_id: TENANT_ID,
      malicious: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty body", () => {
    const result = SwitchTenantSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// --- POST /store ------------------------------------------------------

describe("ContextController.switchStore — POST /api/v1/context/store", () => {
  it("forwards (principal, store_id) to ContextService.switchStore", async () => {
    const out = await controller.switchStore(
      makeRequest(SESSION_PRINCIPAL),
      { store_id: STORE_ID },
    );
    expect(out).toBe(SAMPLE_RESPONSE);
    expect(service.switchStoreCalls).toEqual([
      { principal: SESSION_PRINCIPAL, storeId: STORE_ID },
    ]);
  });

  it("throws 401 when no principal is present", async () => {
    await expect(
      controller.switchStore(makeRequest(undefined), { store_id: STORE_ID }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("propagates BadRequestException from the service for token principals", async () => {
    service.rejectWith = new BadRequestException("Tokens cannot switch context.");
    await expect(
      controller.switchStore(makeRequest(SESSION_PRINCIPAL), {
        store_id: STORE_ID,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("ContextController — SwitchStoreSchema validation", () => {
  it("accepts a valid UUID body", () => {
    const result = SwitchStoreSchema.safeParse({ store_id: STORE_ID });
    expect(result.success).toBe(true);
  });
  it("rejects a non-UUID store_id", () => {
    const result = SwitchStoreSchema.safeParse({ store_id: "x" });
    expect(result.success).toBe(false);
  });
  it("rejects extra unknown fields", () => {
    const result = SwitchStoreSchema.safeParse({
      store_id: STORE_ID,
      extra: 1,
    });
    expect(result.success).toBe(false);
  });
});

// --- DELETE /store ----------------------------------------------------

describe("ContextController.clearStore — DELETE /api/v1/context/store", () => {
  it("forwards the principal to ContextService.clearStore", async () => {
    const out = await controller.clearStore(makeRequest(SESSION_PRINCIPAL));
    expect(out).toBe(SAMPLE_RESPONSE);
    expect(service.clearStoreCalls).toEqual([SESSION_PRINCIPAL]);
  });

  it("throws 401 when no principal is present", async () => {
    await expect(
      controller.clearStore(makeRequest(undefined)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
