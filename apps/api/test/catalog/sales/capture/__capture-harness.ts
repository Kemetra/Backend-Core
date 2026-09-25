/**
 * __capture-harness.ts — shared Testcontainers + Nest wiring for the 008 US1
 * capture specs (T030–T034). NOT a spec file (`__`-prefixed, no `.spec`) so
 * Jest's testMatch ignores it.
 *
 * Mirrors `apps/api/test/catalog/unknown-items/capture/capture-happy-path.spec.ts`
 * wiring: hand-rolled `Test.createTestingModule` with the real
 * SalesController + SalesService (PG_POOL → env.app, RLS-active), the real
 * IdempotencyInterceptor (proves the existing primitive covers the new route),
 * a configurable POS-principal context guard, and FakeRedis/FakeMarker for the
 * idempotency stack (no real Redis). The capture data path must run UNDER RLS
 * (env.app, not env.admin) so tenant isolation + snapshot behavior are real.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  type Provider,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";

import { RequestIdInterceptor } from "../../../../src/common/request-id.interceptor";
import { AuditEmitterInterceptor } from "../../../../src/audit/audit-emitter.interceptor";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../../src/audit/audit-job.enqueuer";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../../../src/idempotency/idempotency.interceptor";
import {
  INFLIGHT_REDIS,
  InProgressMarker,
} from "../../../../src/idempotency/in-progress-marker";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { PosOperatorAuthGuard } from "../../../../src/auth/pos-operator-auth.guard";
import { PosOperatorEnvelopeSaleGuard } from "../../../../src/auth/pos-operator-envelope-sale.guard";
import { PosWriteRateLimitGuard } from "../../../../src/auth/pos-write-rate-limit.guard";
import { OPERATOR_CONTEXT_RESOLVER } from "../../../../src/auth/operator-context-resolver";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../../src/context/types";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";

import { assertIdempotencyRedisRetains } from "../../../idempotency/require-retaining-redis";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  TENANT_A,
  TENANT_B,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  PRODUCT_A_ACTIVE,
} from "../../__support__/isolation-harness";

// The capture controller/service do not exist yet — these imports are the RED
// signal for T035 (they resolve once the GREEN slice authors them). Kept here
// (not at each spec's top) so the harness is the single point that references
// the unbuilt module.
import { SalesController } from "../../../../src/catalog/sales/sales.controller";
import { SalesService } from "../../../../src/catalog/sales/sales.service";

export {
  TENANT_A,
  TENANT_B,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  PRODUCT_A_ACTIVE,
  type PgTestEnv,
};

/** Stand-in POS device principal id (`req.context.userId`). */
export const DEVICE_USER_ID = "0d000000-0000-7000-8000-0000000005d1";

/** A fresh 32-char ASCII idempotency key per call site. */
export function idempKey(suffix: string): string {
  return (suffix + "0".repeat(32)).slice(0, 32).replace(/[^a-z0-9]/g, "0");
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
    return "OK";
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

/** Sets `req.context` to a POS principal; mutable per test. */
export class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string | null = STORE_A_X;
  public userId: string | null = DEVICE_USER_ID;
  /** When true, publishes NO context — exercises the unauthenticated path. */
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
      source: "token",
    };
    if (this.userId) req.principal = { userId: this.userId };
    return true;
  }
}

export interface CaptureHarness {
  readonly env: PgTestEnv;
  readonly app: INestApplication;
  readonly fakeRedis: { clear(): void };
  readonly contextGuard: ConfigurableContextGuard;
  http(): request.SuperTest<request.Test>;
}

export interface HarnessHandle {
  harness: CaptureHarness | null;
  dockerSkipped: boolean;
}

/**
 * Bring up Postgres + migrations + parent fixtures + the Nest app wiring the
 * real SalesController/Service. Returns a handle whose `harness` is null when
 * Docker is unavailable AND MIGRATION_TEST_ALLOW_SKIP=1.
 */
export async function startCaptureHarness(
  opts: { auditEnqueuer?: AuditJobEnqueuer } = {},
): Promise<HarnessHandle> {
  let env: PgTestEnv;
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[008 capture harness] Docker NOT AVAILABLE: ${msg}\n`);
      return { harness: null, dockerSkipped: true };
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  // From here the container is up: ANY failure (migrations, seeding, module
  // compile, app.init) must tear it down, or the pool/container leaks and later
  // suites go flaky. Track the app so it is closed if it was created.
  let startedApp: INestApplication | undefined;
  try {
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);

    const fakeRedis = new FakeRedis();
    await assertIdempotencyRedisRetains(fakeRedis, "capture-harness");
    const fakeMarker = new FakeMarker();
    const contextGuard = new ConfigurableContextGuard();

    const idempStore = new IdempotencyKeyStore({
      redis: fakeRedis,
      pgWriter: { async insert() {} },
      pgReader: {
        async find() {
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
      SalesService,
      { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
      // PosOperatorSaleAuthGuard is overridden to a no-op below, but Nest still
      // validates the provider graph at compile time — the guard's
      // @Inject(OPERATOR_CONTEXT_RESOLVER) dependency must be resolvable or the
      // whole module fails to build (breaking every harness-importing spec).
      // This stub satisfies the graph; its `resolve` is never called because
      // the guard's canActivate is overridden.
      {
        provide: OPERATOR_CONTEXT_RESOLVER,
        useValue: { resolve: async () => ({ kind: "refused", reason: "device_invalid" }) },
      },
    ];
    if (opts.auditEnqueuer) {
      // Opt-in audit wiring (US6 / T072): RequestIdInterceptor stamps the
      // correlation id, AuditEmitterInterceptor taps each @Auditable route and
      // enqueues one canonical event via the spy. Off by default so existing
      // capture specs are unaffected.
      providers.push(
        { provide: AUDIT_JOB_ENQUEUER, useValue: opts.auditEnqueuer },
        { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
        { provide: APP_INTERCEPTOR, useClass: AuditEmitterInterceptor },
      );
    }

    // The write routes (capture/void/refund) are guarded by
    // PosOperatorSaleAuthGuard (008 Option Y). These capture specs exercise the
    // sale WRITE-PATH, not the auth derivation, so the guard is overridden to a
    // no-op here; req.context is injected by the global ConfigurableContextGuard
    // below. The guard's real Clerk-JWT + attestation auth is covered by its own
    // unit spec (test/auth/pos-operator-sale-auth.guard.unit.spec.ts) and the
    // resolver integration spec.
    const moduleRef = await Test.createTestingModule({
      controllers: [SalesController],
      providers,
    })
      // Write routes (capture/void/refund) use PosOperatorEnvelopeSaleGuard
      // (031 D1+D2); the readSale GET uses PosOperatorAuthGuard +
      // TenantContextGuard. All are overridden to no-ops here — these specs
      // exercise the sale data path, not auth; req.context comes from the
      // global ConfigurableContextGuard. Auth + the G-4 live predicate are
      // covered by the guard/resolver unit specs + the sale-auth integration
      // spec.
      .overrideGuard(PosOperatorEnvelopeSaleGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PosOperatorAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(TenantContextGuard)
      .useValue({ canActivate: () => true })
      // ADR-0009 (PR #600) added @UseGuards(…, PosWriteRateLimitGuard) to the
      // capture/void/refund routes. Nest constructs the real guard unless it is
      // overridden, and the real guard's `RateLimiter` dependency is not in this
      // hand-rolled provider graph — so without this override the whole module
      // fails to build (`Nest can't resolve … PosWriteRateLimitGuard`), which is
      // what broke every POS-write integration suite on main. These specs
      // exercise the sale data path, not rate-limiting (covered by the guard's
      // own unit spec), so a no-op override is correct.
      .overrideGuard(PosWriteRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const app = moduleRef.createNestApplication({ bufferLogs: true });
    startedApp = app;
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalGuards(contextGuard);
    await app.init();

    const harness: CaptureHarness = {
      env,
      app,
      fakeRedis,
      contextGuard,
      http: () => request(app.getHttpServer()),
    };
    return { harness, dockerSkipped: false };
  } catch (err) {
    // Startup failed after the container came up — close the app if it was
    // created, then stop the container/pool so the next suite starts clean.
    if (startedApp) await startedApp.close().catch(() => undefined);
    await stopPgEnv(env).catch(() => undefined);
    throw err;
  }
}

export async function stopCaptureHarness(h: HarnessHandle): Promise<void> {
  if (h.harness) {
    await h.harness.app.close();
    await stopPgEnv(h.harness.env);
  }
}

/** Reset per-test context + redis. */
export function resetHarness(h: HarnessHandle): void {
  if (!h.harness) return;
  h.harness.fakeRedis.clear();
  h.harness.contextGuard.tenantId = TENANT_A;
  h.harness.contextGuard.storeId = STORE_A_X;
  h.harness.contextGuard.userId = DEVICE_USER_ID;
  h.harness.contextGuard.anonymous = false;
}

/** A valid 2-line capture request body matching the OpenAPI CaptureSaleRequest. */
export function captureBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // 008 Option Y — device attestation rides in the X-Device-Attestation
    // HEADER, never the body (kept out of payload_hash + idempotency). The
    // sale-auth guard is no-op'd in this harness, so no header is needed here.
    sourceSystem: "pos-1",
    externalId: "ext-cap-001",
    currencyCode: "USD",
    posTotal: "12.5000",
    occurredAt: "2026-05-01T10:00:00.000Z",
    lines: [
      {
        lineName: "Widget",
        unitPrice: "5.0000",
        currencyCode: "USD",
        quantity: "1",
        lineAmount: "5.0000",
        unit: "ea",
      },
      {
        lineName: "Gadget",
        unitPrice: "7.5000",
        currencyCode: "USD",
        quantity: "1",
        lineAmount: "7.5000",
        unit: "ea",
      },
    ],
    ...overrides,
  };
}

/** A valid recordVoid body (008 Option Y — attestation is a header, not body). */
export function voidBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId: "void-evt-001",
    ...overrides,
  };
}

/** A valid recordRefund body (008 Option Y — attestation is a header, not body). */
export function refundBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId: "refund-evt-001",
    posRefundAmount: "5.0000",
    currencyCode: "USD",
    ...overrides,
  };
}
