/**
 * apply-payment.spec.ts — 035 T031 integration (WSL Testcontainers).
 *
 * The authoritative DB gate for cash application (7-C). Mirrors the T030
 * settlement-intent harness (overridden production guards + RLS-active PG_POOL +
 * a real IdempotencyInterceptor with an in-memory store). Each case opens a
 * fresh receivable via the intent route, then applies payment(s) through the
 * Console route.
 *
 * Route under test (settlement.yaml):
 *   POST /api/v1/settlement/receivables/:receivableRef/apply-payment  (200)
 *
 * Sub-cases:
 *   §1 partial application → 200; balance reduced; state 'partially_applied'; version++.
 *   §2 clearing application → 200; balance '0...'; state 'settled'.
 *   §3 over-application (amount > balance) → 409 conflict; no write (balance intact).
 *   §4 stale version → 409 conflict; no write.
 *   §5 idempotent replay (same key + body) → replay; balance reduced exactly once.
 *   §6 cross-tenant / absent receivable ref → non-disclosing 404.
 *   §7 applying to an already-settled receivable → 409 conflict.
 *   §8 non-positive amount ("0" / "0.0000") → 400 validation_error, no write
 *      (bug #580: the regex admitted "0", which passed the over-application check
 *      and hit the `payment_application_amount_positive` CHECK as an uncaught 500).
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
  seedSettlementFixture,
} from "../__support__/seed-settlement";

const TENANT_A = SETTLEMENT_FIXTURE_IDS.tenantA;
const TENANT_B = SETTLEMENT_FIXTURE_IDS.tenantB;
const STORE_A_X = SETTLEMENT_FIXTURE_IDS.storeAX;
const ACTOR_A = SETTLEMENT_FIXTURE_IDS.actorA;

const INTENT_URL = "/api/v1/settlement/settlement-intent";
const applyUrl = (ref: string) => `/api/v1/settlement/receivables/${ref}/apply-payment`;
const ABSENT_REF = "0f000000-0000-7000-8000-0000000a11ce";

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
      console.warn(`\n[apply-payment.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    // ADR-0009 (PR #600): the settlement write route carries
    // @UseGuards(…, PosWriteRateLimitGuard); override it or Nest fails to resolve
    // the real guard's RateLimiter dep in this hand-rolled module. Data-path spec.
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
  // Children first (FK), then the receivables — keep cases independent.
  await env.admin.query(
    `DELETE FROM payment_application WHERE receivable_id IN
       (SELECT id FROM receivable WHERE sale_id = $1)`,
    [SALE_A],
  );
  await env.admin.query(`DELETE FROM receivable WHERE sale_id = $1`, [SALE_A]);
  // Each case reuses the same HTTP key for its fixture receivable. Remove the
  // durable reservation with that fixture so the next case creates a live row.
  await env.admin.query(
    `DELETE FROM idempotency_keys
      WHERE tenant_id=$1 AND client_id=$2 AND key LIKE 'settlement-intent:%'`,
    [TENANT_A, "settlement-test-terminal"],
  );
});

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[apply-payment.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

/** Open one receivable for `owed` and return {ref, version}. */
async function openReceivable(owed: string): Promise<{ ref: string; version: number }> {
  const res = await http()
    .post(INTENT_URL)
    .set("Idempotency-Key", idempKey("open" + owed))
    .send({ saleRef: SALE_A, payers: [{ payerRef: PAYER_A_STORE, owedAmount: owed }] });
  expect(res.status).toBe(201);
  const rec = res.body.receivables[0];
  return { ref: rec.receivableRef, version: rec.version };
}

describe("035 T031 §1 — partial application", () => {
  it("reduces the balance and moves open → partially_applied, version++", async () => {
    if (maybeSkip()) return;
    const { ref, version } = await openReceivable("120.00");
    const res = await http()
      .post(applyUrl(ref))
      .set("Idempotency-Key", idempKey("p1"))
      .send({ amount: "50.00", version });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("partially_applied");
    expect(res.body.outstandingBalance).toMatch(/^70(\.0+)?$/);
    expect(res.body.version).toBe(version + 1);
  });
});

describe("035 T031 §2 — clearing application", () => {
  it("zeroes the balance and settles the receivable", async () => {
    if (maybeSkip()) return;
    const { ref, version } = await openReceivable("120.00");
    const res = await http()
      .post(applyUrl(ref))
      .set("Idempotency-Key", idempKey("p2"))
      .send({ amount: "120.00", version });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("settled");
    expect(res.body.outstandingBalance).toMatch(/^0(\.0+)?$/);
  });
});

describe("035 T031 §3 — over-application", () => {
  it("rejects amount > balance with 409 conflict and writes nothing", async () => {
    if (maybeSkip() || !env) return;
    const { ref, version } = await openReceivable("100.00");
    const res = await http()
      .post(applyUrl(ref))
      .set("Idempotency-Key", idempKey("p3"))
      .send({ amount: "100.01", version });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
    // No write: balance + version intact, no payment_application row.
    const row = await env.admin.query<{ outstanding_balance: string; version: number }>(
      `SELECT outstanding_balance, version FROM receivable WHERE id = $1`,
      [ref],
    );
    expect(row.rows[0]?.version).toBe(version);
    const pa = await env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payment_application WHERE receivable_id = $1`,
      [ref],
    );
    expect(pa.rows[0]?.n).toBe("0");
  });
});

describe("035 T031 §4 — stale version", () => {
  it("rejects a wrong expected version with 409 conflict, no write", async () => {
    if (maybeSkip() || !env) return;
    const { ref, version } = await openReceivable("100.00");
    const res = await http()
      .post(applyUrl(ref))
      .set("Idempotency-Key", idempKey("p4"))
      .send({ amount: "10.00", version: version + 7 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
    const pa = await env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payment_application WHERE receivable_id = $1`,
      [ref],
    );
    expect(pa.rows[0]?.n).toBe("0");
  });
});

describe("035 T031 §5 — idempotent replay", () => {
  it("replays the same key+body and reduces the balance exactly once", async () => {
    if (maybeSkip() || !env) return;
    const { ref, version } = await openReceivable("120.00");
    const key = idempKey("p5");
    const first = await http()
      .post(applyUrl(ref))
      .set("Idempotency-Key", key)
      .send({ amount: "30.00", version });
    expect(first.status).toBe(200);
    const second = await http()
      .post(applyUrl(ref))
      .set("Idempotency-Key", key)
      .send({ amount: "30.00", version });
    expect(second.status).toBe(200);
    // Balance reduced once (90), not twice (60). Exactly one ledger row.
    expect(second.body.outstandingBalance).toMatch(/^90(\.0+)?$/);
    const pa = await env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payment_application WHERE receivable_id = $1`,
      [ref],
    );
    expect(pa.rows[0]?.n).toBe("1");
  });
});

describe("035 T031 §6 — non-disclosing 404", () => {
  it("an absent / out-of-scope receivable ref → 404", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(applyUrl(ABSENT_REF))
      .set("Idempotency-Key", idempKey("p6"))
      .send({ amount: "10.00", version: 0 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("a cross-tenant receivable → 404 (not visible from tenant B)", async () => {
    if (maybeSkip()) return;
    const { ref, version } = await openReceivable("100.00");
    // Switch the session to tenant B — the tenant-A receivable must vanish.
    contextGuard.tenantId = TENANT_B;
    const res = await http()
      .post(applyUrl(ref))
      .set("Idempotency-Key", idempKey("p6b"))
      .send({ amount: "10.00", version });
    expect(res.status).toBe(404);
  });
});

describe("035 T031 §7 — already settled", () => {
  it("applying to a settled receivable → 409 conflict", async () => {
    if (maybeSkip()) return;
    const { ref, version } = await openReceivable("40.00");
    const clear = await http()
      .post(applyUrl(ref))
      .set("Idempotency-Key", idempKey("p7a"))
      .send({ amount: "40.00", version });
    expect(clear.status).toBe(200);
    expect(clear.body.state).toBe("settled");
    const again = await http()
      .post(applyUrl(ref))
      .set("Idempotency-Key", idempKey("p7b"))
      .send({ amount: "1.00", version: clear.body.version });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("conflict");
  });
});

describe("035 T031 §8 — non-positive amount → 400 (bug #580)", () => {
  // A zero / 0.0000 apply is a meaningless no-op write that the DB CHECK
  // `payment_application_amount_positive (applied_amount > 0)` rejects. It MUST
  // be caught at the boundary as a clean 400 validation_error — never reach the
  // service and surface as an uncaught 23514 → 500. This is the apply-payment
  // member of the positive-money family (mirrors owedAmount's existing >0 refine).
  it("amount '0' → 400 validation_error, no ledger row, balance intact", async () => {
    if (maybeSkip() || !env) return;
    const { ref, version } = await openReceivable("100.00");
    const res = await http()
      .post(applyUrl(ref))
      .set("Idempotency-Key", idempKey("p8a"))
      .send({ amount: "0", version });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    // No write: no payment_application row, balance + version untouched.
    const pa = await env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payment_application WHERE receivable_id = $1`,
      [ref],
    );
    expect(pa.rows[0]?.n).toBe("0");
    const row = await env.admin.query<{ outstanding_balance: string; version: number }>(
      `SELECT outstanding_balance, version FROM receivable WHERE id = $1`,
      [ref],
    );
    expect(row.rows[0]?.version).toBe(version);
    expect(row.rows[0]?.outstanding_balance).toMatch(/^100(\.0+)?$/);
  });

  it("amount '0.0000' → 400 validation_error (zero with scale)", async () => {
    if (maybeSkip()) return;
    const { ref, version } = await openReceivable("100.00");
    const res = await http()
      .post(applyUrl(ref))
      .set("Idempotency-Key", idempKey("p8b"))
      .send({ amount: "0.0000", version });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});
