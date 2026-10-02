/**
 * T611 — 005-WAVE2-CONFLICT — Store-scoped alias-conflict variant (RED).
 *
 * Spec anchors: FR-040.
 *
 * THIS SPEC IS INTENTIONALLY RED until 005-WAVE2-LINK-HAPPY (T620/T621/T622)
 * ships the ReconciliationController + ReconciliationService.
 *
 * Sub-scenarios (2 total):
 *   1. Store-scoped conflict: TENANT_A admin links a pending unknown item
 *      from STORE_A_X (barcode='T611-STORE-BAR-Y01') to PRODUCT_A_ACTIVE.
 *      A store-scoped product_aliases row already binds that barcode to
 *      PRODUCT_A_ACTIVE at STORE_A_X (seeded by seedStoreScopedConflictFixture).
 *      Expects 409 alias_conflict.
 *   2. Same barcode from different store succeeds: a pending unknown item
 *      from STORE_A_Y with the same barcode value ('T611-STORE-BAR-Y01')
 *      is linked to PRODUCT_A_ACTIVE. No store-scoped alias exists at
 *      STORE_A_Y, so the partial unique index is NOT violated. Expects 200.
 *      NOTE: this assertion ALSO fails RED today (no service exists), but
 *      for a different reason — route not found, not a conflict. Once
 *      LINK-HAPPY ships, this should be GREEN while sub-scenario 1 is also
 *      fixed to reject correctly.
 *
 * Fixture basis:
 *   seedStoreScopedConflictFixture (seed-unknown-items.ts) seeds:
 *     - product_aliases row: ALIAS_CONFLICT_A_X_SCOPED
 *       (tenant_id=TENANT_A, product_id=PRODUCT_A_ACTIVE,
 *        identifier_type='barcode', value='T611-STORE-BAR-Y01',
 *        store_id=STORE_A_X, source_system=NULL)
 *     - UNK_CONFLICT_STORE_X: pending unknown item at STORE_A_X with
 *       identifier_type='barcode', value='T611-STORE-BAR-Y01'
 *     - UNK_CONFLICT_STORE_Y: pending unknown item at STORE_A_Y with
 *       identifier_type='barcode', value='T611-STORE-BAR-Y01'
 *
 *   The partial unique index on product_aliases covers
 *   (tenant_id, identifier_type, value, store_id) WHERE store_id IS NOT NULL,
 *   so a second INSERT with the same (TENANT_A, barcode, 'T611-STORE-BAR-Y01',
 *   STORE_A_X) violates the index, yielding 23505 → 409 alias_conflict.
 *   A link from STORE_A_Y (different store_id) does NOT match that row.
 *
 * Harness choice:
 *   Same minimal pattern as alias-conflict.spec.ts — no ReconciliationController,
 *   GlobalExceptionFilter only, ConfigurableContextGuard for principal injection.
 *   Docker: Testcontainers Postgres 16. Honors MIGRATION_TEST_ALLOW_SKIP=1.
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

import { AuditEmitterInterceptor } from "../../../../src/audit/audit-emitter.interceptor";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { ReconciliationController } from "../../../../src/catalog/reconciliation/reconciliation.controller";
import { ReconciliationService } from "../../../../src/catalog/reconciliation/reconciliation.service";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import type { ResolvedContext } from "../../../../src/context/types";
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
  PRODUCT_A_ACTIVE,
} from "../../__support__/isolation-harness";
import {
  seedStoreScopedConflictFixture,
  UNK_CONFLICT_STORE_X,
  UNK_CONFLICT_STORE_Y,
} from "../../__support__/seed-unknown-items";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A_ADMIN_USER = "0a000000-0000-7000-8000-000006110001";

const LINK_URL = (id: string) => `/api/v1/catalog/unknown-items/${id}/link`;
const LINK_BODY = { product_id: PRODUCT_A_ACTIVE };

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
  public storeId: string | null = null;
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
        `\n[T611 store-scoped-conflict.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set — suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);
  await seedStoreScopedConflictFixture(env);

  // CONFLICT spec wiring: now that LINK-HAPPY + LINK-EDGES + the filter fix
  // (PR #360 — exception filter honors user-supplied error.code per
  // Constitution §IV) have landed on main, this spec mounts the real
  // ReconciliationController so its alias_conflict assertions exercise the
  // actual surface. PG_POOL bound to localEnv.app (RLS-active per PR #357
  // audit pattern). The earlier "no controller exists" stub returned 404
  // for every test — a contract violation that landed silently and was
  // surfaced by the LINK-EDGES landing.
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
  // GlobalExceptionFilter only — no IdempotencyMismatchFilter globally.
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(contextGuard);
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T611 — FR-040 store-scoped alias-conflict variant
// ---------------------------------------------------------------------------

describe("T611 / 005-WAVE2-CONFLICT — store-scoped alias-conflict variant (RED until LINK-HAPPY)", () => {
  // ----- Sub-scenario 1: Store-scoped conflict (STORE_A_X) -----------------
  describe("sub-scenario 1: link from STORE_A_X — barcode already aliased at that store [FR-040]", () => {
    it(
      "returns 409 alias_conflict when barcode already has a store-scoped alias at STORE_A_X",
      async () => {
        if (dockerSkipped) return;

        // The store-scoped alias (ALIAS_CONFLICT_A_X_SCOPED) binds
        // barcode='T611-STORE-BAR-Y01' to PRODUCT_A_ACTIVE at STORE_A_X.
        // Linking UNK_CONFLICT_STORE_X (also barcode='T611-STORE-BAR-Y01',
        // store STORE_A_X) to PRODUCT_A_ACTIVE would produce a second row
        // with identical (tenant_id, identifier_type, value, store_id),
        // violating the store-scoped partial unique index → 409.
        contextGuard.tenantId = TENANT_A;
        contextGuard.storeId = STORE_A_X;
        contextGuard.userId = TENANT_A_ADMIN_USER;

        const res = await http()
          .post(LINK_URL(UNK_CONFLICT_STORE_X))
          .send(LINK_BODY);

        // Expected once LINK-HAPPY lands. Currently fails: 404 (no route).
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          error: {
            code: "alias_conflict",
          },
        });
      },
    );
  });

  // ----- Sub-scenario 2: Same barcode from STORE_A_Y succeeds --------------
  describe("sub-scenario 2: link from STORE_A_Y — no alias at that store, should succeed [FR-040]", () => {
    it(
      "returns 200 when barcode has no store-scoped alias at STORE_A_Y (different store scope)",
      async () => {
        if (dockerSkipped) return;

        // UNK_CONFLICT_STORE_Y is at STORE_A_Y. The store-scoped alias
        // only covers STORE_A_X. The product_aliases partial unique index
        // (store_id IS NOT NULL) uses (tenant_id, identifier_type, value,
        // store_id) — since store_id=STORE_A_Y has no existing alias row
        // for this barcode, the INSERT succeeds.
        contextGuard.tenantId = TENANT_A;
        contextGuard.storeId = STORE_A_Y;
        contextGuard.userId = TENANT_A_ADMIN_USER;

        const res = await http()
          .post(LINK_URL(UNK_CONFLICT_STORE_Y))
          .send(LINK_BODY);

        // Expected once LINK-HAPPY lands. Currently fails: 404 (no route).
        // This assertion being RED is intentional — the spec is authored
        // for the future GREEN state.
        expect(res.status).toBe(200);
      },
    );
  });
});
