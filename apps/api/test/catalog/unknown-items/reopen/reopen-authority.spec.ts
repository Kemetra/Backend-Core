/**
 * T051 — 007-US7-REOPEN — Reopen authority split (service-layer, R7.4).
 *
 * Spec anchors: FR-042 (store-scoped actor → 403 forbidden, "tenant-wide
 * authority required"), FR-062 (out-of-scope actor → non-disclosing 404),
 * FR-111 (rejection audited).
 *
 * Route under test: POST /api/v1/catalog/unknown-items/:id/reopen
 * operationId: tenantAdminReopenUnknownItem
 *
 * The decisive R7.4 invariant this spec pins:
 *   The 403 vs 404 split is decided in the SERVICE, not the route guard.
 *   The route declares @Roles("owner","tenant_admin","store_manager",
 *   { denyAs: 404 }) so a store_manager REACHES the service. The service
 *   then splits on the actor's tenant-wide authority:
 *     - in-scope row + store-scoped actor (ctx.storeId !== null) → 403 forbidden
 *     - out-of-scope row (RLS-filtered to zero rows) → 404 non-disclosing
 *   isTenantWide is derived from ctx.storeId === null (ResolvedContext carries
 *   no role field — same signal as the wave-1 canSeeProduct rule).
 *
 * Sub-cases:
 *   (a) store-scoped actor, in-scope dismissed item → 403, error.code="forbidden".
 *   (b) store-scoped actor, OUT-OF-SCOPE item (different store) → 404 not_found,
 *       non-disclosing (must NOT reveal the item exists in another store).
 *   (c) the 403 rejection is audited (FR-111); the 404 is NOT audited (a
 *       non-disclosing 404 must not confirm existence via an audit row).
 *
 * Harness: mirrors reopen-happy.spec; the ConfigurableContextGuard is set to a
 * store-scoped actor (storeId = STORE_A_X) per test.
 *
 * Docker: Testcontainers Postgres 16. Honors MIGRATION_TEST_ALLOW_SKIP=1.
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
  STORE_A_Y,
  ACTOR_A,
} from "../../__support__/isolation-harness";
import {
  seedUnknownItemsFixture,
  UNK_007_A_X_DISMISSED,
  UNK_007_A_Y_DISMISSED,
  UNK_007_VAL_A_X_DISMISSED,
} from "../../__support__/seed-unknown-items";

const REOPEN_URL = (id: string) =>
  `/api/v1/catalog/unknown-items/${id}/reopen`;

const IDEMPOTENCY_KEY = "reopen-t051-authority-key-0001";

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
  public storeId: string | null = STORE_A_X; // store-scoped actor (R7.4)
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
        `\n[T051 reopen-authority.spec] Docker NOT AVAILABLE: ${msg}\n` +
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
  contextGuard.userId = ACTOR_A;

  // Keep the in-scope dismissed row terminal; remove any fresh pending row
  // (a 403/404 must never create one, but reset defensively).
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status   = 'dismissed',
            resolution_action   = 'dismissed',
            resolved_at         = now(),
            resolved_by         = $2,
            resolved_product_id = NULL
      WHERE id = $1`,
    [UNK_007_A_X_DISMISSED, ACTOR_A],
  );
  await env.admin.query(
    `DELETE FROM unknown_items
      WHERE tenant_id = $1
        AND identifier_type = 'barcode'
        AND value     = $2
        AND resolution_status = 'pending'`,
    [TENANT_A, UNK_007_VAL_A_X_DISMISSED],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

describe("T051 / 007-US7-REOPEN — authority split is service-layer (R7.4) [FR-042, FR-062, FR-111]", () => {
  it("(a) store-scoped actor reopening an IN-SCOPE item → 403 forbidden", async () => {
    if (dockerSkipped) return;

    // Store-scoped actor at STORE_A_X reopening the STORE_A_X dismissed row:
    // RLS lets the service SEE the row (in-scope), but the service rejects
    // for lack of tenant-wide authority → 403 forbidden (NOT 404).
    contextGuard.storeId = STORE_A_X;

    const res = await http()
      .post(REOPEN_URL(UNK_007_A_X_DISMISSED))
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body?.error?.code).toBe("forbidden");

    // No fresh pending row was created by a rejected reopen.
    const fresh = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM unknown_items
        WHERE tenant_id = $1 AND value = $2 AND resolution_status = 'pending'`,
      [TENANT_A, UNK_007_VAL_A_X_DISMISSED],
    );
    expect(fresh.rows[0]?.count).toBe("0");
  });

  it("(b) store-scoped actor reopening an OUT-OF-SCOPE item → 404 non-disclosing", async () => {
    if (dockerSkipped) return;

    // Actor scoped to STORE_A_X attempts to reopen the STORE_A_Y dismissed row.
    // RLS filters the row to zero rows for this store scope → 404 not_found,
    // indistinguishable from "does not exist" (must NOT leak cross-store
    // existence). This is the FR-062 non-disclosure invariant.
    contextGuard.storeId = STORE_A_X;

    auditSpy.reset();
    const res = await http()
      .post(REOPEN_URL(UNK_007_A_Y_DISMISSED))
      .set("Idempotency-Key", `${IDEMPOTENCY_KEY}-b`)
      .send({});

    expect(res.status).toBe(404);
    // Canonical error envelope — distinguishes a SERVICE-decided non-disclosing
    // 404 (error.code + request_id present) from a bare Nest router 404 for a
    // missing route (which would carry { statusCode, message } and no
    // error.code). Proves the route was reached and the service chose
    // not_found, not that the endpoint is absent.
    expect(res.body?.error?.code).toBe("not_found");
    expect(res.body?.error?.request_id).toBeDefined();
    // Non-disclosure: an out-of-scope 404 emits NO audit event (an audit row
    // would confirm the item exists in another store — FR-062 / SI-004).
    await drainMicrotasks();
    expect(auditSpy.calls).toHaveLength(0);
  });

  it("(c) the 403 rejection is audited; the 404 is NOT audited (non-disclosure)", async () => {
    if (dockerSkipped) return;

    // 403 path — in-scope store-scoped actor → rejection audited (FR-111).
    contextGuard.storeId = STORE_A_X;
    auditSpy.reset();
    const forbiddenRes = await http()
      .post(REOPEN_URL(UNK_007_A_X_DISMISSED))
      .set("Idempotency-Key", `${IDEMPOTENCY_KEY}-c1`)
      .send({});
    expect(forbiddenRes.status).toBe(403);
    await drainMicrotasks();
    const rejectionEvents = auditSpy.calls.filter(
      (ev) => ev.action === "unknown_item.reopen_rejected",
    );
    expect(rejectionEvents).toHaveLength(1);

    // 404 path — out-of-scope → NO audit event (must not confirm existence).
    auditSpy.reset();
    const notFoundRes = await http()
      .post(REOPEN_URL(UNK_007_A_Y_DISMISSED))
      .set("Idempotency-Key", `${IDEMPOTENCY_KEY}-c2`)
      .send({});
    expect(notFoundRes.status).toBe(404);
    await drainMicrotasks();
    expect(auditSpy.calls).toHaveLength(0);
  });
});
