/**
 * write-object-safety.spec.ts — 009-US2-MANUAL (T044, write-path object-safety).
 *
 * The WRITE-path half of the object-safety contract (the read-path half is
 * `on-hand/read-object-safety.spec.ts`; the sweep's GROUP B write-path note is
 * realized HERE, Docker-FREE). FR-052 / §XII mass-assignment ban:
 *
 *   - The create command is `.strict()` (`additionalProperties: false` in the
 *     contract): a body carrying `tenantId` / `createdBy` / `receivedAt` /
 *     `storeId` / a derived balance → 400 (unknown key rejected). There is no
 *     body `storeId` — the store is the PATH parameter.
 *   - The persisted row's `tenant_id` / `store_id` / `created_by` come from the
 *     resolved principal + path, NEVER the body. The FakeInventoryService here
 *     records what the controller passed it, proving the controller resolves
 *     these server-side (it never forwards a body-supplied tenant/actor).
 *
 * Docker-FREE — controller + Zod + a fake service. The DB-backed append proof
 * is in the Docker-gated `inbound-outbound-adjust.spec.ts`.
 *
 * RED until 009-US2-MANUAL's T044 adds the POST route.
 */
import 'reflect-metadata';

import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { DashboardAuthGuard } from '../../../src/auth/dashboard-auth.guard';
import { GlobalExceptionFilter } from '../../../src/common/exception.filter';
import { TenantContextGuard } from '../../../src/context/tenant-context.guard';
import type { ResolvedContext } from '../../../src/context/types';
import { MembershipRepository } from '../../../src/context/membership.repository';
import { InventoryController } from '../../../src/inventory/inventory.controller';
import { InventoryService } from '../../../src/inventory/inventory.service';

const TENANT_A = '0a000000-0000-7000-8000-00000000ada1';
const TENANT_EVIL = '0e000000-0000-7000-8000-0000000000e7';
const STORE_A_X = '0a000000-0000-7000-8000-00000000a5a1';
const STORE_EVIL = '0e000000-0000-7000-8000-00000000e511';
const USER_A = '0a000000-0000-7000-8000-0000000000ac';
const USER_EVIL = '0e000000-0000-7000-8000-0000000000ee';

class FakeInventoryService {
  public lastCreateArgs: {
    tenantId: string;
    storeId: string;
    userId: string;
  } | null = null;
  // The real service resolves tenant/store/actor server-side; the controller
  // passes `userId` (the acting principal) — NOT a body-supplied `createdBy`.
  async createStockMovement(input: {
    tenantId: string;
    storeId: string;
    userId: string;
  }): Promise<{ id: string; storeId: string }> {
    this.lastCreateArgs = {
      tenantId: input.tenantId,
      storeId: input.storeId,
      userId: input.userId,
    };
    return {
      id: '0a000000-0000-7000-8000-00000000d0d1',
      storeId: input.storeId,
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

describe('createStockMovement — object-safety / mass-assignment (FR-052, §XII)', () => {
  it('a body carrying tenantId/createdBy/receivedAt is rejected 400 (.strict)', async () => {
    contextGuard.context = tenantLevelCtx();
    await http()
      .post(`/api/inventory/v1/stores/${STORE_A_X}/movements`)
      .send({
        movementType: 'inbound',
        quantity: '5.0000',
        stockingUnit: 'ea',
        // forbidden mass-assignment fields:
        tenantId: TENANT_EVIL,
        createdBy: USER_EVIL,
        receivedAt: '2020-01-01T00:00:00.000Z',
      })
      .expect(400);
  });

  it('a body carrying a derived/balance field is rejected 400 (.strict)', async () => {
    contextGuard.context = tenantLevelCtx();
    await http()
      .post(`/api/inventory/v1/stores/${STORE_A_X}/movements`)
      .send({
        movementType: 'inbound',
        quantity: '5.0000',
        stockingUnit: 'ea',
        negativeBalance: false, // derived projection field, not a command field
      })
      .expect(400);
  });

  it('a body carrying an unknown storeId is rejected 400 — store is the PATH, never the body', async () => {
    contextGuard.context = tenantLevelCtx();
    await http()
      .post(`/api/inventory/v1/stores/${STORE_A_X}/movements`)
      .send({
        movementType: 'inbound',
        quantity: '5.0000',
        stockingUnit: 'ea',
        storeId: STORE_EVIL,
      })
      .expect(400);
  });

  it('on a clean body, the persisted row uses the PRINCIPAL tenant + PATH store + PRINCIPAL actor (not the body)', async () => {
    contextGuard.context = tenantLevelCtx();
    await http()
      .post(`/api/inventory/v1/stores/${STORE_A_X}/movements`)
      .send({
        movementType: 'inbound',
        quantity: '5.0000',
        stockingUnit: 'ea',
      })
      .expect((res) => {
        if (res.status >= 400) {
          throw new Error(`expected success, got ${res.status}`);
        }
      });
    expect(fake.lastCreateArgs?.tenantId).toBe(TENANT_A); // from context, never body
    expect(fake.lastCreateArgs?.storeId).toBe(STORE_A_X); // from path, never body
    expect(fake.lastCreateArgs?.userId).toBe(USER_A); // actor from context, never body
  });
});

// The quantity DTO is bounded to the numeric(19,4) shape so a value that the
// DB cast would silently round to 0.0000 (>4 fraction digits) or overflow
// (>15 integer digits) is rejected 400 at the boundary — never a stored zero,
// never a 500 (CodeRabbit #444).
describe('createStockMovement — quantity bounded to numeric(19,4) (FR-022)', () => {
  it('more than 4 fraction digits → 400 (would silently round to 0.0000 / lose precision)', async () => {
    contextGuard.context = tenantLevelCtx();
    await http()
      .post(`/api/inventory/v1/stores/${STORE_A_X}/movements`)
      .send({ movementType: 'inbound', quantity: '0.00004', stockingUnit: 'ea' })
      .expect(400);
  });

  it('more than 15 integer digits → 400 (would overflow numeric(19,4) at insert)', async () => {
    contextGuard.context = tenantLevelCtx();
    await http()
      .post(`/api/inventory/v1/stores/${STORE_A_X}/movements`)
      .send({
        movementType: 'inbound',
        quantity: '1234567890123456',
        stockingUnit: 'ea',
      })
      .expect(400);
  });

  it('a well-formed numeric(19,4) value (≤15 int, ≤4 frac) is accepted', async () => {
    contextGuard.context = tenantLevelCtx();
    await http()
      .post(`/api/inventory/v1/stores/${STORE_A_X}/movements`)
      .send({ movementType: 'inbound', quantity: '12.5000', stockingUnit: 'ea' })
      .expect((res) => {
        if (res.status >= 400) {
          throw new Error(`expected success, got ${res.status}`);
        }
      });
  });
});
