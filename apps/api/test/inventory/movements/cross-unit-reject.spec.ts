/**
 * cross-unit-reject.spec.ts — 009-US2-MANUAL (T043, RED).
 *
 * FR-022: a movement whose `stockingUnit` ≠ the product's ESTABLISHED stocking
 * unit → 400, no record, no coercion. There is no `stocking_unit` column on
 * `tenant_products` (catalog is name + tax_category only), so a product's unit
 * is the one its EXISTING movements were recorded in — the first movement for a
 * product establishes the unit; a later movement in a different unit is the
 * rejection FR-022 describes.
 *
 * Layer: HTTP/controller, Docker-FREE — a FakeInventoryService stands in for
 * the DB. The cross-unit decision is the SERVICE's (it must read the product's
 * established unit), so the fake raises the same typed error the real service
 * will, and we prove the CONTROLLER surfaces it as a 400 (not 500, not a
 * silent coerce). The DB-backed proof that no row is written lives in the
 * Docker-gated `inbound-outbound-adjust.spec.ts`.
 *
 * This is RED until 009-US2-MANUAL's T044 adds the POST route + service method.
 */
import 'reflect-metadata';

import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { DashboardAuthGuard } from '../../../src/auth/dashboard-auth.guard';
import { GlobalExceptionFilter } from '../../../src/common/exception.filter';
import { TenantContextGuard } from '../../../src/context/tenant-context.guard';
import type { ResolvedContext } from '../../../src/context/types';
import { MembershipRepository } from '../../../src/context/membership.repository';
import { InventoryController } from '../../../src/inventory/inventory.controller';
import { CrossUnitError, InventoryService } from '../../../src/inventory/inventory.service';

const TENANT_A = '0a000000-0000-7000-8000-00000000ada1';
const STORE_A_X = '0a000000-0000-7000-8000-00000000a5a1';
const PRODUCT = '0a000000-0000-7000-8000-00000000a401';
const USER_A = '0a000000-0000-7000-8000-0000000000ac';

/**
 * Fake service — no DB. Mimics the real cross-unit rule: a `createStockMovement`
 * for PRODUCT whose stockingUnit ≠ the product's established unit ("ea") throws
 * the typed `CrossUnitError`; the controller must map it to a 400.
 */
class FakeInventoryService {
  public createCalls = 0;
  async createStockMovement(input: {
    stockingUnit: string;
    tenantProductRef?: string | null;
  }): Promise<never | { id: string }> {
    this.createCalls += 1;
    if (input.tenantProductRef === PRODUCT && input.stockingUnit !== 'ea') {
      throw new CrossUnitError('ea', input.stockingUnit);
    }
    return { id: 'unused' };
  }
}

class ConfigurableContextGuard implements CanActivate {
  public context: ResolvedContext | null = null;
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext }>();
    if (this.context) req.context = this.context;
    return true;
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

function tenantLevelCtx(): ResolvedContext {
  return {
    userId: USER_A,
    tenantId: TENANT_A,
    storeId: null,
    isPlatformAdmin: false,
    source: 'session',
  };
}

describe('createStockMovement — cross-unit reject (FR-022)', () => {
  it("a stockingUnit ≠ the product's established unit → 400", async () => {
    contextGuard.context = tenantLevelCtx();
    await http()
      .post(`/api/inventory/v1/stores/${STORE_A_X}/movements`)
      .send({
        movementType: 'inbound',
        quantity: '5.0000',
        stockingUnit: 'case', // product is established in "ea"
        tenantProductRef: PRODUCT,
      })
      .expect(400);
  });

  it("the matching stockingUnit ('ea') is accepted (201/2xx), proving the 400 is the unit, not the route", async () => {
    contextGuard.context = tenantLevelCtx();
    await http()
      .post(`/api/inventory/v1/stores/${STORE_A_X}/movements`)
      .send({
        movementType: 'inbound',
        quantity: '5.0000',
        stockingUnit: 'ea',
        tenantProductRef: PRODUCT,
      })
      .expect((res) => {
        if (res.status >= 400) {
          throw new Error(`expected success, got ${res.status}`);
        }
      });
  });
});
