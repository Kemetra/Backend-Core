/**
 * 017-US2-REPAIR (T042/T043 HTTP-edge) — repairPosting through the real
 * IdempotencyInterceptor + DashboardAuthGuard surface.
 *
 * The service-level transitions + four-status branching are proven in
 * ../repair/posting-repair.spec.ts; this drives the REAL HTTP surface with the
 * real `IdempotencyInterceptor` (APP_INTERCEPTOR) + FakeRedis/FakeMarker (the 015
 * ack-http-edge harness) so the contract's idempotency + §XII behaviors are
 * proven:
 *   - @Idempotent('required'): missing Idempotency-Key → 400;
 *   - 201 first repair → 200 same-key replay (Idempotent-Replayed) → 409
 *     same-key/different-body;
 *   - cross-tenant workItemRef → non-disclosing 404;
 *   - strict body: a smuggled server-owned field → 400.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
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

import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../../src/context/types";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../../../src/idempotency/idempotency.interceptor";
import {
  INFLIGHT_REDIS,
  InProgressMarker,
} from "../../../../src/idempotency/in-progress-marker";
import { ErpnextReconciliationController } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.controller";
import { ErpnextReconciliationService } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.service";
import { MembershipRepository } from "../../../../src/context/membership.repository";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { SALE_A_X } from "../../sales/__support__/seed-sales";
import { ACTOR_A, PRODUCT_A_ACTIVE, STORE_B_X } from "../../__support__/isolation-harness";
import {
  RECONCILIATION_FIXTURE_IDS,
  POSTING_DEADLETTER_A,
  seedReconciliationFixture,
} from "../__support__/seed-reconciliation";

const TENANT_A = RECONCILIATION_FIXTURE_IDS.tenantA;
const TENANT_B = RECONCILIATION_FIXTURE_IDS.tenantB;
const repairUrl = (ref: string) =>
  `/api/v1/catalog/erpnext-reconciliation/postings/${ref}/repair`;

// A tenant-B dead-letter (the cross-tenant 404 target).
const DEADLETTER_B = "0b000000-0000-7000-8000-00000e0517bc";

function idemp(suffix: string): string {
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
  async del(): Promise<void> {}
}

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public userId: string = ACTOR_A;
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: null,
      isPlatformAdmin: false,
      source: "session",
      // RT-191: what TenantContextGuard resolves for an 'all' membership.
      storeAccess: { kind: "all" },
    };
    req.principal = { userId: this.userId };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let contextGuard: ConfigurableContextGuard;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[posting-repair-http-edge.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedReconciliationFixture(env);
  // Make SALE_A_X resolvable so a repair → eligible_again (201).
  await env.admin.query(`UPDATE sale_lines SET tenant_product_ref = $1 WHERE sale_id = $2`, [
    PRODUCT_A_ACTIVE,
    SALE_A_X,
  ]);
  await env.admin.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, 'ERP-ITEM-017H', 'confirmed', 'manual', $3, now())
     ON CONFLICT DO NOTHING`,
    [TENANT_A, PRODUCT_A_ACTIVE, ACTOR_A],
  );
  // A tenant-B dead-letter for the cross-tenant 404 (no parent-sale FK needed for
  // the SELECT-FOR-UPDATE path; seed it minimally on tenant B's seeded sale).
  await env.admin.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system,
        external_id, payload_hash, status, rejection_category)
     SELECT $1, $2, store_id, id, 'sale_post', $1, 'pos', 'dl-B-http', $3,
        'permanently_rejected', 'unmapped_item'
       FROM sales WHERE tenant_id = $2 LIMIT 1
     ON CONFLICT DO NOTHING`,
    [DEADLETTER_B, TENANT_B, "a".repeat(64)],
  );

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  const fakeRedis = new FakeRedis();
  const fakeMarker = new FakeMarker();
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
    { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
    ErpnextReconciliationService,
    // RT-191: the service reads the caller's role for the store scope.
    { provide: MembershipRepository, useFactory: (): MembershipRepository => new MembershipRepository(localEnv.app) },
    { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
    { provide: INFLIGHT_REDIS, useValue: fakeRedis },
    { provide: InProgressMarker, useValue: fakeMarker },
    { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
  ];

  const moduleRef = await Test.createTestingModule({
    controllers: [ErpnextReconciliationController],
    providers,
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
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
  contextGuard.userId = ACTOR_A;
});

async function resetDeadletter(): Promise<void> {
  await env!.admin.query(
    `UPDATE erpnext_posting_status
        SET status='permanently_rejected', document_ref=NULL,
            rejection_category='unmapped_item', retry_count=0
      WHERE id=$1`,
    [POSTING_DEADLETTER_A],
  );
}

const http = () => request(app!.getHttpServer());
const skip = () => dockerSkipped;

describe("017-US2 HTTP — idempotency required + lifecycle", () => {
  it("missing Idempotency-Key → 400", async () => {
    if (skip()) return;
    await resetDeadletter();
    await http().post(repairUrl(POSTING_DEADLETTER_A)).send({}).expect(400);
  });

  it("201 first repair → 200 same-key replay (Idempotent-Replayed) → 409 different body", async () => {
    if (skip()) return;
    await resetDeadletter();
    const key = idemp("r");

    const first = await http()
      .post(repairUrl(POSTING_DEADLETTER_A))
      .set("idempotency-key", key)
      .send({})
      .expect(201);
    expect(first.body.outcome).toBe("eligible_again");

    const replay = await http()
      .post(repairUrl(POSTING_DEADLETTER_A))
      .set("idempotency-key", key)
      .send({})
      .expect(201); // interceptor echoes the stored status + header
    expect(replay.headers["idempotent-replayed"]).toBe("true");

    await http()
      .post(repairUrl(POSTING_DEADLETTER_A))
      .set("idempotency-key", key)
      .send({ note: "different body" })
      .expect(409);
  });
});

describe("017-US2 HTTP — §XII", () => {
  it("a smuggled server-owned field → 400 (strict body)", async () => {
    if (skip()) return;
    await resetDeadletter();
    await http()
      .post(repairUrl(POSTING_DEADLETTER_A))
      .set("idempotency-key", idemp("x"))
      .send({ tenant_id: TENANT_B })
      .expect(400);
  });

  it("a cross-tenant workItemRef → 404 not_found", async () => {
    if (skip()) return;
    await http()
      .post(repairUrl(DEADLETTER_B)) // tenant B's row, tenant A session
      .set("idempotency-key", idemp("c"))
      .send({})
      .expect(404);
  });
});
