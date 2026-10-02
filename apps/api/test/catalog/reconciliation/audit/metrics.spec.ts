/**
 * T650 — 005-WAVE2-METRICS — reconciliation counter-increment emission.
 *
 * Spec anchors: FR-081 (resolved counter), FR-043 (duplicate-alias counter).
 *
 * Acceptance (slice 005-WAVE2-METRICS validation contract):
 *   GREEN — counters increment at their Wave 2 emission sites:
 *     (a) successful link       → unknown_item_resolved_total{action='linked'}
 *     (b) successful create-new → unknown_item_resolved_total{action='created'}
 *     (c) alias-conflict reject → catalog_duplicate_alias_conflict_total
 *
 * TDD note (GREEN-on-arrival for a + b): the `linked` and `created` increment
 * call sites were added by the LINK-HAPPY / CREATE-HAPPY / AUDIT slices
 * (reconciliation.service.ts `recordUnknownItemResolved({ action })` on the
 * `ok` branches). So assertions (a) and (b) pass immediately — this spec pins
 * them against regression. Only (c) `catalog_duplicate_alias_conflict_total`
 * is genuinely new in T651 (it was the deferred `it.todo` from CREATE-EDGES
 * T633(e) and the `it.todo` in the conflict specs). This GREEN-on-arrival
 * framing mirrors how the Wave 1 metrics spec (T552) documented its already-
 * wired capture/mismatch counters.
 *
 * Counter-observation strategy:
 *   The OTel Meter from getMeter("api") is a no-op until a MetricReader is
 *   registered, so direct meter inspection yields no numeric values in tests.
 *   We spy on the emission helpers in api.metrics.ts — the established Wave 1
 *   pattern (metrics.spec.ts T552). The spy intercepts the helper call BEFORE
 *   the no-op meter, counting emissions without a live MetricReader.
 *
 * Harness: ReconciliationController + ReconciliationService against
 * Testcontainers Postgres 16. PG_POOL bound to localEnv.admin (RLS-bypassed)
 * — this spec asserts counter emission, not RLS plumbing; the data-path RLS
 * coverage lives in the link/create happy-path specs. AuditEmitterInterceptor
 * + SpyAuditEnqueuer present so the service's post-transaction audit emit has
 * a sink. Honors MIGRATION_TEST_ALLOW_SKIP=1.
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
import { PG_POOL } from "../../../../src/auth/auth.module";
import type { ResolvedContext } from "../../../../src/context/types";
import { ReconciliationController } from "../../../../src/catalog/reconciliation/reconciliation.controller";
import { ReconciliationService } from "../../../../src/catalog/reconciliation/reconciliation.service";

import * as apiMetrics from "../../../../src/observability/metrics/api.metrics";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
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
  PRODUCT_A_ACTIVE,
} from "../../__support__/isolation-harness";

// ---------------------------------------------------------------------------
// Fixture constants (hex-only UUID literals)
// ---------------------------------------------------------------------------

// Link-success item.
const UNK_T650_LINK = "0a000000-0000-7000-8000-00000650a001";
const UNK_T650_LINK_CORR = "0a000000-0000-7000-8000-000006500c01";
const T650_LINK_BARCODE = "T650-LINK-001";

// Create-success item.
const UNK_T650_CREATE = "0a000000-0000-7000-8000-00000650a002";
const UNK_T650_CREATE_CORR = "0a000000-0000-7000-8000-000006500c02";
const T650_CREATE_BARCODE = "T650-CREATE-001";

// Alias-conflict item: store-scoped alias on STORE_A_X bound to PRODUCT_A_ACTIVE
// + a pending item sharing that identifier, so a link to PRODUCT_A_ACTIVE
// collides on the store-scoped unique index (FR-040).
const UNK_T650_CONFLICT = "0a000000-0000-7000-8000-00000650a003";
const UNK_T650_CONFLICT_CORR = "0a000000-0000-7000-8000-000006500c03";
const T650_CONFLICT_BARCODE = "T650-CONFLICT-001";
const ALIAS_T650_SCOPED = "0a000000-0000-7000-8000-000006500a01";

// Create-path conflict: a second pending item sharing the SAME store-scoped
// barcode as the alias above. Creating a new product from it tries to insert
// a colliding alias -> 23505 -> alias_conflict (FR-062), exercising the
// duplicate-alias counter on the create path (symmetric to the link case).
const UNK_T650_CREATE_CONFLICT = "0a000000-0000-7000-8000-00000650a004";
const UNK_T650_CREATE_CONFLICT_CORR = "0a000000-0000-7000-8000-000006500c04";

const TENANT_A_ADMIN_USER = "0a000000-0000-7000-8000-000006500001";

const LINK_URL = (id: string) => `/api/v1/catalog/unknown-items/${id}/link`;
const CREATE_URL = (id: string) =>
  `/api/v1/catalog/unknown-items/${id}/create-product`;

// ---------------------------------------------------------------------------
// SpyAuditEnqueuer
// ---------------------------------------------------------------------------

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.calls.push(payload);
  }
  reset(): void {
    this.calls = [];
  }
}

// ---------------------------------------------------------------------------
// ConfigurableContextGuard
// ---------------------------------------------------------------------------

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string | null = STORE_A_X;
  public userId: string = TENANT_A_ADMIN_USER;

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

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let contextGuard: ConfigurableContextGuard;
let auditSpy: SpyAuditEnqueuer;
let dockerSkipped = false;

// Per-test metric spies + counters.
let resolvedSpy: jest.SpyInstance;
let duplicateSpy: jest.SpyInstance;
let resolvedCalls: Array<{ action: string }> = [];
let duplicateCount = 0;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T650 metrics.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Two pending items (link + create cases).
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES
       ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5),
       ($6, $2, $3, 'barcode', $7, NULL, 'pending', $8)
     ON CONFLICT DO NOTHING`,
    [
      UNK_T650_LINK, TENANT_A, STORE_A_X, T650_LINK_BARCODE, UNK_T650_LINK_CORR,
      UNK_T650_CREATE, T650_CREATE_BARCODE, UNK_T650_CREATE_CORR,
    ],
  );

  // Store-scoped alias + conflicting pending item (alias_conflict case).
  await env.admin.query(
    `INSERT INTO product_aliases
       (id, tenant_id, product_id, identifier_type, value,
        source_system, store_id, created_by)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, $5, $6)
     ON CONFLICT DO NOTHING`,
    [
      ALIAS_T650_SCOPED, TENANT_A, PRODUCT_A_ACTIVE, T650_CONFLICT_BARCODE,
      STORE_A_X, TENANT_A_ADMIN_USER,
    ],
  );
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES
       ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5),
       ($6, $2, $3, 'barcode', $4, NULL, 'pending', $7)
     ON CONFLICT DO NOTHING`,
    [
      UNK_T650_CONFLICT, TENANT_A, STORE_A_X, T650_CONFLICT_BARCODE,
      UNK_T650_CONFLICT_CORR,
      UNK_T650_CREATE_CONFLICT, UNK_T650_CREATE_CONFLICT_CORR,
    ],
  );

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  auditSpy = new SpyAuditEnqueuer();
  const reflector = new Reflector();
  const auditInterceptor = new AuditEmitterInterceptor(reflector, auditSpy);

  const moduleRef = await Test.createTestingModule({
    controllers: [ReconciliationController],
    providers: [
      // admin pool — this spec asserts counter emission, not RLS plumbing
      // (mirrors Wave 1 metrics.spec.ts:270 rationale).
      { provide: PG_POOL, useFactory: (): Pool => localEnv.admin },
      ReconciliationService,
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
      { provide: APP_INTERCEPTOR, useValue: auditInterceptor },
    ],
  })
    // Real DashboardAuthGuard + TenantContextGuard + RolesGuard are wired
    // class-level / per-method on the controller as of the auth-guard wiring
    // slice. Tests inject context via the global ConfigurableContextGuard
    // (registered below); override the production guards with no-op
    // pass-throughs so the global guard's context survives to the handler.
    .overrideGuard(DashboardAuthGuard).useValue({ canActivate: () => true })
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

beforeEach(() => {
  if (dockerSkipped) return;

  resolvedCalls = [];
  duplicateCount = 0;

  resolvedSpy = jest
    .spyOn(apiMetrics, "recordUnknownItemResolved")
    .mockImplementation((attrs) => {
      resolvedCalls.push(attrs);
    });
  duplicateSpy = jest
    .spyOn(apiMetrics, "recordDuplicateAliasConflict")
    .mockImplementation(() => {
      duplicateCount += 1;
    });

  auditSpy.reset();
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = STORE_A_X;
  contextGuard.userId = TENANT_A_ADMIN_USER;
});

afterEach(async () => {
  resolvedSpy?.mockRestore();
  duplicateSpy?.mockRestore();

  if (dockerSkipped || !env) return;
  // Reset the link + create items to pending so the suite is order-independent,
  // and scrub any product/alias the create path committed.
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status = 'pending', resolution_action = NULL,
            resolved_at = NULL, resolved_by = NULL, resolved_product_id = NULL
      WHERE id = ANY($1)`,
    [[UNK_T650_LINK, UNK_T650_CREATE]],
  );
  await env.admin.query(
    `DELETE FROM product_aliases WHERE tenant_id = $1 AND value = $2`,
    [TENANT_A, T650_CREATE_BARCODE],
  );
  await env.admin.query(
    `DELETE FROM tenant_products WHERE tenant_id = $1 AND name = 'Widget T650'`,
    [TENANT_A],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("T650 / 005-WAVE2-METRICS — reconciliation counter emission [FR-081, FR-043]", () => {
  it("(a) successful link increments unknown_item_resolved_total{action='linked'}", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post(LINK_URL(UNK_T650_LINK))
      .send({ product_id: PRODUCT_A_ACTIVE });
    expect(res.status).toBe(200);

    await drainMicrotasks();

    expect(resolvedSpy).toHaveBeenCalledWith({ action: "linked" });
    expect(resolvedCalls).toEqual([{ action: "linked" }]);
    // A clean link is not an alias conflict.
    expect(duplicateCount).toBe(0);
  });

  it("(b) successful create-new increments unknown_item_resolved_total{action='created'}", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post(CREATE_URL(UNK_T650_CREATE))
      .send({ name: "Widget T650", tax_category: "standard" });
    expect(res.status).toBe(201);

    await drainMicrotasks();

    expect(resolvedSpy).toHaveBeenCalledWith({ action: "created" });
    expect(resolvedCalls).toEqual([{ action: "created" }]);
    expect(duplicateCount).toBe(0);
  });

  it("(c) link alias-conflict increments catalog_duplicate_alias_conflict_total", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post(LINK_URL(UNK_T650_CONFLICT))
      .send({ product_id: PRODUCT_A_ACTIVE });
    expect(res.status).toBe(409);
    expect(res.body?.error?.code).toBe("alias_conflict");

    await drainMicrotasks();

    expect(duplicateSpy).toHaveBeenCalledTimes(1);
    expect(duplicateCount).toBe(1);
    // A rejection is not a resolution — the resolved counter must NOT fire.
    expect(resolvedCalls).toEqual([]);
  });

  it("(d) create-new alias-conflict increments catalog_duplicate_alias_conflict_total", async () => {
    if (dockerSkipped) return;

    // The create path inserts a new product then a colliding alias -> 23505
    // -> alias_conflict (rolled back). Exercises the counter on the create
    // path's discriminator, symmetric to the link case (c).
    const res = await http()
      .post(CREATE_URL(UNK_T650_CREATE_CONFLICT))
      .send({ name: "Widget T650 Conflict", tax_category: "standard" });
    expect(res.status).toBe(409);
    expect(res.body?.error?.code).toBe("alias_conflict");

    await drainMicrotasks();

    expect(duplicateSpy).toHaveBeenCalledTimes(1);
    expect(duplicateCount).toBe(1);
    // The rolled-back create is not a resolution.
    expect(resolvedCalls).toEqual([]);
  });
});
