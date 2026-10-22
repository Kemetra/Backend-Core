/**
 * inventory-safety-http.spec.ts — Jira RT-449 PR 1, HTTP layer.
 *
 * The controller boundary against fake services (no DB), with the REAL
 * `RolesGuard` over a stubbed membership lookup:
 *   - roles (H1, H2): owner and tenant_admin place a quality hold, create a
 *     recall, correct an expiry and read holds / recalls; only the owner
 *     releases a hold; a store_manager (and store_staff) is a 403 on all six
 *     operations and never reaches a service — the commands are tenant-level
 *     (a hold reaches every store), so no store scope can admit one;
 *   - strict bodies: unknown keys, a body tenant / store / actor, malformed
 *     ids, reason codes and dates, duplicate or too many identities are a
 *     400; the commands require the Idempotency-Key header (the release is
 *     naturally idempotent and does not);
 *   - the server-resolved tenant, actor and key are what the services receive.
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
import { IdentityExpiryService } from '../../../src/inventory/safety/identity-expiry.service';
import { InventoryRecallsService } from '../../../src/inventory/safety/inventory-recalls.service';
import { InventorySafetyController } from '../../../src/inventory/safety/inventory-safety.controller';
import { TrackingHoldsService } from '../../../src/inventory/safety/tracking-holds.service';

const TENANT = '0a000000-0000-7000-8000-00000000ada1';
const USER = '0a000000-0000-7000-8000-0000000000ac';
const PRODUCT = '0a000000-0000-7000-8000-00000000a401';
const IDENTITY = '0a000000-0000-7000-8000-000004490c01';
const IDENTITY_2 = '0a000000-0000-7000-8000-000004490c02';
const HOLD = '0a000000-0000-7000-8000-000004490d01';
const RECALL = '0a000000-0000-7000-8000-000004490e01';
const KEY = 'rt449-http-key-0001';

class FakeServices {
  public last: { op: string; input: unknown } | null = null;
  private record(op: string, input: unknown) {
    this.last = { op, input };
    return { op };
  }
  async placeQualityHold(input: unknown) {
    return this.record('place', input);
  }
  async releaseHold(input: unknown) {
    return this.record('release', input);
  }
  async getHold(tenantId: string, holdId: string) {
    return this.record('getHold', { tenantId, holdId });
  }
  async createRecall(input: unknown) {
    return this.record('recall', input);
  }
  async getRecall(tenantId: string, recallId: string) {
    return this.record('getRecall', { tenantId, recallId });
  }
  async correctExpiry(input: unknown) {
    return this.record('expiry', input);
  }
}

class FakeMemberships {
  public role: string | null = 'owner';
  async findRoleCodeForUserInTenant(): Promise<string | null> {
    return this.role;
  }
  async isPlatformAdmin(): Promise<boolean> {
    return false;
  }
}

/** Publishes the session principal and an all-stores context, as the real guards do. */
class ContextGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext; principal?: unknown }>();
    req.principal = { kind: 'session', sessionId: 's1', userId: USER };
    req.context = {
      userId: USER,
      tenantId: TENANT,
      storeId: null,
      isPlatformAdmin: false,
      source: 'session',
      storeAccess: { kind: 'all' },
    };
    return true;
  }
}
class PassAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

let app: INestApplication;
const fake = new FakeServices();
const memberships = new FakeMemberships();

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [InventorySafetyController],
    providers: [
      { provide: TrackingHoldsService, useValue: fake },
      { provide: InventoryRecallsService, useValue: fake },
      { provide: IdentityExpiryService, useValue: fake },
      { provide: MembershipRepository, useValue: memberships },
      RolesGuard,
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue(new PassAuthGuard())
    .overrideGuard(TenantContextGuard)
    .useValue(new ContextGuard())
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
  memberships.role = 'owner';
});

const placeBody = { trackingIdentityId: IDENTITY, reasonCode: 'supplier_notice' };
const recallBody = {
  tenantProductRef: PRODUCT,
  trackingIdentityIds: [IDENTITY, IDENTITY_2],
  reasonCode: 'authority_notice',
  reference: 'EDA-2026-117',
};
const expiryBody = { expiryDate: '2027-03-31', reasonCode: 'label_misprint' };

const PLACE = '/api/inventory/v1/tracking-holds';
const RELEASE = `/api/inventory/v1/tracking-holds/${HOLD}/release`;
const GET_HOLD = `/api/inventory/v1/tracking-holds/${HOLD}`;
const RECALLS = '/api/inventory/v1/recalls';
const GET_RECALL = `/api/inventory/v1/recalls/${RECALL}`;
const EXPIRY = `/api/inventory/v1/tracking-identities/${IDENTITY}/expiry-corrections`;

function post(path: string, body: unknown, withKey = true) {
  const r = request(app.getHttpServer()).post(path).send(body as object);
  return withKey ? r.set('Idempotency-Key', KEY) : r;
}

describe('RT-449 safety commands — what the services receive', () => {
  it('a quality hold carries the server-resolved tenant, actor and key', async () => {
    await post(PLACE, placeBody).expect(201);
    expect(fake.last).toEqual({
      op: 'place',
      input: {
        tenantId: TENANT,
        userId: USER,
        idempotencyKey: KEY,
        trackingIdentityId: IDENTITY,
        reasonCode: 'supplier_notice',
        note: null,
      },
    });
  });

  it('a release needs no Idempotency-Key and answers 200', async () => {
    await post(RELEASE, { note: 'cleared' }, false).expect(200);
    expect(fake.last).toEqual({ op: 'release', input: { tenantId: TENANT, userId: USER, holdId: HOLD, note: 'cleared' } });
    await post(RELEASE, undefined, false).expect(200);
    expect(fake.last).toEqual({ op: 'release', input: { tenantId: TENANT, userId: USER, holdId: HOLD, note: null } });
  });

  it('a recall and an expiry correction carry the server-resolved tenant, actor and key', async () => {
    await post(RECALLS, recallBody).expect(201);
    expect(fake.last).toEqual({
      op: 'recall',
      input: {
        tenantId: TENANT,
        userId: USER,
        idempotencyKey: KEY,
        tenantProductRef: PRODUCT,
        trackingIdentityIds: [IDENTITY, IDENTITY_2],
        reasonCode: 'authority_notice',
        reference: 'EDA-2026-117',
        note: null,
        effectiveAt: null,
      },
    });
    await post(EXPIRY, { ...expiryBody, expiryDate: null }).expect(201);
    expect(fake.last).toEqual({
      op: 'expiry',
      input: {
        tenantId: TENANT,
        userId: USER,
        idempotencyKey: KEY,
        trackingIdentityId: IDENTITY,
        expiryDate: null,
        reasonCode: 'label_misprint',
        note: null,
      },
    });
  });

  it('the reads are scoped to the resolved tenant', async () => {
    await request(app.getHttpServer()).get(GET_HOLD).expect(200);
    expect(fake.last).toEqual({ op: 'getHold', input: { tenantId: TENANT, holdId: HOLD } });
    await request(app.getHttpServer()).get(GET_RECALL).expect(200);
    expect(fake.last).toEqual({ op: 'getRecall', input: { tenantId: TENANT, recallId: RECALL } });
  });
});

describe('RT-449 roles (H1, H2)', () => {
  const calls: Array<[string, () => request.Test]> = [
    ['place', () => post(PLACE, placeBody)],
    ['release', () => post(RELEASE, {}, false)],
    ['get hold', () => request(app.getHttpServer()).get(GET_HOLD)],
    ['recall', () => post(RECALLS, recallBody)],
    ['get recall', () => request(app.getHttpServer()).get(GET_RECALL)],
    ['expiry', () => post(EXPIRY, expiryBody)],
  ];

  it.each(['store_manager', 'store_staff'])('a %s is a 403 on all six operations, never reaching a service', async (role) => {
    memberships.role = role;
    for (const [, call] of calls) await call().expect(403);
    expect(fake.last).toBeNull();
  });

  it('a tenant_admin places, recalls, corrects and reads, but may not release (965)', async () => {
    memberships.role = 'tenant_admin';
    await post(PLACE, placeBody).expect(201);
    await post(RECALLS, recallBody).expect(201);
    await post(EXPIRY, expiryBody).expect(201);
    await request(app.getHttpServer()).get(GET_HOLD).expect(200);
    await request(app.getHttpServer()).get(GET_RECALL).expect(200);
    fake.last = null;
    await post(RELEASE, {}, false).expect(403);
    expect(fake.last).toBeNull();
  });
});

describe('RT-449 strict requests', () => {
  it.each(['place', 'recall', 'expiry'])('the %s command requires the Idempotency-Key header', async (op) => {
    const [path, body] = op === 'place' ? [PLACE, placeBody] : op === 'recall' ? [RECALLS, recallBody] : [EXPIRY, expiryBody];
    await post(path, body, false).expect(400);
    expect(fake.last).toBeNull();
  });

  it.each<[string, string, unknown]>([
    ['a non-uuid identity', PLACE, { ...placeBody, trackingIdentityId: 'LOT-1' }],
    ['a reason code that is not lower snake case', PLACE, { ...placeBody, reasonCode: 'Supplier Notice' }],
    ['a body tenant', PLACE, { ...placeBody, tenantId: TENANT }],
    ['a body actor', PLACE, { ...placeBody, placedBy: USER }],
    ['a note over 500 characters', PLACE, { ...placeBody, note: 'x'.repeat(501) }],
    ['an unknown release key', RELEASE, { note: 'ok', releasedBy: USER }],
    ['a body store', RECALLS, { ...recallBody, storeId: PRODUCT }],
    ['no identities', RECALLS, { ...recallBody, trackingIdentityIds: [] }],
    ['a repeated identity', RECALLS, { ...recallBody, trackingIdentityIds: [IDENTITY, IDENTITY] }],
    ['more than 100 identities', RECALLS, { ...recallBody, trackingIdentityIds: Array.from({ length: 101 }, () => IDENTITY) }],
    ['an empty reference', RECALLS, { ...recallBody, reference: '' }],
    ['a malformed effectiveAt', RECALLS, { ...recallBody, effectiveAt: 'yesterday' }],
    ['a malformed expiry date', EXPIRY, { ...expiryBody, expiryDate: '31/03/2027' }],
    ['a missing expiry date', EXPIRY, { reasonCode: 'label_misprint' }],
    ['a non-uuid hold', '/api/inventory/v1/tracking-holds/not-a-hold/release', {}],
    ['a non-uuid identity path', '/api/inventory/v1/tracking-identities/LOT-1/expiry-corrections', expiryBody],
  ])('rejects %s with 400', async (_label, path, body) => {
    await post(path, body).expect(400);
    expect(fake.last).toBeNull();
  });

  it('rejects a non-uuid read id with 400', async () => {
    await request(app.getHttpServer()).get('/api/inventory/v1/tracking-holds/LOT-1').expect(400);
    await request(app.getHttpServer()).get('/api/inventory/v1/recalls/LOT-1').expect(400);
    expect(fake.last).toBeNull();
  });
});
