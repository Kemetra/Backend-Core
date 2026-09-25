/**
 * __movement-harness.ts — shared Testcontainers + Nest wiring for the 009 US3
 * idempotency specs (T050–T053). NOT a spec file (`__`-prefixed, no `.spec`) so
 * Jest's testMatch ignores it.
 *
 * Mirrors the 008 `__capture-harness.ts`: a hand-rolled `Test.createTestingModule`
 * with the real InventoryController + InventoryService (PG_POOL → env.app,
 * RLS-active), the real IdempotencyInterceptor as an APP_INTERCEPTOR (proves the
 * EXISTING primitive covers the new write route — no new primitive, FR-030), a
 * configurable context guard publishing the operator principal, and
 * FakeRedis/FakeMarker for the idempotency stack (no real Redis — also keeps the
 * suite free of the open Redis handle).
 *
 * Manual idempotency (T050/T051) is an HTTP-layer concern: the
 * IdempotencyInterceptor reads the `Idempotency-Key` header + body fingerprint
 * off the HTTP request, so these specs MUST drive the app over supertest, not a
 * direct `new InventoryService()` call. (T052 provenance dedup is the DB-level
 * partial-unique and is exercised against the service/DB.)
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

import { assertIdempotencyRedisRetains } from '../../idempotency/require-retaining-redis';

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

import { MembershipRepository } from '../../../src/context/membership.repository';
import { InventoryController } from '../../../src/inventory/inventory.controller';
import { InventoryService } from '../../../src/inventory/inventory.service';

export { ACTOR_A, PRODUCT_A_ACTIVE, STORE_A_X, TENANT_A, type PgTestEnv };

/** A fresh 32-char ASCII idempotency key per call site. */
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

/** Sets `req.context` to the operator principal; mutable per test. */
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

export interface MovementHarness {
  readonly env: PgTestEnv;
  readonly app: INestApplication;
  readonly fakeRedis: { clear(): void };
  readonly contextGuard: ConfigurableContextGuard;
  /** Real persisted idempotency replay store across requests (mirrors prod). */
  http(): request.SuperTest<request.Test>;
}

export interface HarnessHandle {
  harness: MovementHarness | null;
  dockerSkipped: boolean;
}

/**
 * Idempotency store backed by FakeRedis as the source of truth for replay
 * (Redis is checked first; the Postgres mirror is only a durability fallback).
 * The pg mirror is inert here — FakeRedis persists across requests within a
 * suite, so a repeated (tenant, store, clientId, key) replays the recorded
 * response and a divergent body fingerprint 409s, all from Redis. Mirrors the
 * 008 capture harness exactly; stub signatures match PgMirrorWriter/Reader.
 */
function buildIdempStore(fakeRedis: FakeRedis): IdempotencyKeyStore {
  return new IdempotencyKeyStore({
    redis: fakeRedis,
    pgWriter: { async insert(): Promise<void> {} },
    pgReader: {
      async find(): Promise<null> {
        return null;
      },
    },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
}

export async function startMovementHarness(): Promise<HarnessHandle> {
  let env: PgTestEnv;
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env['MIGRATION_TEST_ALLOW_SKIP'] === '1') {
      // eslint-disable-next-line no-console
      console.warn(`\n[009 movement harness] Docker NOT AVAILABLE: ${msg}\n`);
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
    await assertIdempotencyRedisRetains(fakeRedis, 'movement-harness');
    const fakeMarker = new FakeMarker();
    const contextGuard = new ConfigurableContextGuard();
    const idempStore = buildIdempStore(fakeRedis);
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

    const harness: MovementHarness = {
      env,
      app,
      fakeRedis,
      contextGuard,
      http: () => request(app.getHttpServer()),
    };
    return { harness, dockerSkipped: false };
  } catch (err) {
    if (startedApp) await startedApp.close().catch(() => undefined);
    await stopPgEnv(env).catch(() => undefined);
    throw err;
  }
}

export async function stopMovementHarness(h: HarnessHandle): Promise<void> {
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

/** Path for the createStockMovement POST route. */
export function movementsPath(storeId: string = STORE_A_X): string {
  return `/api/inventory/v1/stores/${storeId}/movements`;
}

/** A valid createStockMovement request body (matches CreateStockMovementSchema). */
export function movementBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    movementType: 'inbound',
    quantity: '4.0000',
    stockingUnit: 'ea',
    tenantProductRef: PRODUCT_A_ACTIVE,
    reason: 'manual inbound',
    ...overrides,
  };
}
