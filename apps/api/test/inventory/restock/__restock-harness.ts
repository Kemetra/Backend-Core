/**
 * __restock-harness.ts — 009-RESTOCK (provenance-linked restock) HTTP harness.
 *
 * Mirrors the US4 sale-linked harness: real InventoryController + InventoryService
 * over the RLS-active env.app, plus the 008 fixture seeded so a restock can
 * reference a REAL void/refund terminal-event id (VOID_A_X / REFUND_A_X) as
 * provenance (FR-025). The restock is the INBOUND mirror of the sale-linked
 * outbound — same provenance-dedup machinery, opposite sign. NOT a spec file.
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
  TENANT_A,
} from '../../catalog/__support__/isolation-harness';
import { seedInventoryFixture } from '../__support__/seed-inventory';
import {
  seedSalesFixture,
  VOID_A_X,
  REFUND_A_X,
} from '../../catalog/sales/__support__/seed-sales';

import { MembershipRepository } from '../../../src/context/membership.repository';
import { InventoryController } from '../../../src/inventory/inventory.controller';
import { InventoryService } from '../../../src/inventory/inventory.service';

export {
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  TENANT_A,
  VOID_A_X,
  REFUND_A_X,
  type PgTestEnv,
};

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

export interface RestockHarness {
  readonly env: PgTestEnv;
  readonly app: INestApplication;
  readonly fakeRedis: { clear(): void };
  readonly contextGuard: ConfigurableContextGuard;
  readonly service: InventoryService;
  http(): request.SuperTest<request.Test>;
}

export interface HarnessHandle {
  harness: RestockHarness | null;
  dockerSkipped: boolean;
}

export async function startRestockHarness(): Promise<HarnessHandle> {
  let env: PgTestEnv;
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env['MIGRATION_TEST_ALLOW_SKIP'] === '1') {
      // eslint-disable-next-line no-console
      console.warn(`\n[009 restock harness] Docker NOT AVAILABLE: ${msg}\n`);
      return { harness: null, dockerSkipped: true };
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  let startedApp: INestApplication | undefined;
  try {
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await seedSalesFixture(env); // 008 void/refund terminal events (provenance, R8)
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
      // (§XII, #606). Real repository over the harness pool, so the
      // seeded membership's store_access actually decides.
      {
        provide: MembershipRepository,
        useFactory: (): MembershipRepository => new MembershipRepository(env.app),
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

    const harness: RestockHarness = {
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

export async function stopRestockHarness(h: HarnessHandle): Promise<void> {
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

/** On-hand for a (store, product) via the service (RLS-active app pool). */
export async function onHand(
  h: RestockHarness,
  productId: string = PRODUCT_A_ACTIVE,
  storeId: string = STORE_A_X,
): Promise<number> {
  const r = await h.service.getOnHand({ tenantId: TENANT_A, storeId, productId });
  return Number(r.quantity);
}

/** A worker-internal restock-inbound input referencing an 008 void terminal event. */
export function restockInput(
  externalId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tenantId: TENANT_A,
    storeId: STORE_A_X,
    userId: ACTOR_A,
    sourceSystem: 'pos-restock',
    externalId,
    movementType: 'inbound',
    quantity: '2.0000',
    stockingUnit: 'ea',
    tenantProductRef: PRODUCT_A_ACTIVE,
    terminalEventRef: VOID_A_X,
    correlationId: 'corr-restock',
    ...overrides,
  };
}
