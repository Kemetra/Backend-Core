/**
 * T625 — 005-WAVE2-LINK-EDGES — Link of already-resolved item (race
 * / monotonicity) — RED.
 *
 * Spec anchors: FR-052 (monotonic lifecycle), US3 #3 (race-safety).
 *
 * Route under test: POST /api/v1/catalog/unknown-items/:id/link
 *
 * Scenario:
 *   Simulate a concurrent resolution race. Before calling the link
 *   endpoint, directly UPDATE the pending unknown_items row to
 *   resolution_status='resolved' via the superuser admin pool. This
 *   bypasses the lock LINK-HAPPY's `SELECT … FOR UPDATE` would otherwise
 *   hold and emulates the case where another transaction beat us to the
 *   resolution. The admin pool also bypasses RLS, but RLS is irrelevant
 *   for this fixture-INSERT path — the race-simulation is what matters
 *   (mirrors the dismiss-audit.spec.ts:162-164 template).
 *
 * Expected:
 *   - HTTP 409, error.code='already_reconciled'.
 *   - No new product_aliases row.
 *   - No audit event for the link action.
 *
 * T626 verification:
 *   The existing `FOR UPDATE` lock + `WHERE resolution_status='pending'`
 *   pattern in ReconciliationService.linkUnknownItem already detects this
 *   case at the lock-and-discriminate step. This spec formalizes the
 *   assertion. No service-code change is expected for T626 beyond a
 *   one-line clarifying comment at the lock site.
 *
 * Harness: ReconciliationController + ReconciliationService against
 * Testcontainers Postgres 16. PG_POOL bound to localEnv.app (RLS-active)
 * per the PR #357 audit pattern.
 *
 * Docker: honors MIGRATION_TEST_ALLOW_SKIP=1.
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
  PRODUCT_A_ACTIVE,
} from "../../__support__/isolation-harness";

// ---------------------------------------------------------------------------
// T625-specific fixture constants
// ---------------------------------------------------------------------------

const UNK_T625_RACE = "0a000000-0000-7000-8000-00000625ed01";
const UNK_T625_RACE_CORR = "0a000000-0000-7000-8000-00000625ec01";
const UNK_T625_BARCODE_VALUE = "T625-LINK-RACE-001";

const TENANT_A_ADMIN_USER = "0a000000-0000-7000-8000-000006250001";

/**
 * Pre-existing "resolver" actor for the race fixture — used as the
 * resolved_by value when we simulate the concurrent resolution.
 */
const T625_PRIOR_RESOLVER = "0a000000-0000-7000-8000-000006250002";

const LINK_URL = (id: string) => `/api/v1/catalog/unknown-items/${id}/link`;

// ---------------------------------------------------------------------------
// SpyAuditEnqueuer (mirrors link-happy-path.spec.ts)
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

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T625 link-already-reconciled.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Seed the pending unknown item; we will flip it to 'resolved' in each
  // sub-test's pre-arrange step to simulate the race.
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5)
     ON CONFLICT DO NOTHING`,
    [UNK_T625_RACE, TENANT_A, STORE_A_X, UNK_T625_BARCODE_VALUE, UNK_T625_RACE_CORR],
  );

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  auditSpy = new SpyAuditEnqueuer();

  const reflector = new Reflector();
  const auditInterceptor = new AuditEmitterInterceptor(reflector, auditSpy);

  const moduleRef = await Test.createTestingModule({
    controllers: [ReconciliationController],
    providers: [
      // PG_POOL bound to the RLS-active `app` pool — matches PR #357
      // audit finding that the runtime role must exercise RLS in tests.
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
  auditSpy.reset();
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = STORE_A_X;
  contextGuard.userId = TENANT_A_ADMIN_USER;
});

afterEach(async () => {
  if (dockerSkipped || !env) return;
  // Restore the fixture row to pending for the next sub-case.
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status   = 'pending',
            resolution_action   = NULL,
            resolved_at         = NULL,
            resolved_by         = NULL,
            resolved_product_id = NULL
      WHERE id = $1`,
    [UNK_T625_RACE],
  );
  // Defensive: scrub any leaked aliases.
  await env.admin.query(
    `DELETE FROM product_aliases
      WHERE tenant_id = $1
        AND value     = $2`,
    [TENANT_A, UNK_T625_BARCODE_VALUE],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

async function aliasCount(): Promise<number> {
  const r = await env!.admin.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM product_aliases
      WHERE tenant_id = $1
        AND value     = $2`,
    [TENANT_A, UNK_T625_BARCODE_VALUE],
  );
  return Number(r.rows[0]?.count ?? "0");
}

// ---------------------------------------------------------------------------
// T625 — link already-reconciled [FR-052, US3 #3]
// ---------------------------------------------------------------------------

describe("T625 / 005-WAVE2-LINK-EDGES — link to an already-resolved item returns 409 already_reconciled [FR-052]", () => {
  it(
    "(a) returns 409 already_reconciled when the unknown item was concurrently resolved before the link arrived",
    async () => {
      if (dockerSkipped) return;

      // Race-simulation: directly mark the unknown item resolved via the
      // superuser pool. This emulates a concurrent transaction that
      // committed before our link call entered the service. Admin pool is
      // used here specifically because we need to bypass the lock that
      // LINK-HAPPY's FOR UPDATE would hold; admin also bypasses RLS but
      // that's irrelevant for this fixture-INSERT path. Mirrors the
      // dismiss-audit.spec.ts:162-164 template.
      await env!.admin.query(
        `UPDATE unknown_items
            SET resolution_status   = 'resolved',
                resolution_action   = 'linked',
                resolved_at         = now(),
                resolved_by         = $2,
                resolved_product_id = $3
          WHERE id = $1`,
        [UNK_T625_RACE, T625_PRIOR_RESOLVER, PRODUCT_A_ACTIVE],
      );

      const beforeAliases = await aliasCount();

      // Now attempt the link — service must surface already_reconciled.
      const res = await http()
        .post(LINK_URL(UNK_T625_RACE))
        .send({ product_id: PRODUCT_A_ACTIVE });

      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("already_reconciled");

      // Lifecycle is monotonic: the prior resolution is preserved.
      const after = await env!.admin.query<{
        resolution_status: string;
        resolved_by: string | null;
      }>(
        `SELECT resolution_status, resolved_by FROM unknown_items WHERE id = $1`,
        [UNK_T625_RACE],
      );
      expect(after.rows[0]?.resolution_status).toBe("resolved");
      expect(after.rows[0]?.resolved_by).toBe(T625_PRIOR_RESOLVER);

      // No new alias.
      expect(await aliasCount()).toBe(beforeAliases);

      // No audit event for the link action.
      for (let i = 0; i < 50; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const linkEvents = auditSpy.calls.filter(
        (ev) => ev.action === "unknown_item.resolved.linked",
      );
      expect(linkEvents).toHaveLength(0);
    },
  );

  it(
    "(b) returns 409 already_reconciled when the unknown item was previously dismissed",
    async () => {
      if (dockerSkipped) return;

      // Symmetric path: a dismissed item is also non-pending and must
      // surface already_reconciled (FR-052 monotonicity covers both
      // resolved and dismissed terminal states).
      await env!.admin.query(
        `UPDATE unknown_items
            SET resolution_status = 'dismissed',
                resolution_action = 'dismissed',
                resolved_at       = now(),
                resolved_by       = $2
          WHERE id = $1`,
        [UNK_T625_RACE, T625_PRIOR_RESOLVER],
      );

      const beforeAliases = await aliasCount();

      const res = await http()
        .post(LINK_URL(UNK_T625_RACE))
        .send({ product_id: PRODUCT_A_ACTIVE });

      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("already_reconciled");

      const after = await env!.admin.query<{ resolution_status: string }>(
        `SELECT resolution_status FROM unknown_items WHERE id = $1`,
        [UNK_T625_RACE],
      );
      expect(after.rows[0]?.resolution_status).toBe("dismissed");
      expect(await aliasCount()).toBe(beforeAliases);

      for (let i = 0; i < 50; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const linkEvents = auditSpy.calls.filter(
        (ev) => ev.action === "unknown_item.resolved.linked",
      );
      expect(linkEvents).toHaveLength(0);
    },
  );
});
