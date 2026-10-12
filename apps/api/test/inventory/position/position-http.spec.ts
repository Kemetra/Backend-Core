/**
 * position-http.spec.ts — Jira RT-432 (inventory position grain), HTTP layer.
 *
 * The controller boundary for the RT-290 Gate 4 additions, against a fake
 * service (no DB):
 *   - POST movements accepts an optional `stockLocationId` (uuid) and
 *     `inventoryStatus` (the closed enum) and forwards them; a non-uuid
 *     location, an unknown status, or a tracking field is a 400 (`.strict()`);
 *     omitting both forwards nulls (the service defaults them);
 *   - GET locations is store-authorized like the other store-scoped reads: a
 *     store outside a store-bound principal's scope is a non-disclosing 404.
 */
import 'reflect-metadata';

import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { DashboardAuthGuard } from '../../../src/auth/dashboard-auth.guard';
import { GlobalExceptionFilter } from '../../../src/common/exception.filter';
import { TenantContextGuard } from '../../../src/context/tenant-context.guard';
import type { ResolvedContext } from '../../../src/context/types';
import { InventoryController } from '../../../src/inventory/inventory.controller';
import {
  InventoryService,
  type StockLocationListBody,
} from '../../../src/inventory/inventory.service';

const TENANT_A = '0a000000-0000-7000-8000-00000000ada1';
const STORE_A_X = '0a000000-0000-7000-8000-00000000a5a1';
const STORE_A_Y = '0a000000-0000-7000-8000-00000000a5a2';
const USER_A = '0a000000-0000-7000-8000-0000000000ac';
const LOCATION = '0a000000-0000-7000-8000-005704a4a0b1';

class FakeInventoryService {
  public lastCreate: Record<string, unknown> | null = null;
  public lastLocations: { tenantId: string; storeId: string } | null = null;
  async createStockMovement(input: Record<string, unknown>): Promise<{ id: string }> {
    this.lastCreate = input;
    return { id: '0a000000-0000-7000-8000-00000000d0d1' };
  }
  async listStockLocations(input: { tenantId: string; storeId: string }): Promise<StockLocationListBody> {
    this.lastLocations = input;
    return {
      items: [
        { id: LOCATION, storeId: input.storeId, code: 'PRIMARY', name: 'Primary', kind: 'primary', isActive: true },
      ],
    };
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
let contextGuard: ConfigurableContextGuard;

beforeAll(async () => {
  fake = new FakeInventoryService();
  contextGuard = new ConfigurableContextGuard();
  const moduleRef = await Test.createTestingModule({
    controllers: [InventoryController],
    providers: [{ provide: InventoryService, useValue: fake }],
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
  fake.lastCreate = null;
  fake.lastLocations = null;
});

function tenantLevelCtx(): ResolvedContext {
  return {
    userId: USER_A,
    tenantId: TENANT_A,
    storeId: null,
    isPlatformAdmin: false,
    source: 'session',
    storeAccess: { kind: 'all' },
  };
}

const base = { movementType: 'inbound', quantity: '1.0000', stockingUnit: 'ea' };

describe('RT-432 — POST movements: optional position fields', () => {
  it('forwards an explicit stockLocationId and inventoryStatus', async () => {
    contextGuard.context = tenantLevelCtx();
    await request(app.getHttpServer())
      .post(`/api/inventory/v1/stores/${STORE_A_X}/movements`)
      .send({ ...base, stockLocationId: LOCATION, inventoryStatus: 'quality_hold' })
      .expect(201);
    expect(fake.lastCreate).toMatchObject({
      storeId: STORE_A_X,
      stockLocationId: LOCATION,
      inventoryStatus: 'quality_hold',
    });
  });

  it('forwards nulls when both are omitted (the service defaults them)', async () => {
    contextGuard.context = tenantLevelCtx();
    await request(app.getHttpServer())
      .post(`/api/inventory/v1/stores/${STORE_A_X}/movements`)
      .send(base)
      .expect(201);
    expect(fake.lastCreate).toMatchObject({ stockLocationId: null, inventoryStatus: null });
  });

  it.each([
    ['an unknown status', { inventoryStatus: 'on_shelf' }],
    ['a non-uuid location', { stockLocationId: 'backroom' }],
    ['a tracking identity (Gate 7, not accepted)', { trackingIdentity: 'LOT-1' }],
  ])('rejects %s with 400 and never reaches the service', async (_label, extra) => {
    contextGuard.context = tenantLevelCtx();
    await request(app.getHttpServer())
      .post(`/api/inventory/v1/stores/${STORE_A_X}/movements`)
      .send({ ...base, ...extra })
      .expect(400);
    expect(fake.lastCreate).toBeNull();
  });
});

describe('RT-432 — GET locations', () => {
  it('returns the store locations for an in-scope store', async () => {
    contextGuard.context = tenantLevelCtx();
    const res = await request(app.getHttpServer())
      .get(`/api/inventory/v1/stores/${STORE_A_X}/locations`)
      .expect(200);
    expect(res.body.items).toEqual([
      { id: LOCATION, storeId: STORE_A_X, code: 'PRIMARY', name: 'Primary', kind: 'primary', isActive: true },
    ]);
    expect(fake.lastLocations).toEqual({ tenantId: TENANT_A, storeId: STORE_A_X });
  });

  it('a store outside a store-bound principal scope is a non-disclosing 404', async () => {
    contextGuard.context = { ...tenantLevelCtx(), storeId: STORE_A_X };
    await request(app.getHttpServer()).get(`/api/inventory/v1/stores/${STORE_A_Y}/locations`).expect(404);
    expect(fake.lastLocations).toBeNull();
  });

  it('a store outside a specific membership scope is a non-disclosing 404', async () => {
    contextGuard.context = { ...tenantLevelCtx(), storeAccess: { kind: 'specific', storeIds: [STORE_A_X] } };
    await request(app.getHttpServer()).get(`/api/inventory/v1/stores/${STORE_A_Y}/locations`).expect(404);
    expect(fake.lastLocations).toBeNull();
  });
});
