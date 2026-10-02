/**
 * T060 — 007-US4-LINK-REGRESSION — shipped link still behaves under 007.
 *
 * REGRESSION GUARD ONLY — test-only, NO reconciliation runtime code change.
 * Proves the shipped `tenantAdminLinkUnknownItem` (005 Wave 2) still behaves
 * per spec under 007's extended suite + the T038 ReviewQueueItem projection:
 *   - link resolves the item (resolution_status='resolved',
 *     resolution_action='linked') and is audited (FR-020/021/022);
 *   - the link RESPONSE carries NO `sale_context` (FR-007, after the T038
 *     projection swap — this is the 007 delta this guard exists to protect);
 *   - re-linking a resolved item → 409 already_reconciled (monotonic-guard
 *     no-duplicate-effect; FR-052).
 *
 * T003 = ISOLATE: shipped link keeps its monotonic-guard only — there is
 * deliberately NO Idempotency-Key replay assertion here (the shipped op was
 * NOT retrofitted with an idempotency key in v1).
 *
 * Harness mirrors link-happy-path.spec.ts. Docker: Testcontainers Postgres 16,
 * honors MIGRATION_TEST_ALLOW_SKIP=1.
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

import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { AuditEmitterInterceptor } from "../../../src/audit/audit-emitter.interceptor";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../src/audit/audit-job.types";
import { PG_POOL } from "../../../src/auth/auth.module";
import type { ResolvedContext } from "../../../src/context/types";
import { ReconciliationController } from "../../../src/catalog/reconciliation/reconciliation.controller";
import { ReconciliationService } from "../../../src/catalog/reconciliation/reconciliation.service";

import { DashboardAuthGuard } from "../../../src/auth/dashboard-auth.guard";
import { RolesGuard } from "../../../src/auth/roles.guard";
import { TenantContextGuard } from "../../../src/context/tenant-context.guard";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  TENANT_A,
  STORE_A_X,
  PRODUCT_A_ACTIVE,
} from "../__support__/isolation-harness";

const UNK_T060 = "0a000000-0000-7000-8000-00000060a001";
const UNK_T060_CORR = "0a000000-0000-7000-8000-000000600c01";
const UNK_T060_VALUE = "T060-LINK-REG-001";
const TENANT_A_ADMIN = "0a000000-0000-7000-8000-000000600001";

const LINK_URL = (id: string) => `/api/v1/catalog/unknown-items/${id}/link`;

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
  public storeId: string | null = STORE_A_X;
  public userId: string = TENANT_A_ADMIN;

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
let contextGuard: ConfigurableContextGuard;
let auditSpy: SpyAuditEnqueuer;
let dockerSkipped = false;

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T060 link-regression-007.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, sale_context, correlation_id)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5, $6)
     ON CONFLICT DO NOTHING`,
    [
      UNK_T060,
      TENANT_A,
      STORE_A_X,
      UNK_T060_VALUE,
      // A non-null sale_context on the SOURCE row — the guard proves the
      // RESPONSE still omits it (the projection strips it).
      JSON.stringify({ register: "R1", cashier: "c-001" }),
      UNK_T060_CORR,
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
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ReconciliationService,
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
      { provide: APP_INTERCEPTOR, useValue: auditInterceptor },
    ],
  })
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

beforeEach(async () => {
  if (dockerSkipped || !env) return;
  auditSpy.reset();
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = STORE_A_X;
  contextGuard.userId = TENANT_A_ADMIN;

  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status='pending', resolution_action=NULL,
            resolved_at=NULL, resolved_by=NULL, resolved_product_id=NULL
      WHERE id = $1`,
    [UNK_T060],
  );
  await env.admin.query(
    `DELETE FROM product_aliases WHERE tenant_id = $1 AND value = $2`,
    [TENANT_A, UNK_T060_VALUE],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

describe("T060 / 007-US4-LINK-REGRESSION — shipped link under 007 [FR-020/021/022, FR-007, FR-052]", () => {
  it("(a) shipped link still resolves the item + audits + creates the alias", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post(LINK_URL(UNK_T060))
      .send({ product_id: PRODUCT_A_ACTIVE });
    expect(res.status).toBe(200);

    const row = await env!.admin.query<{
      resolution_status: string;
      resolution_action: string;
      resolved_product_id: string;
    }>(
      `SELECT resolution_status, resolution_action, resolved_product_id
         FROM unknown_items WHERE id = $1`,
      [UNK_T060],
    );
    expect(row.rows[0]).toMatchObject({
      resolution_status: "resolved",
      resolution_action: "linked",
      resolved_product_id: PRODUCT_A_ACTIVE,
    });

    await drainMicrotasks();
    const linkEvents = auditSpy.calls.filter(
      (ev) => ev.action === "unknown_item.resolved.linked",
    );
    expect(linkEvents).toHaveLength(1);
  });

  it("(b) the link RESPONSE carries NO sale_context (FR-007, post-T038 projection)", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post(LINK_URL(UNK_T060))
      .send({ product_id: PRODUCT_A_ACTIVE });
    expect(res.status).toBe(200);
    // The source row HAS a sale_context, but the ReviewQueueItem projection
    // (T038) must strip it from the response.
    expect(res.body).not.toHaveProperty("sale_context");
    // The response IS the resolved item shape (a positive distinguisher so
    // the no-sale_context assertion isn't vacuous on an empty/error body).
    expect(res.body.resolution_status).toBe("resolved");
    expect(res.body.resolution_action).toBe("linked");
  });

  it("(c) re-linking a resolved item → 409 already_reconciled (monotonic-guard, no duplicate effect)", async () => {
    if (dockerSkipped) return;

    // First link succeeds.
    const first = await http()
      .post(LINK_URL(UNK_T060))
      .send({ product_id: PRODUCT_A_ACTIVE });
    expect(first.status).toBe(200);

    // Second link on the now-resolved item → 409, NO duplicate alias.
    // (T003 ISOLATE: this is the monotonic-guard, NOT an idempotency-key replay.)
    const second = await http()
      .post(LINK_URL(UNK_T060))
      .send({ product_id: PRODUCT_A_ACTIVE });
    expect(second.status).toBe(409);
    expect(second.body?.error?.code).toBe("already_reconciled");

    const aliasCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM product_aliases WHERE tenant_id = $1 AND value = $2`,
      [TENANT_A, UNK_T060_VALUE],
    );
    expect(aliasCount.rows[0]?.count).toBe("1");
  });
});
