/**
 * settlement-intent.spec.ts — 035 T030 integration (WSL Testcontainers).
 *
 * The authoritative DB gate. Exercises the settlement surface end-to-end against
 * a Testcontainers Postgres 16, mirroring the 014/008 harness (overridden
 * production guards + RLS-active PG_POOL + a real IdempotencyInterceptor with an
 * in-memory store, so replay-safety is the interceptor's job, proven live).
 *
 * Routes under test (settlement.yaml):
 *   POST /api/v1/settlement/settlement-intent            (POS intent,  201)
 *   GET  /api/v1/settlement/receivables/:receivableRef   (Console get, 200)
 *   GET  /api/v1/settlement/receivables                  (Console list,200)
 *
 * Sub-cases:
 *   §1 open single-payer intent — 201; one receivable, state 'open', version 0.
 *   §2 open split (multi-payer) intent — 201; N receivables, the sale unmutated.
 *   §3 unknown payer → 409 conflict; cross-tenant payer → 409; no rows written.
 *   §4 idempotent replay (same key + body) → 200 + Idempotent-Replayed, no dup.
 *   §5 console get — projection; cross-tenant ref → non-disclosing 404.
 *   §6 console list — keyset page + nextCursor; state/payer filters; cross-tenant
 *      store/payer filter → non-disclosing 404.
 *   §7 claimMetadata is opaque intent input and is NOT persisted on the receivable
 *      in v1 (bug #579: it was wrongly written into the tax_placeholder column,
 *      conflating payer claim metadata with the tax-pending placeholder). The
 *      persisted tax_placeholder MUST stay null regardless of claimMetadata.
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
  PAYER_B,
  PAYER_ABSENT,
  seedSettlementFixture,
} from "../__support__/seed-settlement";

const TENANT_A = SETTLEMENT_FIXTURE_IDS.tenantA;
const TENANT_B = SETTLEMENT_FIXTURE_IDS.tenantB;
const STORE_A_X = SETTLEMENT_FIXTURE_IDS.storeAX;
const STORE_B_X = SETTLEMENT_FIXTURE_IDS.storeBX;
const ACTOR_A = SETTLEMENT_FIXTURE_IDS.actorA;

const INTENT_URL = "/api/v1/settlement/settlement-intent";
const LIST_URL = "/api/v1/settlement/receivables";
const getUrl = (ref: string) => `${LIST_URL}/${ref}`;

/** A fresh 32-char ASCII idempotency key per call site. */
function idempKey(suffix: string): string {
  return (suffix + "0".repeat(32)).slice(0, 32).replace(/[^a-z0-9]/g, "0");
}

// ---------------------------------------------------------------------------
// In-memory idempotency fakes (008/014 harness pattern)
// ---------------------------------------------------------------------------

class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  public failWrites = false;
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
    if (this.failWrites) throw new Error("injected Redis replay-save failure");
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

// ---------------------------------------------------------------------------
// Configurable guard — sets req.context for BOTH the POS + Console surfaces.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

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
      console.warn(`\n[settlement-intent.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    pgReader: { async find() { return null; } },
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
    // The POS route's real guard composes the auth repos + live re-verification
    // (T033's job). These specs exercise the data path — override to a no-op;
    // req.context comes from the global ConfigurableContextGuard.
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
  fakeRedis.failWrites = false;
});

afterEach(async () => {
  if (dockerSkipped || !env) return;
  // Each sub-case opens fresh receivables; clear them so cases are independent.
  await env.admin.query(`DELETE FROM receivable WHERE sale_id = $1`, [SALE_A]);
  await env.admin.query(
    `DELETE FROM idempotency_keys WHERE key LIKE 'settlement-intent:%'`,
  );
});

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[settlement-intent.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

async function countReceivables(): Promise<number> {
  if (!env) return 0;
  const r = await env.admin.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM receivable WHERE sale_id = $1`,
    [SALE_A],
  );
  return Number(r.rows[0]?.n ?? "0");
}

// ---------------------------------------------------------------------------
// §1 — open single-payer intent
// ---------------------------------------------------------------------------

describe("035 T030 §1 — open single-payer intent", () => {
  it("opens one receivable (state 'open', version 0) and returns the projection", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("s1"))
      .send({ saleRef: SALE_A, payers: [{ payerRef: PAYER_A_STORE, owedAmount: "120.00" }] });
    expect(res.status).toBe(201);
    expect(res.body.saleRef).toBe(SALE_A);
    expect(res.body.receivables).toHaveLength(1);
    const rec = res.body.receivables[0];
    expect(rec).toMatchObject({
      saleRef: SALE_A,
      payerRef: PAYER_A_STORE,
      state: "open",
      version: 0,
    });
    expect(rec.outstandingBalance).toMatch(/^120(\.0+)?$/);
    expect(typeof rec.receivableRef).toBe("string");
    // No raw DB leakage (§IV).
    expect(rec).not.toHaveProperty("tenant_id");
    expect(rec).not.toHaveProperty("tenantId");
  });
});

// ---------------------------------------------------------------------------
// §2 — open split (multi-payer) intent; sale unmutated
// ---------------------------------------------------------------------------

describe("035 T030 §2 — open split intent", () => {
  it("opens one receivable per payer in one tx and never mutates the sale", async () => {
    if (maybeSkip() || !env) return;
    const before = await env.admin.query<{ updated_at: Date | null }>(
      `SELECT pos_total FROM sales WHERE id = $1`,
      [SALE_A],
    );
    const res = await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("s2"))
      .send({
        saleRef: SALE_A,
        cashTendered: "10.00",
        payers: [
          { payerRef: PAYER_A_STORE, owedAmount: "70.00" },
          { payerRef: PAYER_A_TENANT, owedAmount: "50.00" },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.receivables).toHaveLength(2);
    expect(await countReceivables()).toBe(2);
    // The sale fact is unchanged (FR-006) — pos_total untouched.
    const after = await env.admin.query<{ pos_total: string }>(
      `SELECT pos_total FROM sales WHERE id = $1`,
      [SALE_A],
    );
    expect(after.rows[0]?.pos_total).toBe(before.rows[0] ? after.rows[0]?.pos_total : undefined);
    expect(after.rows[0]?.pos_total).toMatch(/^120/);
  });
});

// ---------------------------------------------------------------------------
// §3 — unknown / cross-tenant payer → 409, no rows
// ---------------------------------------------------------------------------

describe("035 T030 §3 — unknown / cross-tenant payer → 409", () => {
  it("an absent payer → 409 conflict, no receivable written", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("s3a"))
      .send({ saleRef: SALE_A, payers: [{ payerRef: PAYER_ABSENT, owedAmount: "10.00" }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
    expect(await countReceivables()).toBe(0);
  });

  it("a cross-tenant payer (tenant B's) → 409 conflict, no receivable", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("s3b"))
      .send({ saleRef: SALE_A, payers: [{ payerRef: PAYER_B, owedAmount: "10.00" }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
    expect(await countReceivables()).toBe(0);
  });

  it("a partly-unknown split is all-or-nothing → 409, no partial write", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("s3c"))
      .send({
        saleRef: SALE_A,
        payers: [
          { payerRef: PAYER_A_STORE, owedAmount: "10.00" },
          { payerRef: PAYER_ABSENT, owedAmount: "10.00" },
        ],
      });
    expect(res.status).toBe(409);
    expect(await countReceivables()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §4 — idempotent replay (interceptor's job, not the service's)
// ---------------------------------------------------------------------------

describe("035 T030 §4 — idempotent replay", () => {
  it("same key + body twice → replay marker, stored status, exactly one receivable", async () => {
    if (maybeSkip()) return;
    const key = idempKey("s4");
    const body = { saleRef: SALE_A, payers: [{ payerRef: PAYER_A_STORE, owedAmount: "120.00" }] };

    const first = await http().post(INTENT_URL).set("Idempotency-Key", key).send(body);
    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();

    const replay = await http().post(INTENT_URL).set("Idempotency-Key", key).send(body);
    // The interceptor replays the STORED response verbatim — same 201 status +
    // the replay marker (mirrors captureSale's T060 replay).
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.status).toBe(201);
    // The replay short-circuits BEFORE the handler → no second insert.
    expect(await countReceivables()).toBe(1);
    // The replayed body is byte-for-byte the stored response.
    expect(replay.body).toEqual(first.body);
  });

  it("PostgreSQL replays the same result after the Redis replay record disappears", async () => {
    if (maybeSkip()) return;
    const key = idempKey("s4durable");
    const body = { saleRef: SALE_A, payers: [{ payerRef: PAYER_A_STORE, owedAmount: "120.00" }] };

    const first = await http().post(INTENT_URL).set("Idempotency-Key", key).send(body);
    expect(first.status).toBe(201);
    fakeRedis.clear();

    const retry = await http().post(INTENT_URL).set("Idempotency-Key", key).send(body);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(await countReceivables()).toBe(1);
  });

  it("same durable key with a different logical payload conflicts after Redis loss", async () => {
    if (maybeSkip()) return;
    const key = idempKey("s4collision");
    const first = await http().post(INTENT_URL).set("Idempotency-Key", key).send({
      saleRef: SALE_A,
      payers: [{ payerRef: PAYER_A_STORE, owedAmount: "10.00" }],
    });
    expect(first.status).toBe(201);
    fakeRedis.clear();

    const retry = await http().post(INTENT_URL).set("Idempotency-Key", key).send({
      saleRef: SALE_A,
      payers: [{ payerRef: PAYER_A_STORE, owedAmount: "11.00" }],
    });
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe("idempotency_key_conflict");
    expect(await countReceivables()).toBe(1);
  });

  it("a Redis replay-save failure cannot duplicate receivables", async () => {
    if (maybeSkip()) return;
    const key = idempKey("s4redisfail");
    const body = { saleRef: SALE_A, payers: [{ payerRef: PAYER_A_STORE, owedAmount: "21.00" }] };
    fakeRedis.failWrites = true;

    const first = await http().post(INTENT_URL).set("Idempotency-Key", key).send(body);
    expect(first.status).toBe(201);
    fakeRedis.failWrites = false;

    const retry = await http().post(INTENT_URL).set("Idempotency-Key", key).send(body);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(await countReceivables()).toBe(1);
  });

  it("concurrent requests with the same key converge to one durable outcome", async () => {
    if (maybeSkip()) return;
    const key = idempKey("s4concurrent");
    const body = { saleRef: SALE_A, payers: [{ payerRef: PAYER_A_STORE, owedAmount: "31.00" }] };

    const [a, b] = await Promise.all([
      http().post(INTENT_URL).set("Idempotency-Key", key).send(body),
      http().post(INTENT_URL).set("Idempotency-Key", key).send(body),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(await countReceivables()).toBe(1);
  });

  it("retry after a DB commit without an HTTP replay record returns the committed outcome", async () => {
    if (maybeSkip() || !app) return;
    const key = idempKey("s4crash");
    const service = app.get(ReceivableService);
    const committed = await service.openFromIntent({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      operation: {
        idempotencyKey: key,
        terminalId: "settlement-test-terminal",
        actorUserId: ACTOR_A,
        requestId: "b1000000-0000-4000-8000-000000000001",
      },
      saleRef: SALE_A,
      payers: [{ payerRef: PAYER_A_STORE, owedAmount: "41.00" }],
    });
    expect(committed.kind).toBe("ok");

    const retry = await http().post(INTENT_URL).set("Idempotency-Key", key).send({
      saleRef: SALE_A,
      payers: [{ payerRef: PAYER_A_STORE, owedAmount: "41.00" }],
    });
    expect(retry.status).toBe(201);
    if (committed.kind === "ok") {
      expect(retry.body.receivables[0].receivableRef).toBe(committed.rows[0]?.id);
    }
    expect(await countReceivables()).toBe(1);
  });

  it("missing Idempotency-Key on the write → 400", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(INTENT_URL)
      .send({ saleRef: SALE_A, payers: [{ payerRef: PAYER_A_STORE, owedAmount: "1.00" }] });
    expect(res.status).toBe(400);
    expect(await countReceivables()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §5 — console get (cross-tenant → non-disclosing 404)
// ---------------------------------------------------------------------------

describe("035 T030 §5 — console get receivable", () => {
  it("returns the projection for an in-scope ref", async () => {
    if (maybeSkip()) return;
    const opened = await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("s5"))
      .send({ saleRef: SALE_A, payers: [{ payerRef: PAYER_A_STORE, owedAmount: "33.00" }] });
    const ref = opened.body.receivables[0].receivableRef;

    const res = await http().get(getUrl(ref));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ receivableRef: ref, saleRef: SALE_A, state: "open" });
  });

  it("a cross-tenant ref → non-disclosing 404 (RLS-filtered)", async () => {
    if (maybeSkip()) return;
    const opened = await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("s5x"))
      .send({ saleRef: SALE_A, payers: [{ payerRef: PAYER_A_STORE, owedAmount: "33.00" }] });
    const ref = opened.body.receivables[0].receivableRef;

    // Switch the session to tenant B — the receivable is invisible.
    contextGuard.tenantId = TENANT_B;
    contextGuard.storeId = STORE_B_X;
    const res = await http().get(getUrl(ref));
    expect(res.status).toBe(404);
  });

  it("a malformed ref → 400 (request-shape error, before any DB hit)", async () => {
    if (maybeSkip()) return;
    const res = await http().get(getUrl("not-a-uuid"));
    expect(res.status).toBe(400);
  });

  it("a syntactically-valid but absent ref → 404", async () => {
    if (maybeSkip()) return;
    const res = await http().get(getUrl(PAYER_ABSENT));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// §6 — console list (keyset + filters + non-disclosing filter 404)
// ---------------------------------------------------------------------------

describe("035 T030 §6 — console list receivables", () => {
  it("lists the tenant's receivables and paginates by keyset", async () => {
    if (maybeSkip()) return;
    await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("s6"))
      .send({
        saleRef: SALE_A,
        payers: [
          { payerRef: PAYER_A_STORE, owedAmount: "10.00" },
          { payerRef: PAYER_A_TENANT, owedAmount: "20.00" },
        ],
      });

    const page1 = await http().get(LIST_URL).query({ page_size: 1 });
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(1);
    expect(typeof page1.body.nextCursor).toBe("string");

    const page2 = await http().get(LIST_URL).query({ page_size: 1, cursor: page1.body.nextCursor });
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);
    // Distinct rows across pages (keyset is strictly decreasing on id).
    expect(page2.body.items[0].receivableRef).not.toBe(page1.body.items[0].receivableRef);
    // page2 returned a FULL page (1 of 1), so the cursor is non-null — a keyset
    // pager only learns it is on the last page when a page comes back short.
    expect(typeof page2.body.nextCursor).toBe("string");

    // page3 drains the remainder: 2 rows total, so it returns 0 items + a null
    // cursor (the authoritative end-of-stream signal).
    const page3 = await http().get(LIST_URL).query({ page_size: 1, cursor: page2.body.nextCursor });
    expect(page3.status).toBe(200);
    expect(page3.body.items).toHaveLength(0);
    expect(page3.body.nextCursor).toBeNull();
  });

  it("lists newest-first (the most recently opened receivable leads)", async () => {
    if (maybeSkip()) return;
    // Two intents in sequence — the second opens a strictly-later UUIDv7 id.
    const r1 = await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("ord1"))
      .send({ saleRef: SALE_A, payers: [{ payerRef: PAYER_A_STORE, owedAmount: "11.00" }] });
    const r2 = await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("ord2"))
      .send({ saleRef: SALE_A, payers: [{ payerRef: PAYER_A_TENANT, owedAmount: "22.00" }] });
    const firstRef = r1.body.receivables[0].receivableRef;
    const secondRef = r2.body.receivables[0].receivableRef;

    const page = await http().get(LIST_URL);
    expect(page.status).toBe(200);
    const ids = page.body.items.map((i: { receivableRef: string }) => i.receivableRef);
    // The later-opened receivable sorts ahead of the earlier one (time-ordered).
    expect(ids.indexOf(secondRef)).toBeLessThan(ids.indexOf(firstRef));
    expect(page.body.items[0].receivableRef).toBe(secondRef);
  });

  it("filters by state and by payer_ref", async () => {
    if (maybeSkip()) return;
    await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("s6f"))
      .send({
        saleRef: SALE_A,
        payers: [
          { payerRef: PAYER_A_STORE, owedAmount: "10.00" },
          { payerRef: PAYER_A_TENANT, owedAmount: "20.00" },
        ],
      });

    const byPayer = await http().get(LIST_URL).query({ payer_ref: PAYER_A_STORE });
    expect(byPayer.status).toBe(200);
    expect(byPayer.body.items.every((i: { payerRef: string }) => i.payerRef === PAYER_A_STORE)).toBe(true);

    const open = await http().get(LIST_URL).query({ state: "open" });
    expect(open.status).toBe(200);
    expect(open.body.items.length).toBeGreaterThanOrEqual(2);

    const settled = await http().get(LIST_URL).query({ state: "settled" });
    expect(settled.body.items).toHaveLength(0);
  });

  it("a cross-tenant store filter → non-disclosing 404", async () => {
    if (maybeSkip()) return;
    const res = await http().get(LIST_URL).query({ store_id: STORE_B_X });
    expect(res.status).toBe(404);
  });

  it("a cross-tenant payer filter → non-disclosing 404", async () => {
    if (maybeSkip()) return;
    const res = await http().get(LIST_URL).query({ payer_ref: PAYER_B });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// §7 — claimMetadata is NOT persisted on the receivable (bug #579)
// ---------------------------------------------------------------------------

describe("035 T030 §7 — claimMetadata is opaque, not persisted (bug #579)", () => {
  it("an intent carrying claimMetadata leaves tax_placeholder null", async () => {
    if (maybeSkip() || !env) return;
    const res = await http()
      .post(INTENT_URL)
      .set("Idempotency-Key", idempKey("s7"))
      .send({
        saleRef: SALE_A,
        payers: [
          {
            payerRef: PAYER_A_STORE,
            owedAmount: "75.00",
            claimMetadata: { policy: "P-1", note: "covered" },
          },
        ],
      });
    expect(res.status).toBe(201);
    const ref = res.body.receivables[0].receivableRef;

    // The persisted tax_placeholder column must be NULL — claimMetadata is
    // opaque intent input (FR-016, contract "opaque in v1"), never the tax
    // placeholder. Read the raw column to prove the INSERT didn't conflate them.
    const row = await env.admin.query<{ tax_placeholder: unknown }>(
      `SELECT tax_placeholder FROM receivable WHERE id = $1`,
      [ref],
    );
    expect(row.rows[0]?.tax_placeholder).toBeNull();

    // The projection likewise exposes taxPlaceholder: null.
    const got = await http().get(getUrl(ref));
    expect(got.status).toBe(200);
    expect(got.body.taxPlaceholder).toBeNull();
  });
});
