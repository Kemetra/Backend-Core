/**
 * authz-isolation.spec.ts — 035 T033 (cross-cutting isolation + authz sweep).
 *
 * Verifies the settlement surface's tenant/store isolation + non-disclosing
 * refusals against a Testcontainers Postgres, mirroring the T030–T032 harness.
 * Focuses on the ISOLATION invariants (Principle II/XII, FR-022) rather than the
 * happy path:
 *
 *   §I  cross-store payer at intent — a store-A-X intent naming a payer scoped to
 *       store-A-Y (same tenant) must be REJECTED (409), not silently accepted
 *       (Codex #579 P2: payer-scope must respect store, not just tenant).
 *   §II tenant-wide payer is accepted at any store (store_id NULL).
 *   §III same-store payer is accepted.
 *
 * (Credential-surface checks — cookie-on-POS / envelope-on-Console → 401 — are
 * guard-level and covered by the 028 auth-regression suite + the contract spec;
 * here we prove the DATA-path scope, which the overridden-guard harness exercises
 * by driving req.context store/tenant directly.)
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  type Provider,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { IdempotencyKeyStore } from "@data-pulse-2/shared";

import { PG_POOL } from "../../../src/auth/auth.module";
import { DashboardAuthGuard } from "../../../src/auth/dashboard-auth.guard";
import { PosOperatorEnvelopeSaleGuard } from "../../../src/auth/pos-operator-envelope-sale.guard";
import { PosWriteRateLimitGuard } from "../../../src/auth/pos-write-rate-limit.guard";
import { RolesGuard } from "../../../src/auth/roles.guard";
import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { TenantContextGuard } from "../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../src/context/types";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../../src/idempotency/idempotency.interceptor";
import { InProgressMarker } from "../../../src/idempotency/in-progress-marker";
import { SettlementController } from "../../../src/settlement/settlement.controller";
import { ReceivableService } from "../../../src/settlement/receivable.service";
import { ClaimService } from "../../../src/settlement/claim.service";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import {
  SETTLEMENT_FIXTURE_IDS,
  SALE_A,
  PAYER_A_STORE,
  PAYER_A_TENANT,
  PAYER_A_OTHER_STORE,
  seedSettlementFixture,
} from "../__support__/seed-settlement";

const TENANT_A = SETTLEMENT_FIXTURE_IDS.tenantA;
const STORE_A_X = SETTLEMENT_FIXTURE_IDS.storeAX;
const ACTOR_A = SETTLEMENT_FIXTURE_IDS.actorA;

const INTENT_URL = "/api/v1/settlement/settlement-intent";

function idempKey(suffix: string): string {
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

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string | null = STORE_A_X;
  public userId: string | null = ACTOR_A;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
      posDeviceId?: string;
    }>();
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: this.storeId,
      isPlatformAdmin: false,
      source: "token",
    };
    req.posDeviceId = "settlement-test-terminal";
    if (this.userId) req.principal = { userId: this.userId };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let contextGuard: ConfigurableContextGuard;
let fakeRedis: FakeRedis;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[authz-isolation.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedSettlementFixture(env);

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  fakeRedis = new FakeRedis();
  const fakeMarker = new FakeMarker();

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
    { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
    ReceivableService,
    ClaimService,
    { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
    { provide: InProgressMarker, useValue: fakeMarker },
    { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
  ];

  const moduleRef = await Test.createTestingModule({
    controllers: [SettlementController],
    providers,
  })
    .overrideGuard(PosOperatorEnvelopeSaleGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(DashboardAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    // ADR-0009 (PR #600): override PosWriteRateLimitGuard or Nest fails to
    // resolve its RateLimiter dep in this hand-rolled module. Data-path spec.
    .overrideGuard(PosWriteRateLimitGuard)
    .useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(contextGuard);
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  if (dockerSkipped) return;
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = STORE_A_X;
  contextGuard.userId = ACTOR_A;
  fakeRedis.clear();
});

afterEach(async () => {
  if (dockerSkipped || !env) return;
  await env.admin.query(`DELETE FROM receivable WHERE sale_id = $1`, [SALE_A]);
});

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[authz-isolation.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

describe("035 T033 §I — cross-store payer at intent (Codex #579)", () => {
  it("a store-A-X intent naming a store-A-Y-scoped payer is REJECTED (409)", async () => {
    if (maybeSkip()) return;
    // Session store = STORE_A_X (default). The payer is scoped to STORE_A_Y.
    const res = await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("xstore"))
      .send({
        saleRef: SALE_A,
        payers: [{ payerRef: PAYER_A_OTHER_STORE, owedAmount: "10.00" }],
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
  });
});

describe("035 T033 §II — tenant-wide payer accepted at any store", () => {
  it("a store-A-X intent naming a tenant-wide (store_id NULL) payer succeeds", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("tenantwide"))
      .send({
        saleRef: SALE_A,
        payers: [{ payerRef: PAYER_A_TENANT, owedAmount: "10.00" }],
      });
    expect(res.status).toBe(201);
  });
});

describe("035 T033 §III — same-store payer accepted", () => {
  it("a store-A-X intent naming the store-A-X payer succeeds", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("samestore"))
      .send({
        saleRef: SALE_A,
        payers: [{ payerRef: PAYER_A_STORE, owedAmount: "10.00" }],
      });
    expect(res.status).toBe(201);
  });
});
