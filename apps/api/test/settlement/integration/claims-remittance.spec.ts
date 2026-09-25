/**
 * claims-remittance.spec.ts — 035 T032 integration (WSL Testcontainers).
 *
 * The authoritative DB gate for claim submission + remittance reconciliation.
 * Mirrors the T030/T031 harness. Each case opens a fresh receivable via the
 * intent route, then drives claims/reconciliation through the Console routes.
 *
 * Routes under test (settlement.yaml):
 *   POST /api/v1/settlement/claims                              (submit, 201)
 *   POST /api/v1/settlement/claims/:claimRef/reconcile-remittance (200)
 *
 * Sub-cases:
 *   §1 submit claim → 201; receivable(s) → 'claimed'.
 *   §2 submit with an unknown payer → 404; with a non-claimable / unknown
 *      receivable → 409.
 *   §3 reconcile full remittance → settled, variance 0; receivable settled.
 *   §4 reconcile partial → partial, positive variance; receivable stays claimed.
 *   §5 reconcile over-remittance → flagged, negative variance; receivable flagged.
 *   §6 reconcile an already-reconciled claim → 409; absent claim → 404.
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
  PAYER_ABSENT,
  seedSettlementFixture,
} from "../__support__/seed-settlement";

const TENANT_A = SETTLEMENT_FIXTURE_IDS.tenantA;
const TENANT_B = SETTLEMENT_FIXTURE_IDS.tenantB;
const STORE_A_X = SETTLEMENT_FIXTURE_IDS.storeAX;
const ACTOR_A = SETTLEMENT_FIXTURE_IDS.actorA;

const INTENT_URL = "/api/v1/settlement/settlement-intent";
const CLAIMS_URL = "/api/v1/settlement/claims";
const reconcileUrl = (ref: string) => `${CLAIMS_URL}/${ref}/reconcile-remittance`;
const ABSENT_CLAIM = "0f000000-0000-7000-8000-0000000c1a1f";

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
      console.warn(`\n[claims-remittance.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
  // Tear down children → parents to respect FKs; keep cases independent.
  await env.admin.query(
    `DELETE FROM reconciliation_result WHERE claim_id IN
       (SELECT id FROM claim WHERE store_id = $1)`,
    [STORE_A_X],
  );
  await env.admin.query(
    `DELETE FROM remittance WHERE claim_id IN
       (SELECT id FROM claim WHERE store_id = $1)`,
    [STORE_A_X],
  );
  await env.admin.query(`DELETE FROM claim_receivables WHERE store_id = $1`, [STORE_A_X]);
  await env.admin.query(`DELETE FROM claim WHERE store_id = $1`, [STORE_A_X]);
  await env.admin.query(`DELETE FROM receivable WHERE sale_id = $1`, [SALE_A]);
});

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[claims-remittance.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

/** Open one receivable for `owed` and return its ref. */
async function openReceivable(owed: string, keySuffix: string): Promise<string> {
  const res = await http()
    .post(INTENT_URL)
    .set("Idempotency-Key", idempKey("o" + keySuffix))
    .send({ saleRef: SALE_A, payers: [{ payerRef: PAYER_A_STORE, owedAmount: owed }] });
  expect(res.status).toBe(201);
  return res.body.receivables[0].receivableRef;
}

/** Submit a claim over the given receivable refs; return claimRef. */
async function submitClaim(refs: string[], keySuffix: string): Promise<string> {
  const res = await http()
    .post(CLAIMS_URL)
    .set("Idempotency-Key", idempKey("c" + keySuffix))
    .send({ payerRef: PAYER_A_STORE, receivableRefs: refs });
  expect(res.status).toBe(201);
  return res.body.claimRef;
}

describe("035 T032 §1 — submit claim", () => {
  it("submits a claim and transitions the receivable → 'claimed'", async () => {
    if (maybeSkip() || !env) return;
    const ref = await openReceivable("120.00", "1");
    const res = await http()
      .post(CLAIMS_URL)
      .set("Idempotency-Key", idempKey("c1"))
      .send({ payerRef: PAYER_A_STORE, receivableRefs: [ref] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("submitted");
    expect(res.body.receivableRefs).toEqual([ref]);
    const r = await env.admin.query<{ state: string }>(
      `SELECT state FROM receivable WHERE id = $1`,
      [ref],
    );
    expect(r.rows[0]?.state).toBe("claimed");
  });
});

describe("035 T032 §2 — submit conflicts", () => {
  it("unknown payer → 404", async () => {
    if (maybeSkip()) return;
    const ref = await openReceivable("100.00", "2a");
    const res = await http()
      .post(CLAIMS_URL)
      .set("Idempotency-Key", idempKey("c2a"))
      .send({ payerRef: PAYER_ABSENT, receivableRefs: [ref] });
    expect(res.status).toBe(404);
  });

  it("an unknown receivable in the batch → 409", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(CLAIMS_URL)
      .set("Idempotency-Key", idempKey("c2b"))
      .send({ payerRef: PAYER_A_STORE, receivableRefs: [ABSENT_CLAIM] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
  });

  it("an already-claimed receivable is not re-claimable → 409", async () => {
    if (maybeSkip()) return;
    const ref = await openReceivable("100.00", "2c");
    await submitClaim([ref], "2c");
    const res = await http()
      .post(CLAIMS_URL)
      .set("Idempotency-Key", idempKey("c2c2"))
      .send({ payerRef: PAYER_A_STORE, receivableRefs: [ref] });
    expect(res.status).toBe(409);
  });

  it("a receivable owed by a DIFFERENT payer than the claim → 409 (Codex P2)", async () => {
    if (maybeSkip()) return;
    // Open a receivable owed by the tenant-wide payer, then try to claim it
    // under the store payer — the claim must reject the ownership mismatch.
    const res0 = await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("o2d"))
      .send({ saleRef: SALE_A, payers: [{ payerRef: PAYER_A_TENANT, owedAmount: "50.00" }] });
    expect(res0.status).toBe(201);
    const ref = res0.body.receivables[0].receivableRef;
    const res = await http()
      .post(CLAIMS_URL)
      .set("Idempotency-Key", idempKey("c2d"))
      .send({ payerRef: PAYER_A_STORE, receivableRefs: [ref] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
  });
});

describe("035 T032 §3 — full remittance", () => {
  it("settles the claim + receivable, variance 0", async () => {
    if (maybeSkip() || !env) return;
    const ref = await openReceivable("120.00", "3");
    const claimRef = await submitClaim([ref], "3");
    const res = await http()
      .post(reconcileUrl(claimRef))
      .set("Idempotency-Key", idempKey("r3"))
      .send({ remittedAmount: "120.00" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("settled");
    expect(res.body.variance).toMatch(/^0(\.0+)?$/);
    const r = await env.admin.query<{ state: string }>(
      `SELECT state FROM receivable WHERE id = $1`,
      [ref],
    );
    expect(r.rows[0]?.state).toBe("settled");
  });
});

describe("035 T032 §4 — partial remittance", () => {
  it("records positive variance, receivable stays claimed", async () => {
    if (maybeSkip() || !env) return;
    const ref = await openReceivable("120.00", "4");
    const claimRef = await submitClaim([ref], "4");
    const res = await http()
      .post(reconcileUrl(claimRef))
      .set("Idempotency-Key", idempKey("r4"))
      .send({ remittedAmount: "90.00" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("partial");
    expect(res.body.variance).toMatch(/^30(\.0+)?$/);
    const r = await env.admin.query<{ state: string; outstanding_balance: string }>(
      `SELECT state, outstanding_balance FROM receivable WHERE id = $1`,
      [ref],
    );
    expect(r.rows[0]?.state).toBe("claimed");
    // Codex #581 P1: the BALANCE must drop by the remitted 90 → 30 remains
    // (the remaining-balance-plus-variance contract), not stay at 120.
    expect(r.rows[0]?.outstanding_balance).toMatch(/^30(\.0+)?$/);
  });

  it("FIFO-apportions a partial remittance across multiple claimed receivables", async () => {
    if (maybeSkip() || !env) return;
    // Two receivables (40 + 80 = 120 claimed); remit 50 → first fully (40),
    // second partially (10) under FIFO-by-id; total remaining 70 = variance.
    const refA = await openReceivable("40.00", "4ma");
    const refB = await openReceivable("80.00", "4mb");
    const claimRef = await submitClaim([refA, refB], "4m");
    const res = await http()
      .post(reconcileUrl(claimRef))
      .set("Idempotency-Key", idempKey("r4m"))
      .send({ remittedAmount: "50.00" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("partial");
    expect(res.body.variance).toMatch(/^70(\.0+)?$/);
    const rows = await env.admin.query<{ id: string; outstanding_balance: string }>(
      `SELECT id, outstanding_balance FROM receivable WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[refA, refB]],
    );
    // Sum of remaining balances must equal the variance (70), regardless of split.
    const total = rows.rows.reduce((acc, r) => acc + Number(r.outstanding_balance), 0);
    expect(total).toBeCloseTo(70, 4);
  });
});

describe("035 T032 §5 — over-remittance", () => {
  it("flags the claim + receivable, negative variance", async () => {
    if (maybeSkip() || !env) return;
    const ref = await openReceivable("100.00", "5");
    const claimRef = await submitClaim([ref], "5");
    const res = await http()
      .post(reconcileUrl(claimRef))
      .set("Idempotency-Key", idempKey("r5"))
      .send({ remittedAmount: "130.00" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("flagged");
    expect(res.body.variance).toMatch(/^-30(\.0+)?$/);
    const r = await env.admin.query<{ state: string; outstanding_balance: string }>(
      `SELECT state, outstanding_balance FROM receivable WHERE id = $1`,
      [ref],
    );
    expect(r.rows[0]?.state).toBe("flagged");
    // Codex #581 P1: over-remittance means the debt is fully paid → balance 0,
    // not left at 100.
    expect(r.rows[0]?.outstanding_balance).toMatch(/^0(\.0+)?$/);
  });
});

describe("035 T032 §6 — reconcile conflicts", () => {
  it("reconciling an already-reconciled claim → 409", async () => {
    if (maybeSkip()) return;
    const ref = await openReceivable("100.00", "6");
    const claimRef = await submitClaim([ref], "6");
    const first = await http()
      .post(reconcileUrl(claimRef))
      .set("Idempotency-Key", idempKey("r6a"))
      .send({ remittedAmount: "100.00" });
    expect(first.status).toBe(200);
    const again = await http()
      .post(reconcileUrl(claimRef))
      .set("Idempotency-Key", idempKey("r6b"))
      .send({ remittedAmount: "1.00" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("conflict");
  });

  it("reconciling an absent claim → 404", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(reconcileUrl(ABSENT_CLAIM))
      .set("Idempotency-Key", idempKey("r6c"))
      .send({ remittedAmount: "10.00" });
    expect(res.status).toBe(404);
  });
});
