/**
 * __transfer-harness.ts — 009-US5 (stock transfer) HTTP harness.
 *
 * Mirrors the US2/US3 movement-harness wiring (real InventoryController +
 * InventoryService over the RLS-active env.app, real IdempotencyInterceptor,
 * FakeRedis) but exposes the cross-store fixtures a transfer needs: a source
 * store (A.X), a same-tenant destination (A.Y), and a cross-tenant store (B.X)
 * for the FR-051 non-disclosing-404 probe. The catalog isolation fixture seeds
 * all four stores; seed-inventory seeds an inbound at A.X so the source has
 * stock to move. NOT a spec file (`__`-prefixed).
 */
import 'reflect-metadata';

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  type Provider,
} from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import request from 'supertest';

import { GlobalExceptionFilter } from '../../../src/common/exception.filter';
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from '../../../src/idempotency/idempotency.interceptor';
import {
  INFLIGHT_REDIS,
  InProgressMarker,
} from '../../../src/idempotency/in-progress-marker';
import { PG_POOL } from '../../../src/auth/auth.module';
import { DashboardAuthGuard } from '../../../src/auth/dashboard-auth.guard';
import { TenantContextGuard } from '../../../src/context/tenant-context.guard';
import type { ResolvedContext } from '../../../src/context/types';
import { IdempotencyKeyStore } from '@data-pulse-2/shared';

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from '../../_helpers/postgres-container';
import {
  seedCatalogIsolationFixture,
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
} from '../../catalog/__support__/isolation-harness';
import { seedInventoryFixture } from '../__support__/seed-inventory';

import { MembershipRepository } from '../../../src/context/membership.repository';
import { InventoryController } from '../../../src/inventory/inventory.controller';
import { InventoryService } from '../../../src/inventory/inventory.service';

export {
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
  type PgTestEnv,
};

export function idempKey(suffix: string): string {
  return (suffix + '0'.repeat(32)).slice(0, 32).replace(/[^a-z0-9]/g, '0');
}

class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }
  async set(key: string, value: string, options: { px: number }): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + options.px });
    return 'OK';
  }
  clear(): void {
    this.store.clear();
  }
}

class FakeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {
    /* no-op */
  }
}

export class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string | null = STORE_A_X;
  public userId: string | null = ACTOR_A;
  public anonymous = false;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    if (this.anonymous) return true;
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: this.storeId,
      isPlatformAdmin: false,
      source: 'token',
    };
    if (this.userId) req.principal = { userId: this.userId };
    return true;
  }
}

export interface TransferHarness {
  readonly env: PgTestEnv;
  readonly app: INestApplication;
  readonly fakeRedis: { clear(): void };
  readonly contextGuard: ConfigurableContextGuard;
  readonly service: InventoryService;
  http(): request.SuperTest<request.Test>;
}

export interface HarnessHandle {
  harness: TransferHarness | null;
  dockerSkipped: boolean;
}

export async function startTransferHarness(): Promise<HarnessHandle> {
  let env: PgTestEnv;
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env['MIGRATION_TEST_ALLOW_SKIP'] === '1') {
      // eslint-disable-next-line no-console
      console.warn(`\n[009 transfer harness] Docker NOT AVAILABLE: ${msg}\n`);
      return { harness: null, dockerSkipped: true };
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  let startedApp: INestApplication | undefined;
  try {
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await seedInventoryFixture(env);

    const fakeRedis = new FakeRedis();
    const fakeMarker = new FakeMarker();
    const contextGuard = new ConfigurableContextGuard();
    const idempStore = new IdempotencyKeyStore({
      redis: fakeRedis,
      pgWriter: { async insert(): Promise<void> {} },
      pgReader: {
        async find(): Promise<null> {
          return null;
        },
      },
      defaultTtlMs: 72 * 60 * 60 * 1000,
    });
    const idempInterceptor = new IdempotencyInterceptor(
      new Reflector(),
      idempStore,
      fakeMarker as unknown as InProgressMarker,
    );

    const providers: Provider[] = [
      { provide: PG_POOL, useFactory: (): Pool => env.app },
      // InventoryController resolves store access via the membership
      // (§XII, #606). These harnesses seed users/stores/movements but NOT
      // memberships or store_access, and drive a non-platform-admin context —
      // so the real repository would find no membership and 404 every request,
      // changing what these suites test. A permissive stub keeps their subject
      // (transfers, counts, restock, sale-linked provenance, idempotency)
      // unchanged. Cross-store DENIAL is proven in
      // test/inventory/isolation/cross-store-authz.spec.ts.
      {
        provide: MembershipRepository,
        useValue: {
          findActiveMembership: async (): Promise<{
            membershipId: string;
            storeAccessKind: string;
          }> => ({
            membershipId: '0a000000-0000-7000-8000-0000000000e1',
            storeAccessKind: 'all',
          }),
          canAccessStore: async (): Promise<boolean> => true,
        } as unknown as MembershipRepository,
      },
      InventoryService,
      { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
    ];

    const moduleRef = await Test.createTestingModule({
      controllers: [InventoryController],
      providers,
    })
      .overrideGuard(DashboardAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(TenantContextGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const app = moduleRef.createNestApplication({ bufferLogs: true });
    startedApp = app;
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalGuards(contextGuard);
    await app.init();

    const harness: TransferHarness = {
      env,
      app,
      fakeRedis,
      contextGuard,
      service: new InventoryService(env.app as unknown as Pool),
      http: () => request(app.getHttpServer()),
    };
    return { harness, dockerSkipped: false };
  } catch (err) {
    if (startedApp) await startedApp.close().catch(() => undefined);
    await stopPgEnv(env).catch(() => undefined);
    throw err;
  }
}

export async function stopTransferHarness(h: HarnessHandle): Promise<void> {
  if (h.harness) {
    await h.harness.app.close();
    await stopPgEnv(h.harness.env);
  }
}

export function resetHarness(h: HarnessHandle): void {
  if (!h.harness) return;
  h.harness.fakeRedis.clear();
  h.harness.contextGuard.tenantId = TENANT_A;
  h.harness.contextGuard.storeId = STORE_A_X;
  h.harness.contextGuard.userId = ACTOR_A;
  h.harness.contextGuard.anonymous = false;
}

/** Path for the createStockTransfer POST route (contract operationId). */
export const TRANSFERS_PATH = '/api/inventory/v1/transfers';

/** On-hand for a (store, product) via the service (RLS-active app pool). */
export async function onHand(
  h: TransferHarness,
  storeId: string,
  productId: string = PRODUCT_A_ACTIVE,
): Promise<number> {
  const r = await h.service.getOnHand({ tenantId: TENANT_A, storeId, productId });
  return Number(r.quantity);
}

/** A valid createStockTransfer request body (matches CreateStockTransferCommand). */
export function transferBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceStoreId: STORE_A_X,
    destinationStoreId: STORE_A_Y,
    tenantProductRef: PRODUCT_A_ACTIVE,
    quantity: '4.0000',
    stockingUnit: 'ea',
    ...overrides,
  };
}
