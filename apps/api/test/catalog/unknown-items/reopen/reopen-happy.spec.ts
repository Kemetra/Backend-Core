/**
 * T050 — 007-US7-REOPEN — Reopen a dismissed unknown item (GREEN/happy path).
 *
 * Spec anchors: FR-041 (reopen creates a fresh pending row), FR-110 (reopen
 * audited), 005 FR-005 (resubmit-after-dismiss → fresh pending row; original
 * dismissed row preserved).
 *
 * Route under test: POST /api/v1/catalog/unknown-items/:id/reopen
 * operationId: tenantAdminReopenUnknownItem (007 contract, v1.2.0-draft)
 * Source of truth: packages/contracts/openapi/catalog/unknown-items.yaml
 *
 * Sub-cases:
 *   (a) tenant-wide actor reopens a dismissed item → 201 Created + the fresh
 *       pending row as a ReviewQueueItem (no sale_context, FR-007).
 *   (b) a NEW unknown_items row exists for the same logical identifier tuple,
 *       resolution_status='pending'; the ORIGINAL dismissed row is preserved
 *       unchanged (005 FR-005 — dismissal is audit history, not mutated).
 *   (c) BOTH audit events are emitted programmatically (R7.5): the reopen
 *       action AND the fresh-capture, observed on the audit spy after the
 *       request resolves (mirrors link-happy-path.spec's drain pattern). The
 *       static @Auditable decorator emits only one subject per route, so the
 *       service emits the pair itself.
 *
 * Harness:
 *   ReconciliationController + ReconciliationService against a Testcontainers
 *   Postgres 16 pool, with a SpyAuditEnqueuer and the AuditEmitterInterceptor
 *   (so the route's own @Auditable, if any, plus the service's programmatic
 *   emissions are both observable on the same spy). Mirrors link-happy-path.
 *
 * Docker: Testcontainers Postgres 16. Honors MIGRATION_TEST_ALLOW_SKIP=1.
 *
 * Fixture: the 007 isolation-harness seed (seedUnknownItemsFixture) already
 * provides one DISMISSED row per cell (UNK_007_A_X_DISMISSED etc.). This spec
 * reopens the TENANT_A / STORE_A_X dismissed row as a tenant-wide actor
 * (ctx.storeId === null).
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
  ACTOR_A,
} from "../../__support__/isolation-harness";
import {
  seedUnknownItemsFixture,
  UNK_007_A_X_DISMISSED,
  UNK_007_VAL_A_X_DISMISSED,
} from "../../__support__/seed-unknown-items";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REOPEN_URL = (id: string) =>
  `/api/v1/catalog/unknown-items/${id}/reopen`;

/** A valid Idempotency-Key (16–128 printable ASCII, no whitespace). */
const IDEMPOTENCY_KEY = "reopen-t050-happy-key-000001";

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
// ConfigurableContextGuard — tenant-wide actor (storeId === null)
// ---------------------------------------------------------------------------

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string | null = null; // tenant-wide actor (R7.4 → isTenantWide)
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

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

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
        `\n[T050 reopen-happy.spec] Docker NOT AVAILABLE: ${msg}\n` +
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
  contextGuard.storeId = null;
  contextGuard.userId = ACTOR_A;

  // Restore the dismissed fixture row to its terminal state and delete any
  // fresh pending row a prior test created (so each test runs clean).
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
        AND store_id  = $2
        AND identifier_type = 'barcode'
        AND value     = $3
        AND resolution_status = 'pending'`,
    [TENANT_A, STORE_A_X, UNK_007_VAL_A_X_DISMISSED],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

describe("T050 / 007-US7-REOPEN — tenant-wide actor reopens a dismissed item [FR-041, FR-110, 005 FR-005]", () => {
  it("(a) returns 201 Created with the fresh pending row as a ReviewQueueItem (no sale_context)", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post(REOPEN_URL(UNK_007_A_X_DISMISSED))
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send({});

    expect(res.status).toBe(201);
    // ReviewQueueItem projection — FR-007: no sale_context key on the body.
    expect(res.body).not.toHaveProperty("sale_context");
    // Fresh row is pending (005 FR-005), distinct id from the dismissed row.
    expect(res.body.resolution_status).toBe("pending");
    expect(res.body.id).not.toBe(UNK_007_A_X_DISMISSED);
    expect(res.body.identifier_value).toBe(UNK_007_VAL_A_X_DISMISSED);
  });

  it("(b) creates a fresh pending row and preserves the original dismissed row unchanged (005 FR-005)", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post(REOPEN_URL(UNK_007_A_X_DISMISSED))
      .set("Idempotency-Key", `${IDEMPOTENCY_KEY}-b`)
      .send({});
    expect(res.status).toBe(201);

    // Original dismissed row is preserved unchanged (audit history).
    const original = await env!.admin.query<{ resolution_status: string }>(
      `SELECT resolution_status FROM unknown_items WHERE id = $1`,
      [UNK_007_A_X_DISMISSED],
    );
    expect(original.rows[0]?.resolution_status).toBe("dismissed");

    // Exactly one fresh pending row exists for the tuple.
    const fresh = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM unknown_items
        WHERE tenant_id = $1
          AND store_id  = $2
          AND identifier_type = 'barcode'
          AND value     = $3
          AND resolution_status = 'pending'`,
      [TENANT_A, STORE_A_X, UNK_007_VAL_A_X_DISMISSED],
    );
    expect(fresh.rows[0]?.count).toBe("1");
  });

  it("(c) emits BOTH the reopen action AND the fresh-capture audit events (R7.5)", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post(REOPEN_URL(UNK_007_A_X_DISMISSED))
      .set("Idempotency-Key", `${IDEMPOTENCY_KEY}-c`)
      .send({});
    expect(res.status).toBe(201);

    await drainMicrotasks();

    const reopenEvents = auditSpy.calls.filter(
      (ev) => ev.action === "unknown_item.reopened",
    );
    const captureEvents = auditSpy.calls.filter(
      (ev) => ev.action === "unknown_item.captured",
    );
    expect(reopenEvents).toHaveLength(1);
    expect(captureEvents).toHaveLength(1);
  });

  it("(d) an OMITTED request body still returns 201 (optional-body contract)", async () => {
    if (dockerSkipped) return;

    // The contract sets requestBody.required=false; every other case sends {}.
    // This case omits .send() entirely so a future body-parser/pipe change that
    // treats an absent body as `undefined` can't silently break the contract.
    const res = await http()
      .post(REOPEN_URL(UNK_007_A_X_DISMISSED))
      .set("Idempotency-Key", `${IDEMPOTENCY_KEY}-d`);

    expect(res.status).toBe(201);
    expect(res.body.resolution_status).toBe("pending");
    expect(res.body).not.toHaveProperty("sale_context");
  });
});
