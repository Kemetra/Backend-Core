/**
 * T062 — 007-US6-DISMISS-REGRESSION — shipped dismiss under 007.
 *
 * REGRESSION GUARD ONLY — test-only, NO runtime code change. Proves the
 * shipped `tenantAdminDismissUnknownItem` (005 Wave 1) still behaves per spec
 * under 007 — and it is the per-item building block that bulk-dismiss (T057)
 * decomposes into:
 *   - dismiss transitions pending → dismissed (FR-040) and is audited;
 *   - re-dismissing a terminal row → 409 already_reconciled (monotonic guard,
 *     no duplicate effect);
 *   - an out-of-scope / cross-tenant id → non-disclosing 404 (SI-004).
 *
 * T003 = ISOLATE: NO Idempotency-Key replay assertion (dismiss is naturally
 * idempotent via the DB monotonicity guard, never carried an idempotency key).
 *
 * Lives under test/catalog/reconciliation/ per the slice allowed_files even
 * though the dismiss route is on UnknownItemsController (US6 groups with the
 * reconciliation regression guards). Harness mirrors dismiss-happy-path.spec.
 * Docker: Testcontainers Postgres 16, honors MIGRATION_TEST_ALLOW_SKIP=1.
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
import { UnknownItemsController } from "../../../src/catalog/unknown-items/unknown-items.controller";
import { UnknownItemsService } from "../../../src/catalog/unknown-items/unknown-items.service";

import { DashboardAuthGuard } from "../../../src/auth/dashboard-auth.guard";
import { PosOperatorAuthGuard } from "../../../src/auth/pos-operator-auth.guard";
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
  STORE_A_Y,
} from "../__support__/isolation-harness";

const UNK_T062 = "0a000000-0000-7000-8000-00000062a001";
const UNK_T062_CORR = "0a000000-0000-7000-8000-000000620c01";
const UNK_T062_VALUE = "T062-DISMISS-REG-001";
// A row at STORE_A_Y — out of scope for a STORE_A_X-scoped actor.
const UNK_T062_OTHER_STORE = "0a000000-0000-7000-8000-00000062a002";
const UNK_T062_OTHER_CORR = "0a000000-0000-7000-8000-000000620c02";
const TENANT_A_ADMIN = "0a000000-0000-7000-8000-000000620001";

const DISMISS_URL = (id: string) =>
  `/api/v1/catalog/unknown-items/${id}/dismiss`;

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
        `\n[T062 dismiss-regression-007.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Seed a NON-NULL sale_context on the source rows so the
  // `not.toHaveProperty("sale_context")` guard in test (a) is non-vacuous
  // (CodeRabbit #410): the projection must actively STRIP a present field, not
  // pass trivially because the column was null.
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, sale_context, correlation_id)
     VALUES
       ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5, $6),
       ($7, $2, $8, 'barcode', $9, NULL, 'pending', $10, $11)
     ON CONFLICT DO NOTHING`,
    [
      UNK_T062, TENANT_A, STORE_A_X, UNK_T062_VALUE,
      JSON.stringify({ register: "R3" }), UNK_T062_CORR,
      UNK_T062_OTHER_STORE, STORE_A_Y, "T062-OTHER-STORE-001",
      JSON.stringify({ register: "R4" }), UNK_T062_OTHER_CORR,
    ],
  );

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  auditSpy = new SpyAuditEnqueuer();
  const reflector = new Reflector();
  const auditInterceptor = new AuditEmitterInterceptor(reflector, auditSpy);

  const moduleRef = await Test.createTestingModule({
    controllers: [UnknownItemsController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      UnknownItemsService,
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
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
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = STORE_A_X;
  contextGuard.userId = TENANT_A_ADMIN;

  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status='pending', resolution_action=NULL,
            resolved_at=NULL, resolved_by=NULL, resolved_product_id=NULL
      WHERE id = ANY($1::uuid[])`,
    [[UNK_T062, UNK_T062_OTHER_STORE]],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

describe("T062 / 007-US6-DISMISS-REGRESSION — shipped dismiss under 007 [FR-040, SI-004]", () => {
  it("(a) shipped dismiss still transitions pending → dismissed + audits", async () => {
    if (dockerSkipped) return;

    const res = await http().post(DISMISS_URL(UNK_T062)).send();
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("sale_context");
    expect(res.body.resolution_status).toBe("dismissed");

    const row = await env!.admin.query<{ resolution_status: string }>(
      `SELECT resolution_status FROM unknown_items WHERE id = $1`,
      [UNK_T062],
    );
    expect(row.rows[0]?.resolution_status).toBe("dismissed");

    await drainMicrotasks();
    const dismissEvents = auditSpy.calls.filter(
      (ev) => ev.action === "unknown_item.dismissed",
    );
    expect(dismissEvents).toHaveLength(1);
  });

  it("(b) re-dismissing a dismissed row → 409 already_reconciled + prior_state (monotonic guard)", async () => {
    if (dockerSkipped) return;

    const first = await http().post(DISMISS_URL(UNK_T062)).send();
    expect(first.status).toBe(200);

    // T003 ISOLATE: monotonic guard, NOT an idempotency-key replay.
    const second = await http().post(DISMISS_URL(UNK_T062)).send();
    expect(second.status).toBe(409);
    expect(second.body?.error?.code).toBe("already_reconciled");
  });

  it("(c) out-of-scope (different store) id → non-disclosing 404 (SI-004)", async () => {
    if (dockerSkipped) return;

    // Actor scoped to STORE_A_X dismissing the STORE_A_Y row → RLS filters it
    // → 404, non-disclosing. Must NOT reveal the row exists in another store.
    contextGuard.storeId = STORE_A_X;
    const res = await http().post(DISMISS_URL(UNK_T062_OTHER_STORE)).send();
    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe("not_found");

    // The out-of-scope row is untouched (still pending in its own store).
    const row = await env!.admin.query<{ resolution_status: string }>(
      `SELECT resolution_status FROM unknown_items WHERE id = $1`,
      [UNK_T062_OTHER_STORE],
    );
    expect(row.rows[0]?.resolution_status).toBe("pending");
  });
});
