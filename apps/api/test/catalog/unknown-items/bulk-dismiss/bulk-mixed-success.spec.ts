/**
 * T056 — 007-US8-BULK-DISMISS — Mixed-selection per-item outcomes (RED→GREEN).
 *
 * Spec anchors: FR-044 / FR-070a (decompose into the shipped per-item dismiss;
 * per-item outcomes; one item's failure does not affect siblings), SC-008
 * (bounded selection), SC-005 (same key + body replay is consistent).
 *
 * Route under test: POST /api/v1/catalog/unknown-items/bulk-dismiss
 * operationId: tenantAdminBulkDismissUnknownItems
 *
 * The decisive FR-070a invariant: bulk-dismiss is a UX batching of the SHIPPED
 * per-item dismiss path (UnknownItemsService.dismissUnknownItem) — NOT a new
 * lifecycle write. Each id is dismissed independently; the response carries one
 * BulkDismissOutcome per id ({ id, outcome, details? }) where outcome ∈
 * {dismissed, already_reconciled, not_found}. A non-disclosing not_found for an
 * out-of-scope/absent id must not abort the batch.
 *
 * Sub-cases:
 *   (a) a mixed batch → per-item outcomes in 1:1 correspondence with the input:
 *       in-scope pending → dismissed; resolved → already_reconciled +
 *       details.prior_state=resolved; dismissed → already_reconciled; absent →
 *       not_found. One item's failure does not affect siblings.
 *   (b) each successful dismiss is audited (one unknown_item.dismissed per
 *       dismissed item); already_reconciled / not_found are NOT counted as
 *       dismiss successes.
 *   (c) SC-005: same Idempotency-Key + body replay → identical response, no
 *       additional side effects (the already-dismissed item stays dismissed).
 *
 * Harness: full module with UnknownItemsController + real IdempotencyInterceptor
 * (FakeRedis/FakeMarker). Tenant-wide actor. Docker: Testcontainers Postgres 16.
 * Honors MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { AuditEmitterInterceptor } from "../../../../src/audit/audit-emitter.interceptor";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../../../src/idempotency/idempotency.interceptor";
import {
  INFLIGHT_REDIS,
  InProgressMarker,
} from "../../../../src/idempotency/in-progress-marker";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import { PG_POOL } from "../../../../src/auth/auth.module";
import type { ResolvedContext } from "../../../../src/context/types";
import { UnknownItemsController } from "../../../../src/catalog/unknown-items/unknown-items.controller";
import { UnknownItemsService } from "../../../../src/catalog/unknown-items/unknown-items.service";

import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PosOperatorAuthGuard } from "../../../../src/auth/pos-operator-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  TENANT_A,
  STORE_A_X,
  ACTOR_A,
} from "../../__support__/isolation-harness";
import {
  seedUnknownItemsFixture,
  UNK_005_A_X_BARCODE,
  UNK_007_A_X_DISMISSED,
  UNK_007_A_X_RESOLVED,
} from "../../__support__/seed-unknown-items";

const BULK_DISMISS_URL = "/api/v1/catalog/unknown-items/bulk-dismiss";

/** A syntactically-valid UUID that does not exist in any tenant (→ not_found). */
const ABSENT_ID = "0a000000-0000-7000-8000-0000000a8e01";

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
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

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.calls.push(payload);
  }
  reset(): void {
    this.calls = [];
  }
}

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string | null = null;
  public userId: string = ACTOR_A;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: this.storeId,
      isPlatformAdmin: false,
      source: "session",
      storeAccess: { kind: "all" },
    };
    req.principal = { userId: this.userId };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let fakeRedis: FakeRedis;
let contextGuard: ConfigurableContextGuard;
let auditSpy: SpyAuditEnqueuer;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T056 bulk-mixed-success.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);
  await seedUnknownItemsFixture(env);

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  auditSpy = new SpyAuditEnqueuer();
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

  const reflector = new Reflector();
  const auditInterceptor = new AuditEmitterInterceptor(reflector, auditSpy);
  const idempInterceptor = new IdempotencyInterceptor(
    reflector,
    idempStore,
    fakeMarker as unknown as InProgressMarker,
  );

  const moduleRef = await Test.createTestingModule({
    controllers: [UnknownItemsController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      UnknownItemsService,
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
      { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
      { provide: APP_INTERCEPTOR, useValue: auditInterceptor },
    ],
  })
    .overrideGuard(DashboardAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(PosOperatorAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard).useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
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

beforeEach(async () => {
  if (dockerSkipped || !env) return;
  auditSpy.reset();
  fakeRedis.clear();
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = null;
  contextGuard.userId = ACTOR_A;

  // Reset the in-scope pending fixture to pending so each test dismisses fresh.
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status = 'pending', resolution_action = NULL,
            resolved_at = NULL, resolved_by = NULL, resolved_product_id = NULL
      WHERE id = $1`,
    [UNK_005_A_X_BARCODE],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

function outcomeFor(body: { outcomes: Array<{ id: string; outcome: string; details?: unknown }> }, id: string) {
  return body.outcomes.find((o) => o.id === id);
}

describe("T056 / 007-US8-BULK-DISMISS — mixed per-item outcomes [FR-044, FR-070a, SC-008, SC-005]", () => {
  it("(a) per-item outcomes in 1:1 correspondence; one failure does not affect siblings", async () => {
    if (dockerSkipped) return;

    const ids = [
      UNK_005_A_X_BARCODE, // pending → dismissed
      UNK_007_A_X_RESOLVED, // resolved → already_reconciled + prior_state
      UNK_007_A_X_DISMISSED, // dismissed → already_reconciled
      ABSENT_ID, // absent → not_found (non-disclosing, does not abort batch)
    ];

    const res = await http()
      .post(BULK_DISMISS_URL)
      .set("Idempotency-Key", "bulk-t056-mixed-key-00000001")
      .send({ ids });

    expect(res.status).toBe(200);
    expect(res.body.outcomes).toHaveLength(4);

    expect(outcomeFor(res.body, UNK_005_A_X_BARCODE)?.outcome).toBe("dismissed");
    const resolved = outcomeFor(res.body, UNK_007_A_X_RESOLVED);
    expect(resolved?.outcome).toBe("already_reconciled");
    expect((resolved?.details as { prior_state?: string } | undefined)?.prior_state).toBe("resolved");
    expect(outcomeFor(res.body, UNK_007_A_X_DISMISSED)?.outcome).toBe("already_reconciled");
    expect(outcomeFor(res.body, ABSENT_ID)?.outcome).toBe("not_found");

    // The pending item actually transitioned to dismissed in the DB (the
    // failure of the other three did not roll it back).
    const row = await env!.admin.query<{ resolution_status: string }>(
      `SELECT resolution_status FROM unknown_items WHERE id = $1`,
      [UNK_005_A_X_BARCODE],
    );
    expect(row.rows[0]?.resolution_status).toBe("dismissed");
  });

  it("(b) each successful dismiss is audited; non-dismiss outcomes are not", async () => {
    if (dockerSkipped) return;

    const ids = [UNK_005_A_X_BARCODE, UNK_007_A_X_RESOLVED, ABSENT_ID];

    const res = await http()
      .post(BULK_DISMISS_URL)
      .set("Idempotency-Key", "bulk-t056-audit-key-00000001")
      .send({ ids });
    expect(res.status).toBe(200);

    await drainMicrotasks();

    // Exactly one dismiss audit event — for the single pending item that
    // transitioned. The resolved/absent ids produce no dismiss audit.
    const dismissEvents = auditSpy.calls.filter(
      (ev) => ev.action === "unknown_item.dismissed",
    );
    expect(dismissEvents).toHaveLength(1);
  });

  it("(c) SC-005: same Idempotency-Key + body replay → identical response, no extra side effects", async () => {
    if (dockerSkipped) return;

    const key = "bulk-t056-replay-key-000000001";
    const ids = [UNK_005_A_X_BARCODE, ABSENT_ID];

    const first = await http()
      .post(BULK_DISMISS_URL)
      .set("Idempotency-Key", key)
      .send({ ids });
    expect(first.status).toBe(200);

    const replay = await http()
      .post(BULK_DISMISS_URL)
      .set("Idempotency-Key", key)
      .send({ ids });
    expect(replay.status).toBe(200);
    // Replay returns the prior response verbatim.
    expect(replay.body).toEqual(first.body);

    // The dismissed item stays dismissed — replay produced no second effect.
    const row = await env!.admin.query<{ resolution_status: string }>(
      `SELECT resolution_status FROM unknown_items WHERE id = $1`,
      [UNK_005_A_X_BARCODE],
    );
    expect(row.rows[0]?.resolution_status).toBe("dismissed");
  });

  it("(d) bulkDismiss works with NO audit enqueuer (optional-chaining is safe — CodeRabbit #409 F1)", async () => {
    if (dockerSkipped) return;

    // Construct the service with ONLY the pool — no AUDIT_JOB_ENQUEUER (the
    // posture of the ~15 existing service specs). This proves the optional
    // enqueuer path does NOT throw (the `?.` short-circuits the whole
    // enqueue().catch() chain when undefined — the flagged "throws on
    // undefined" premise is incorrect). It must return outcomes normally.
    const svc = new UnknownItemsService(env!.app);
    const out = await svc.bulkDismissUnknownItems({
      tenantId: TENANT_A,
      storeId: null,
      storeScope: { kind: "tenant" },
      actorUserId: ACTOR_A,
      ids: [UNK_005_A_X_BARCODE, ABSENT_ID],
    });
    expect(out.outcomes).toHaveLength(2);
    expect(out.outcomes.find((o) => o.id === UNK_005_A_X_BARCODE)?.outcome).toBe(
      "dismissed",
    );
    expect(out.outcomes.find((o) => o.id === ABSENT_ID)?.outcome).toBe(
      "not_found",
    );
    // dismissed/not_found omit `details` (optional wire shape, F2).
    expect(
      out.outcomes.find((o) => o.id === UNK_005_A_X_BARCODE),
    ).not.toHaveProperty("details");
  });
});

// ---------------------------------------------------------------------------
// Denial-path: RolesGuard denies → 403, no side effects (CodeRabbit #409 F4).
// Separate module because the main suite overrides RolesGuard to ALLOW; here we
// override it to DENY so the route's @Roles(..., { denyAs: 403 }) is exercised.
// ---------------------------------------------------------------------------
describe("T056 / 007-US8-BULK-DISMISS — RolesGuard denial → 403 [denyAs:403]", () => {
  let denyApp: INestApplication | null = null;
  let denyAudit: SpyAuditEnqueuer;

  beforeAll(async () => {
    if (dockerSkipped || !env) return;
    const localEnv = env;
    denyAudit = new SpyAuditEnqueuer();
    const reflector = new Reflector();
    const auditInterceptor = new AuditEmitterInterceptor(reflector, denyAudit);

    const moduleRef = await Test.createTestingModule({
      controllers: [UnknownItemsController],
      providers: [
        { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
        UnknownItemsService,
        { provide: AUDIT_JOB_ENQUEUER, useValue: denyAudit },
        { provide: APP_INTERCEPTOR, useValue: auditInterceptor },
      ],
    })
      .overrideGuard(DashboardAuthGuard).useValue({ canActivate: () => true })
      .overrideGuard(PosOperatorAuthGuard).useValue({ canActivate: () => true })
      .overrideGuard(TenantContextGuard).useValue({ canActivate: () => true })
      // The role gate DENIES — exercises denyAs:403.
      .overrideGuard(RolesGuard).useValue({ canActivate: () => false })
      .compile();

    denyApp = moduleRef.createNestApplication({ bufferLogs: true });
    denyApp.useGlobalFilters(new GlobalExceptionFilter());
    denyApp.useGlobalGuards(new ConfigurableContextGuard());
    await denyApp.init();
  }, 60_000);

  afterAll(async () => {
    if (denyApp) await denyApp.close();
  }, 30_000);

  it("returns 403 and dismisses nothing when the role gate denies", async () => {
    if (dockerSkipped || !denyApp || !env) return;

    // Ensure the target is pending before the (denied) attempt.
    await env.admin.query(
      `UPDATE unknown_items SET resolution_status='pending', resolution_action=NULL,
          resolved_at=NULL, resolved_by=NULL, resolved_product_id=NULL WHERE id = $1`,
      [UNK_005_A_X_BARCODE],
    );
    denyAudit.reset();

    const res = await request(denyApp.getHttpServer())
      .post(BULK_DISMISS_URL)
      .set("Idempotency-Key", "bulk-t056-deny-key-000000001")
      .send({ ids: [UNK_005_A_X_BARCODE] });

    // denyAs:403 → forbidden (NOT 404 — the batch acts within the resolved tenant).
    expect(res.status).toBe(403);

    // No DB side effect — the pending item is untouched.
    const row = await env.admin.query<{ resolution_status: string }>(
      `SELECT resolution_status FROM unknown_items WHERE id = $1`,
      [UNK_005_A_X_BARCODE],
    );
    expect(row.rows[0]?.resolution_status).toBe("pending");

    // No dismiss audit emitted on the denied path.
    await new Promise((resolve) => setImmediate(resolve));
    expect(denyAudit.calls).toHaveLength(0);
  });
});
