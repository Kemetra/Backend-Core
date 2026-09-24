/**
 * read-object-safety.spec.ts — 009-US1-ONHAND (T034, HTTP object-safety).
 *
 * The READ-path object-safety half of T034, at the HTTP/controller layer
 * (Docker-FREE — a FakeInventoryService stands in for the DB, so this proves
 * the CONTROLLER's authz/response logic, not the SUM). The RLS-bypass probe +
 * seeded cross-tenant invisibility (the DB-layer half of T034) live in
 * `inventory/isolation/inventory-sweep.spec.ts` GROUP A (Docker-gated).
 *
 * The 404-vs-0 reconciliation (important — these are AGGREGATE reads):
 *   - cross-STORE (a store-scoped principal requesting a different store) →
 *     404 (authorizeStore throws; non-disclosing, FR-051).
 *   - cross-TENANT on-hand → 200 with "0", and cross-tenant list → 200 empty.
 *     RLS filters the other tenant's rows to nothing, and an empty key is "0"
 *     by FR-005 — a 404 here would CONTRADICT FR-005 and is wrong. Non-
 *     disclosure is achieved via emptiness, not an error. (The DB-layer proof
 *     that the rows are truly invisible is the sweep's GROUP A.)
 *   - unauthenticated / no resolved context → 401.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { DashboardAuthGuard } from "../../../src/auth/dashboard-auth.guard";
import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { TenantContextGuard } from "../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../src/context/types";
import { MembershipRepository } from '../../../src/context/membership.repository';
import { InventoryController } from "../../../src/inventory/inventory.controller";
import {
  InventoryService,
  type OnHandBody,
  type StockMovementListBody,
} from "../../../src/inventory/inventory.service";

const TENANT_A = "0a000000-0000-7000-8000-00000000ada1";
const STORE_A_X = "0a000000-0000-7000-8000-00000000a5a1";
const STORE_A_Y = "0a000000-0000-7000-8000-00000000a5a2";
const PRODUCT = "0a000000-0000-7000-8000-00000000a401";
const USER_A = "0a000000-0000-7000-8000-0000000000ac";

/** Fake service — no DB; records the (tenantId, storeId) it was called with. */
class FakeInventoryService {
  public lastOnHandArgs: { tenantId: string; storeId: string } | null = null;
  async getOnHand(input: {
    tenantId: string;
    storeId: string;
    productId: string;
  }): Promise<OnHandBody> {
    this.lastOnHandArgs = { tenantId: input.tenantId, storeId: input.storeId };
    // Mimics the real service for a key with no visible rows: "0.0000"
    // (uniform numeric(19,4) wire format).
    return {
      storeId: input.storeId,
      productId: input.productId,
      quantity: "0.0000",
      stockingUnit: null,
      negativeBalance: false,
    };
  }
  async listStockMovements(): Promise<StockMovementListBody> {
    return { items: [], nextCursor: null };
  }
}

/** Configurable context guard — sets request.context, or 401 when disabled. */
class ConfigurableContextGuard implements CanActivate {
  public context: ResolvedContext | null = null;
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx
      .switchToHttp()
      .getRequest<{ context?: ResolvedContext }>();
    if (this.context) req.context = this.context;
    return true; // auth always passes; missing context → controller throws 401
  }
}
class PassAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

/**
 * Store-access is not what these tests exercise — they cover the boundary
 * concern named in this file's header. `InventoryController` now resolves the
 * membership's store-access policy server-side (§XII, #606), so it needs a
 * MembershipRepository. This stub grants every store, keeping the subject of
 * these tests unchanged. Cross-store DENIAL is covered in
 * `test/inventory/isolation/cross-store-authz.spec.ts`.
 */
class AllowAllMembershipRepository {
  async findActiveMembership(): Promise<{ membershipId: string; storeAccessKind: string }> {
    return { membershipId: '0a000000-0000-7000-8000-0000000000e1', storeAccessKind: 'all' };
  }
  async canAccessStore(): Promise<boolean> {
    return true;
  }
}

let app: INestApplication;
let fake: FakeInventoryService;
let contextGuard: ConfigurableContextGuard;

beforeAll(async () => {
  fake = new FakeInventoryService();
  contextGuard = new ConfigurableContextGuard();

  const moduleRef = await Test.createTestingModule({
    controllers: [InventoryController],
    providers: [
      { provide: InventoryService, useValue: fake },
      { provide: MembershipRepository, useValue: new AllowAllMembershipRepository() },
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue(new PassAuthGuard())
    .overrideGuard(TenantContextGuard)
    .useValue(contextGuard)
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

function http() {
  return request(app.getHttpServer());
}

/** A tenant-level principal (storeId null → may address any store in tenant). */
function tenantLevelCtx(): ResolvedContext {
  return {
    userId: USER_A,
    tenantId: TENANT_A,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
  };
}
/** A store-scoped principal (storeId set → only its own store). */
function storeScopedCtx(storeId: string): ResolvedContext {
  return {
    userId: USER_A,
    tenantId: TENANT_A,
    storeId,
    isPlatformAdmin: false,
    source: "session",
  };
}

describe("read object-safety — authentication", () => {
  it("no resolved context → 401", async () => {
    contextGuard.context = null;
    await http()
      .get(`/api/inventory/v1/on-hand/${STORE_A_X}/${PRODUCT}`)
      .expect(401);
  });
});

describe("read object-safety — cross-store (scoped principal) → 404 (non-disclosing)", () => {
  it("a STORE_A_X-scoped principal requesting STORE_A_Y on-hand → 404", async () => {
    contextGuard.context = storeScopedCtx(STORE_A_X);
    await http()
      .get(`/api/inventory/v1/on-hand/${STORE_A_Y}/${PRODUCT}`)
      .expect(404);
  });

  it("a STORE_A_X-scoped principal requesting STORE_A_Y movements → 404", async () => {
    contextGuard.context = storeScopedCtx(STORE_A_X);
    await http()
      .get(`/api/inventory/v1/stores/${STORE_A_Y}/movements`)
      .expect(404);
  });

  it("a STORE_A_X-scoped principal requesting its OWN store → 200", async () => {
    contextGuard.context = storeScopedCtx(STORE_A_X);
    await http()
      .get(`/api/inventory/v1/on-hand/${STORE_A_X}/${PRODUCT}`)
      .expect(200);
  });
});

describe("read object-safety — cross-tenant on-hand → 200/'0' (non-disclosing via emptiness, NOT 404)", () => {
  it("a tenant-level principal reading any store → 200; tenant resolves from context, never path", async () => {
    contextGuard.context = tenantLevelCtx();
    const res = await http()
      .get(`/api/inventory/v1/on-hand/${STORE_A_X}/${PRODUCT}`)
      .expect(200);
    // On-hand for a key the tenant can't see is "0" (FR-005) — a 404 would
    // contradict FR-005. The service is called with the CONTEXT tenant.
    expect(res.body.quantity).toBe("0.0000");
    expect(fake.lastOnHandArgs?.tenantId).toBe(TENANT_A);
  });
});
