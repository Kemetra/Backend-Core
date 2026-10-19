/**
 * position-events-http.spec.ts — Jira RT-435, HTTP layer.
 *
 * The controller boundary against a fake service (no DB), with the REAL
 * `RolesGuard` over a stubbed membership lookup:
 *   - roles (D2): owner / tenant_admin / store_manager may post a status move or
 *     a relocation and read the return landing policy; store_staff is a 403;
 *     only owner / tenant_admin may set the policy;
 *   - store scope (960): a store_manager outside its store scope is a
 *     non-disclosing 404 and never reaches the service;
 *   - strict bodies: an unknown status or reason code, a zero quantity, a
 *     tracking field or a body tenant / store is a 400; the moves require the
 *     Idempotency-Key header;
 *   - the server-resolved tenant, actor, store and key are what the service
 *     receives.
 */
import 'reflect-metadata';

import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { DashboardAuthGuard } from '../../../src/auth/dashboard-auth.guard';
import { RolesGuard } from '../../../src/auth/roles.guard';
import { GlobalExceptionFilter } from '../../../src/common/exception.filter';
import { MembershipRepository } from '../../../src/context/membership.repository';
import { TenantContextGuard } from '../../../src/context/tenant-context.guard';
import type { ResolvedContext } from '../../../src/context/types';
import { InventoryPositionEventsController } from '../../../src/inventory/position-events/position-events.controller';
import { InventoryPositionEventsService } from '../../../src/inventory/position-events/position-events.service';

const TENANT = '0a000000-0000-7000-8000-00000000ada1';
const STORE_X = '0a000000-0000-7000-8000-00000000a5a1';
const STORE_Y = '0a000000-0000-7000-8000-00000000a5a2';
const USER = '0a000000-0000-7000-8000-0000000000ac';
const PRODUCT = '0a000000-0000-7000-8000-00000000a401';
const LOC_A = '0a000000-0000-7000-8000-0000000435b1';
const LOC_B = '0a000000-0000-7000-8000-0000000435b2';
const KEY = 'rt435-http-key-0001';

class FakeService {
  public last: { op: string; input: Record<string, unknown> } | null = null;
  async createStatusMove(input: Record<string, unknown>) {
    this.last = { op: 'statusMove', input };
    return { id: 'e1' };
  }
  async createRelocation(input: Record<string, unknown>) {
    this.last = { op: 'relocation', input };
    return { id: 'e2' };
  }
  async getReturnLandingPolicy(tenantId: string) {
    this.last = { op: 'getPolicy', input: { tenantId } };
    return { returnLandingStatus: 'sellable', updatedAt: null };
  }
  async setReturnLandingPolicy(input: Record<string, unknown>) {
    this.last = { op: 'setPolicy', input };
    return { returnLandingStatus: input['returnLandingStatus'], updatedAt: '2026-10-19T00:00:00.000Z' };
  }
}

class FakeMemberships {
  public role: string | null = 'store_manager';
  async findRoleCodeForUserInTenant(): Promise<string | null> {
    return this.role;
  }
  async isPlatformAdmin(): Promise<boolean> {
    return false;
  }
}

/** Publishes the session principal and the configured context, as the real guards do. */
class ConfigurableContextGuard implements CanActivate {
  public context: ResolvedContext | null = null;
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext; principal?: unknown }>();
    req.principal = { kind: 'session', sessionId: 's1', userId: USER };
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
const fake = new FakeService();
const memberships = new FakeMemberships();
const contextGuard = new ConfigurableContextGuard();

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [InventoryPositionEventsController],
    providers: [
      { provide: InventoryPositionEventsService, useValue: fake },
      { provide: MembershipRepository, useValue: memberships },
      RolesGuard,
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
  fake.last = null;
  memberships.role = 'store_manager';
  contextGuard.context = managerOfX();
});

function managerOfX(): ResolvedContext {
  return {
    userId: USER,
    tenantId: TENANT,
    storeId: null,
    isPlatformAdmin: false,
    source: 'session',
    storeAccess: { kind: 'specific', storeIds: [STORE_X] },
  };
}

const statusMove = {
  tenantProductRef: PRODUCT,
  quantity: '3',
  stockingUnit: 'ea',
  fromStatus: 'sellable',
  toStatus: 'damaged',
  reasonCode: 'damage',
};
const relocation = {
  tenantProductRef: PRODUCT,
  quantity: '2',
  stockingUnit: 'ea',
  fromLocationId: LOC_A,
  toLocationId: LOC_B,
};

function post(path: string, body: unknown, withKey = true) {
  const r = request(app.getHttpServer()).post(path).send(body as object);
  return withKey ? r.set('Idempotency-Key', KEY) : r;
}

describe('RT-435 status-moves / relocations — roles and store scope', () => {
  it('forwards a store_manager status move in its store with the server-resolved actor and key', async () => {
    await post(`/api/inventory/v1/stores/${STORE_X}/status-moves`, statusMove).expect(201);
    expect(fake.last).toEqual({
      op: 'statusMove',
      input: {
        tenantId: TENANT,
        userId: USER,
        isPlatformAdmin: false,
        idempotencyKey: KEY,
        storeId: STORE_X,
        tenantProductRef: PRODUCT,
        quantity: '3',
        stockingUnit: 'ea',
        stockLocationId: null,
        fromStatus: 'sellable',
        toStatus: 'damaged',
        reasonCode: 'damage',
        note: null,
      },
    });
  });

  it('forwards a relocation with the status defaulted by the service', async () => {
    await post(`/api/inventory/v1/stores/${STORE_X}/relocations`, relocation).expect(201);
    expect(fake.last?.op).toBe('relocation');
    expect(fake.last?.input).toMatchObject({ fromLocationId: LOC_A, toLocationId: LOC_B, inventoryStatus: null, reasonCode: null });
  });

  it('a store outside the store_manager scope is a non-disclosing 404', async () => {
    await post(`/api/inventory/v1/stores/${STORE_Y}/status-moves`, statusMove).expect(404);
    await post(`/api/inventory/v1/stores/${STORE_Y}/relocations`, relocation).expect(404);
    expect(fake.last).toBeNull();
  });

  it('a role outside owner / tenant_admin / store_manager is a 403', async () => {
    memberships.role = 'store_staff';
    await post(`/api/inventory/v1/stores/${STORE_X}/status-moves`, statusMove).expect(403);
    await post(`/api/inventory/v1/stores/${STORE_X}/relocations`, relocation).expect(403);
    expect(fake.last).toBeNull();
  });

  it('requires the Idempotency-Key header', async () => {
    await post(`/api/inventory/v1/stores/${STORE_X}/status-moves`, statusMove, false).expect(400);
    expect(fake.last).toBeNull();
  });

  it.each<[string, string, Record<string, unknown>]>([
    ['an unknown status', 'status-moves', { ...statusMove, toStatus: 'on_shelf' }],
    ['an unknown reason code', 'status-moves', { ...statusMove, reasonCode: 'shrinkage' }],
    ['a missing reason code', 'status-moves', { ...statusMove, reasonCode: undefined }],
    ['a zero quantity', 'status-moves', { ...statusMove, quantity: '0.0000' }],
    ['a negative quantity', 'relocations', { ...relocation, quantity: '-2' }],
    ['a tracking identity (RT-451, not accepted yet)', 'status-moves', { ...statusMove, trackingIdentityId: LOC_A }],
    ['a body tenant', 'relocations', { ...relocation, tenantId: TENANT }],
    ['a body store', 'status-moves', { ...statusMove, storeId: STORE_Y }],
    ['a non-uuid location', 'relocations', { ...relocation, toLocationId: 'backroom' }],
    ['a note over 500 characters', 'relocations', { ...relocation, note: 'x'.repeat(501) }],
  ])('rejects %s with 400', async (_label, route, body) => {
    await post(`/api/inventory/v1/stores/${STORE_X}/${route}`, body).expect(400);
    expect(fake.last).toBeNull();
  });
});

describe('RT-435 return landing policy — roles', () => {
  it('a store_manager may read it', async () => {
    const r = await request(app.getHttpServer()).get('/api/inventory/v1/settings/return-landing').expect(200);
    expect(r.body).toEqual({ returnLandingStatus: 'sellable', updatedAt: null });
    expect(fake.last).toEqual({ op: 'getPolicy', input: { tenantId: TENANT } });
  });

  it('a store_manager may not set it (403); a tenant_admin may', async () => {
    await request(app.getHttpServer())
      .put('/api/inventory/v1/settings/return-landing')
      .send({ returnLandingStatus: 'return_inspection' })
      .expect(403);
    expect(fake.last).toBeNull();

    memberships.role = 'tenant_admin';
    await request(app.getHttpServer())
      .put('/api/inventory/v1/settings/return-landing')
      .send({ returnLandingStatus: 'return_inspection' })
      .expect(200);
    expect(fake.last).toEqual({
      op: 'setPolicy',
      input: { tenantId: TENANT, userId: USER, returnLandingStatus: 'return_inspection' },
    });
  });

  it('refuses a status other than sellable / return_inspection, and unknown keys', async () => {
    memberships.role = 'owner';
    for (const body of [{ returnLandingStatus: 'damaged' }, { returnLandingStatus: 'sellable', tenantId: TENANT }]) {
      await request(app.getHttpServer()).put('/api/inventory/v1/settings/return-landing').send(body).expect(400);
    }
    expect(fake.last).toBeNull();
  });
});
