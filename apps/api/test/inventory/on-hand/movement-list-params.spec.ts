/**
 * movement-list-params.spec.ts — RT-731 (inventory.yaml 1.5.0-draft).
 *
 * The request rules of `listStockMovements` at the HTTP edge: `scope` is
 * `adhoc` | `all` and only applies without `productId` (both together is a
 * 400 `validation_error`, refused before the service runs); `scope`, `limit`
 * and `cursor` reach the service unchanged.
 *
 * Docker-FREE — controller + global filter + fake service.
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
import { InventoryService } from '../../../src/inventory/inventory.service';

const TENANT_A = '0a000000-0000-7000-8000-00000000ada1';
const STORE_A = '0a000000-0000-7000-8000-00000000a5a1';
const USER_A = '0a000000-0000-7000-8000-0000000000ac';
const PRODUCT = '0a000000-0000-7000-8000-0000000000f1';

class FakeInventoryService {
  public calls: unknown[] = [];
  async listStockMovements(input: unknown): Promise<unknown> {
    this.calls.push(input);
    return { items: [], nextCursor: null };
  }
}

class FixedContextGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext }>();
    req.context = {
      userId: USER_A,
      tenantId: TENANT_A,
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
let fake: FakeInventoryService;

beforeAll(async () => {
  fake = new FakeInventoryService();
  const moduleRef = await Test.createTestingModule({
    controllers: [InventoryController],
    providers: [{ provide: InventoryService, useValue: fake }],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue(new PassAuthGuard())
    .overrideGuard(TenantContextGuard)
    .useValue(new FixedContextGuard())
    .compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(() => {
  fake.calls = [];
});

const url = `/api/inventory/v1/stores/${STORE_A}/movements`;

function http() {
  return request(app.getHttpServer());
}

describe('listStockMovements request rules (RT-731)', () => {
  it('scope together with productId is a 400 validation_error, before the service', async () => {
    const res = await http().get(`${url}?productId=${PRODUCT}&scope=all`).expect(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(fake.calls).toHaveLength(0);
  });

  it.each(['everything', 'ALL', ''])('scope=%j is a 400', async (scope) => {
    await http().get(`${url}?scope=${scope}`).expect(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('an empty or over-long cursor is a 400', async () => {
    await http().get(`${url}?cursor=`).expect(400);
    await http().get(`${url}?cursor=${'a'.repeat(1025)}`).expect(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('passes scope, limit and cursor to the service', async () => {
    await http().get(`${url}?scope=all&limit=25&cursor=abc_-1`).expect(200);
    expect(fake.calls).toEqual([
      {
        tenantId: TENANT_A,
        storeId: STORE_A,
        productId: null,
        scope: 'all',
        limit: 25,
        cursor: 'abc_-1',
      },
    ]);
  });

  it('without scope or productId the service decides the default (adhoc)', async () => {
    await http().get(url).expect(200);
    expect(fake.calls).toEqual([
      {
        tenantId: TENANT_A,
        storeId: STORE_A,
        productId: null,
        scope: undefined,
        limit: undefined,
        cursor: undefined,
      },
    ]);
  });
});
