/**
 * T061 — 007-US5-CREATE-REGRESSION — shipped create-from-unknown under 007.
 *
 * REGRESSION GUARD ONLY — test-only, NO reconciliation runtime code change.
 * Proves the shipped `tenantAdminCreateProductFromUnknownItem` (005 Wave 2)
 * still behaves per spec under 007's extended suite + the T038 projection:
 *   - create-from is atomic (a new tenant_products row + alias + the item
 *     transition land together) and the item is resolved/created (FR-030/031);
 *   - product creation is caller-initiated — no silent-create path (FR-065);
 *   - the create RESPONSE carries NO `sale_context` (FR-007, post-T038 — the
 *     007 delta this guard protects);
 *   - re-creating from a resolved item → 409 already_reconciled (monotonic
 *     guard, no duplicate effect).
 *
 * T003 = ISOLATE: NO Idempotency-Key replay assertion (shipped op keeps the
 * monotonic guard only).
 *
 * Harness mirrors create-happy-path.spec.ts. Docker: Testcontainers Postgres
 * 16, honors MIGRATION_TEST_ALLOW_SKIP=1.
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
} from "../__support__/isolation-harness";

const UNK_T061 = "0a000000-0000-7000-8000-00000061a001";
const UNK_T061_CORR = "0a000000-0000-7000-8000-000000610c01";
const UNK_T061_VALUE = "T061-CREATE-REG-001";
const TENANT_A_ADMIN = "0a000000-0000-7000-8000-000000610001";

const CREATE_URL = (id: string) =>
  `/api/v1/catalog/unknown-items/${id}/create-product`;

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

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T061 create-product-regression-007.spec] Docker NOT AVAILABLE: ${msg}\n` +
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
      UNK_T061,
      TENANT_A,
      STORE_A_X,
      UNK_T061_VALUE,
      JSON.stringify({ register: "R2" }),
      UNK_T061_CORR,
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
    [UNK_T061],
  );
  // Remove any product_aliases + tenant_products created by prior tests.
  await env.admin.query(
    `DELETE FROM product_aliases WHERE tenant_id = $1 AND value = $2`,
    [TENANT_A, UNK_T061_VALUE],
  );
  await env.admin.query(
    `DELETE FROM tenant_products WHERE tenant_id = $1 AND name = $2`,
    [TENANT_A, "T061 Created Product"],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

describe("T061 / 007-US5-CREATE-REGRESSION — shipped create-from under 007 [FR-030/031/065, FR-007]", () => {
  it("(a) shipped create-from is atomic: product + alias + item transition land together", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post(CREATE_URL(UNK_T061))
      .send({ name: "T061 Created Product", tax_category: "standard" });
    expect(res.status).toBe(201);

    const item = await env!.admin.query<{
      resolution_status: string;
      resolution_action: string;
      resolved_product_id: string | null;
    }>(
      `SELECT resolution_status, resolution_action, resolved_product_id
         FROM unknown_items WHERE id = $1`,
      [UNK_T061],
    );
    expect(item.rows[0]?.resolution_status).toBe("resolved");
    expect(item.rows[0]?.resolution_action).toBe("created");
    const productId = item.rows[0]?.resolved_product_id;
    expect(productId).toBeTruthy();

    // The product and its alias both exist (atomicity — all three effects).
    const product = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tenant_products WHERE id = $1`,
      [productId],
    );
    expect(product.rows[0]?.count).toBe("1");
    const alias = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM product_aliases WHERE tenant_id = $1 AND value = $2`,
      [TENANT_A, UNK_T061_VALUE],
    );
    expect(alias.rows[0]?.count).toBe("1");
  });

  it("(b) the create RESPONSE carries NO sale_context (FR-007, post-T038 projection)", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post(CREATE_URL(UNK_T061))
      .send({ name: "T061 Created Product", tax_category: "standard" });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("sale_context");
    // Positive distinguisher — the projected resolved item.
    expect(res.body.resolution_status).toBe("resolved");
    expect(res.body.resolution_action).toBe("created");
  });

  it("(c) missing required fields → 400 validation (no silent create, FR-065)", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post(CREATE_URL(UNK_T061))
      .send({ tax_category: "standard" }); // missing name
    expect(res.status).toBe(400);

    // The item is untouched — no silent create path.
    const item = await env!.admin.query<{ resolution_status: string }>(
      `SELECT resolution_status FROM unknown_items WHERE id = $1`,
      [UNK_T061],
    );
    expect(item.rows[0]?.resolution_status).toBe("pending");
  });

  it("(d) re-creating from a resolved item → 409 already_reconciled (monotonic guard)", async () => {
    if (dockerSkipped) return;

    const first = await http()
      .post(CREATE_URL(UNK_T061))
      .send({ name: "T061 Created Product", tax_category: "standard" });
    expect(first.status).toBe(201);

    // Second create on the now-resolved item → 409 (T003 ISOLATE: monotonic
    // guard, NOT an idempotency-key replay).
    const second = await http()
      .post(CREATE_URL(UNK_T061))
      .send({ name: "T061 Created Product", tax_category: "standard" });
    expect(second.status).toBe(409);
    expect(second.body?.error?.code).toBe("already_reconciled");
  });
});
