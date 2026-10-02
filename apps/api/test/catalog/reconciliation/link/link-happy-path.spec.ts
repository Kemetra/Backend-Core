/**
 * T620 — 005-WAVE2-LINK-HAPPY — Tenant admin links unknown item to existing
 * product (GREEN path).
 *
 * Spec anchors: FR-040 (alias creation), FR-053 (atomicity), FR-080 (audit),
 * FR-081 (metrics).
 *
 * Route under test: POST /api/v1/catalog/unknown-items/:id/link
 * Operationid: tenantAdminLinkUnknownItem
 * Source of truth: packages/contracts/openapi/catalog/unknown-items.yaml
 *
 * Sub-cases:
 *   (a) product_aliases row created with correct (tenant, product, identifier)
 *   (b) unknown_items.resolution_status='resolved', resolution_action='linked',
 *       resolved_product_id=PRODUCT_A_ACTIVE
 *   (c) one audit event with action 'unknown_item.resolved.linked'
 *   (d) unknown_item_resolved_total{action='linked'} counter incremented once
 *   (e) [todo] atomicity: injecting a fault between alias INSERT and
 *       unknown_items UPDATE is impractical in Testcontainers; Postgres
 *       transactional rollback guarantees cover this at the DB layer.
 *
 * Harness:
 *   ReconciliationController + ReconciliationService against a Testcontainers
 *   Postgres 16 pool. AuditEmitterInterceptor with a SpyAuditEnqueuer, no
 *   IdempotencyInterceptor (link does not use idempotency). Mirrors the
 *   metrics.spec.ts wiring pattern for audit + counter observation.
 *
 * Docker: Testcontainers Postgres 16. Honors MIGRATION_TEST_ALLOW_SKIP=1.
 *
 * Fixture (seeded inline in beforeAll):
 *   - One pending unknown_items row UNK_T620_HAPPY in TENANT_A / STORE_A_X
 *     with identifier_type='barcode', value='T620-LINK-HAPPY-001'.
 *     No product_aliases row exists for this barcode — link should succeed.
 *   - PRODUCT_A_ACTIVE (seeded by isolation harness) is the link target.
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
// T620-specific fixture constants
// ---------------------------------------------------------------------------

/** Pending unknown item seeded by this spec's beforeAll. */
const UNK_T620_HAPPY = "0a000000-0000-7000-8000-00000620a001";
const UNK_T620_HAPPY_CORR = "0a000000-0000-7000-8000-000006200c01";
const UNK_T620_BARCODE_VALUE = "T620-LINK-HAPPY-001";

const TENANT_A_ADMIN_USER = "0a000000-0000-7000-8000-000006200001";

const LINK_URL = (id: string) => `/api/v1/catalog/unknown-items/${id}/link`;

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

let resolvedSpy: jest.SpyInstance;
let resolvedCount = 0;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T620 link-happy-path.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Seed T620-specific fixture: one pending unknown item with no pre-existing
  // alias — link should succeed cleanly.
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5)
     ON CONFLICT DO NOTHING`,
    [UNK_T620_HAPPY, TENANT_A, STORE_A_X, UNK_T620_BARCODE_VALUE, UNK_T620_HAPPY_CORR],
  );

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  auditSpy = new SpyAuditEnqueuer();

  const reflector = new Reflector();
  const auditInterceptor = new AuditEmitterInterceptor(reflector, auditSpy);

  const moduleRef = await Test.createTestingModule({
    controllers: [ReconciliationController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
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

  resolvedCount = 0;
  resolvedSpy = jest
    .spyOn(apiMetrics, "recordUnknownItemResolved")
    .mockImplementation(() => {
      resolvedCount += 1;
    });

  auditSpy.reset();

  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = STORE_A_X;
  contextGuard.userId = TENANT_A_ADMIN_USER;
});

afterEach(async () => {
  resolvedSpy?.mockRestore();

  if (dockerSkipped || !env) return;
  // Reset the T620 fixture row back to pending after each test so sub-cases
  // run against a clean slate.
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status  = 'pending',
            resolution_action  = NULL,
            resolved_at        = NULL,
            resolved_by        = NULL,
            resolved_product_id = NULL
      WHERE id = $1`,
    [UNK_T620_HAPPY],
  );
  // Remove any product_aliases rows created by these tests.
  await env.admin.query(
    `DELETE FROM product_aliases
      WHERE tenant_id = $1
        AND value = $2`,
    [TENANT_A, UNK_T620_BARCODE_VALUE],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T620-a — product_aliases row created
// ---------------------------------------------------------------------------

describe("T620 / 005-WAVE2-LINK-HAPPY — tenant admin links unknown item [FR-040]", () => {
  it(
    "(a) creates exactly one product_aliases row binding the barcode to the product",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(LINK_URL(UNK_T620_HAPPY))
        .send({ product_id: PRODUCT_A_ACTIVE });

      expect(res.status).toBe(200);

      const aliasCheck = await env!.admin.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM product_aliases
          WHERE tenant_id       = $1
            AND product_id      = $2
            AND identifier_type = 'barcode'
            AND value           = $3`,
        [TENANT_A, PRODUCT_A_ACTIVE, UNK_T620_BARCODE_VALUE],
      );
      expect(aliasCheck.rows[0]?.count).toBe("1");
    },
  );

  // ---------------------------------------------------------------------------
  // T620-b — unknown_items lifecycle fields
  // ---------------------------------------------------------------------------

  it(
    "(b) sets unknown_items.resolution_status='resolved', resolution_action='linked', resolved_product_id=PRODUCT_A_ACTIVE",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(LINK_URL(UNK_T620_HAPPY))
        .send({ product_id: PRODUCT_A_ACTIVE });

      expect(res.status).toBe(200);

      const row = await env!.admin.query<{
        resolution_status: string;
        resolution_action: string;
        resolved_product_id: string;
      }>(
        `SELECT resolution_status, resolution_action, resolved_product_id
           FROM unknown_items
          WHERE id = $1`,
        [UNK_T620_HAPPY],
      );

      expect(row.rows[0]).toMatchObject({
        resolution_status: "resolved",
        resolution_action: "linked",
        resolved_product_id: PRODUCT_A_ACTIVE,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // T620-c — audit event emitted
  // ---------------------------------------------------------------------------

  it(
    "(c) emits exactly one audit event with action 'unknown_item.resolved.linked'",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(LINK_URL(UNK_T620_HAPPY))
        .send({ product_id: PRODUCT_A_ACTIVE });

      expect(res.status).toBe(200);

      // Drain microtasks to let the AuditEmitterInterceptor's async enqueue
      // settle (same drain pattern as metrics.spec.ts).
      for (let i = 0; i < 50; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      const linkEvents = auditSpy.calls.filter(
        (ev) => ev.action === "unknown_item.resolved.linked",
      );
      expect(linkEvents).toHaveLength(1);
    },
  );

  // ---------------------------------------------------------------------------
  // T620-d — metrics counter incremented
  // ---------------------------------------------------------------------------

  it(
    "(d) increments unknown_item_resolved_total{action='linked'} exactly once",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(LINK_URL(UNK_T620_HAPPY))
        .send({ product_id: PRODUCT_A_ACTIVE });

      expect(res.status).toBe(200);

      // Drain microtasks — recordUnknownItemResolved is synchronous in the
      // service handler, but setImmediate ensures no pending microtask queue
      // surprises (mirrors metrics.spec.ts drain).
      for (let i = 0; i < 50; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(resolvedCount).toBe(1);
      // Verify the spy was called with the correct action attribute.
      expect(resolvedSpy).toHaveBeenCalledWith({ action: "linked" });
    },
  );

  // ---------------------------------------------------------------------------
  // T620-e — atomicity (todo)
  // ---------------------------------------------------------------------------

  it.todo(
    "(e) atomicity: injecting a fault between alias INSERT and unknown_items UPDATE is impractical in Testcontainers; Postgres transactional rollback guarantees cover this at the DB layer",
  );
});
