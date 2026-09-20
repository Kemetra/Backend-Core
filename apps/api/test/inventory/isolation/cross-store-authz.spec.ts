/**
 * cross-store-authz.spec.ts — object-level STORE authorization (§XII, §II).
 *
 * The cross-STORE half of the isolation contract. `inventory-sweep.spec.ts`
 * covers cross-TENANT isolation exhaustively (§A.1–A.4: wrong-tenant GUC,
 * RLS-bypass probe, fail-closed unset GUC) — all at the DATABASE layer, where
 * RLS enforces it. This file covers what RLS does NOT enforce.
 *
 * Why the distinction matters (and why the gap existed):
 * the RLS policies on `stock_movements` scope by `tenant_id` ONLY — there is no
 * store predicate (`packages/db/drizzle/0014_inventory.sql`). Store-level
 * separation is therefore enforced EXCLUSIVELY in application code, so a
 * defect in `InventoryController.authorizeStore` has no database backstop.
 * Coverage organized around the enforcement mechanism (RLS) could never have
 * caught it.
 *
 * The defect under test: `authorizeStore` treated `ctx.storeId === null` as
 * "tenant-wide principal, may address any store". But `sessions.active_store_id`
 * is NULL BY DEFAULT — `signIn` never sets it and `switchTenant` explicitly
 * nulls it — so a `store_access.kind = 'specific'` member reached every store
 * in the tenant, for READ and for WRITE, on the mandatory happy path.
 *
 * Correct behaviour: the membership's real store-access policy is consulted via
 * `MembershipRepository.canAccessStore` (the pattern already used by
 * `StoresService.read`). A store outside the caller's grant is a NON-DISCLOSING
 * 404 (FR-051) — never 403, which would leak existence.
 *
 * Docker-FREE — controller + guards + fake service/repository.
 */
import 'reflect-metadata';

import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { DashboardAuthGuard } from '../../../src/auth/dashboard-auth.guard';
import { GlobalExceptionFilter } from '../../../src/common/exception.filter';
import { MembershipRepository } from '../../../src/context/membership.repository';
import { TenantContextGuard } from '../../../src/context/tenant-context.guard';
import type { ResolvedContext } from '../../../src/context/types';
import { InventoryController } from '../../../src/inventory/inventory.controller';
import { InventoryService } from '../../../src/inventory/inventory.service';

const TENANT_A = '0a000000-0000-7000-8000-00000000ada1';
const STORE_GRANTED = '0a000000-0000-7000-8000-00000000a5a1';
const STORE_FOREIGN = '0a000000-0000-7000-8000-00000000b5b2';
const USER_A = '0a000000-0000-7000-8000-0000000000ac';
const MEMBERSHIP_A = '0a000000-0000-7000-8000-0000000000e1';
const PRODUCT_REF = '0a000000-0000-7000-8000-0000000000f1';

/**
 * Records whether the service was reached at all. If authorization works, a
 * request for a foreign store must be rejected BEFORE the service runs — so
 * `touched` staying false is the real assertion behind each 404.
 */
class FakeInventoryService {
  public touched = false;

  async getOnHand(): Promise<unknown> {
    this.touched = true;
    return { storeId: STORE_FOREIGN, tenantProductRef: PRODUCT_REF, onHand: '0.0000' };
  }
  async listStockMovements(): Promise<unknown> {
    this.touched = true;
    return { items: [], nextCursor: null };
  }
  async createStockMovement(): Promise<unknown> {
    this.touched = true;
    return { id: '0a000000-0000-7000-8000-00000000d0d1', storeId: STORE_FOREIGN };
  }
  async createStockTransfer(): Promise<unknown> {
    this.touched = true;
    return { id: '0a000000-0000-7000-8000-00000000d0d2' };
  }
  async recordStockCount(): Promise<unknown> {
    this.touched = true;
    return { id: '0a000000-0000-7000-8000-00000000d0d3' };
  }
}

/**
 * Mirrors the real repository's contract: `canAccessStore` returns false for a
 * store the membership has no grant for. Here the member is `kind: 'specific'`
 * with a grant to STORE_GRANTED only.
 */
class FakeMembershipRepository {
  public canAccessStoreCalls: string[] = [];

  async findActiveMembership(): Promise<{ membershipId: string; storeAccessKind: string } | null> {
    return { membershipId: MEMBERSHIP_A, storeAccessKind: 'specific' };
  }

  async canAccessStore(
    _membershipId: string,
    _tenantId: string,
    storeId: string,
  ): Promise<boolean> {
    this.canAccessStoreCalls.push(storeId);
    return storeId === STORE_GRANTED;
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

let app: INestApplication;
let fake: FakeInventoryService;
let memberships: FakeMembershipRepository;
let contextGuard: ConfigurableContextGuard;

beforeAll(async () => {
  fake = new FakeInventoryService();
  memberships = new FakeMembershipRepository();
  contextGuard = new ConfigurableContextGuard();

  const moduleRef = await Test.createTestingModule({
    controllers: [InventoryController],
    providers: [
      { provide: InventoryService, useValue: fake },
      { provide: MembershipRepository, useValue: memberships },
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

beforeEach(() => {
  fake.touched = false;
  memberships.canAccessStoreCalls = [];
});

function http() {
  return request(app.getHttpServer());
}

/**
 * The exact context produced by the mandatory happy path:
 *   signIn (active_store_id NULL) → switchTenant (explicitly nulls it).
 * A null `storeId` is the DEFAULT state, NOT a proof of tenant-wide authority.
 */
function nullStoreCtx(): ResolvedContext {
  return {
    userId: USER_A,
    tenantId: TENANT_A,
    storeId: null,
    isPlatformAdmin: false,
    source: 'session',
  };
}

function platformAdminCtx(): ResolvedContext {
  return {
    userId: USER_A,
    tenantId: TENANT_A,
    storeId: null,
    isPlatformAdmin: true,
    source: 'session',
  };
}

describe('inventory cross-store authorization — null active_store_id must not grant every store (§XII)', () => {
  it('GET on-hand for a non-granted store is a non-disclosing 404', async () => {
    contextGuard.context = nullStoreCtx();
    await http()
      .get(`/api/inventory/v1/on-hand/${STORE_FOREIGN}/${PRODUCT_REF}`)
      .expect(404);
    expect(fake.touched).toBe(false);
  });

  it('GET movements for a non-granted store is a non-disclosing 404', async () => {
    contextGuard.context = nullStoreCtx();
    await http()
      .get(`/api/inventory/v1/stores/${STORE_FOREIGN}/movements`)
      .expect(404);
    expect(fake.touched).toBe(false);
  });

  it('POST movement to a non-granted store is a non-disclosing 404 (WRITE path)', async () => {
    contextGuard.context = nullStoreCtx();
    await http()
      .post(`/api/inventory/v1/stores/${STORE_FOREIGN}/movements`)
      .set('Idempotency-Key', 'cross-store-authz-movement-0001')
      .send({
        movementType: 'inbound',
        quantity: '5.0000',
        stockingUnit: 'ea',
        tenantProductRef: PRODUCT_REF,
      })
      .expect(404);
    expect(fake.touched).toBe(false);
  });

  it('POST count to a non-granted store is a non-disclosing 404 (WRITE path)', async () => {
    contextGuard.context = nullStoreCtx();
    await http()
      .post(`/api/inventory/v1/stores/${STORE_FOREIGN}/counts`)
      .set('Idempotency-Key', 'cross-store-authz-count-0001')
      .send({
        tenantProductRef: PRODUCT_REF,
        countedQuantity: '5.0000',
        stockingUnit: 'ea',
      })
      .expect(404);
    expect(fake.touched).toBe(false);
  });

  it('POST transfer FROM a non-granted source store is a non-disclosing 404 (WRITE path)', async () => {
    contextGuard.context = nullStoreCtx();
    await http()
      .post('/api/inventory/v1/transfers')
      .set('Idempotency-Key', 'cross-store-authz-transfer-0001')
      .send({
        sourceStoreId: STORE_FOREIGN,
        destinationStoreId: STORE_GRANTED,
        tenantProductRef: PRODUCT_REF,
        quantity: '5.0000',
        stockingUnit: 'ea',
      })
      .expect(404);
    expect(fake.touched).toBe(false);
  });

  it('the granted store still works — the fix must not deny legitimate access', async () => {
    contextGuard.context = nullStoreCtx();
    await http()
      .get(`/api/inventory/v1/on-hand/${STORE_GRANTED}/${PRODUCT_REF}`)
      .expect(200);
    expect(fake.touched).toBe(true);
    expect(memberships.canAccessStoreCalls).toContain(STORE_GRANTED);
  });

  it('a platform admin bypasses the store-access check (parity with StoresService.read)', async () => {
    contextGuard.context = platformAdminCtx();
    await http()
      .get(`/api/inventory/v1/on-hand/${STORE_FOREIGN}/${PRODUCT_REF}`)
      .expect(200);
    expect(fake.touched).toBe(true);
    expect(memberships.canAccessStoreCalls).toHaveLength(0);
  });
});

describe('inventory cross-store authorization — a store-scoped principal keeps its existing guard', () => {
  it('a principal bound to one store cannot address another (pre-existing behaviour, regression guard)', async () => {
    contextGuard.context = {
      userId: USER_A,
      tenantId: TENANT_A,
      storeId: STORE_GRANTED,
      isPlatformAdmin: false,
      source: 'session',
    };
    await http()
      .get(`/api/inventory/v1/on-hand/${STORE_FOREIGN}/${PRODUCT_REF}`)
      .expect(404);
    expect(fake.touched).toBe(false);
  });
});
