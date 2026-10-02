/**
 * T610 — 005-WAVE2-CONFLICT — Alias-conflict safety floor (RED).
 *
 * Spec anchors: FR-040, FR-041, FR-042, FR-043, FR-051, FR-052.
 *
 * THIS SPEC IS INTENTIONALLY RED until 005-WAVE2-LINK-HAPPY (T620/T621/T622)
 * ships the ReconciliationController + ReconciliationService. Currently
 * POST /api/v1/catalog/unknown-items/{id}/link returns 404 (route not
 * found) because no controller handles it yet. The assertions below target
 * the EXPECTED contract once the service is live; the 404-not-found 409
 * failure proves the spec exercises the correct endpoint.
 *
 * Sub-scenarios (4 total):
 *   1. Alias-conflict primary case (FR-040 + FR-042): TENANT_A admin links
 *      U1 (barcode='T340-A-BAR-001', store STORE_A_X) to PRODUCT_A_ACTIVE.
 *      A STORE-SCOPED alias for that barcode at STORE_A_X is already seeded
 *      (seedAliasConflictFixture). The link path writes the item's store_id,
 *      so the INSERT collides on the store-scoped partial unique index.
 *      Expects 409 {error.code='alias_conflict'}. Verifies:
 *        - response status 409
 *        - error.code === 'alias_conflict'
 *        - no conflicting product name in response body (FR-042 non-disclosing)
 *        - U1 resolution_status remains 'pending' in DB
 *        - no new product_aliases row added
 *   2. Store-scope isolation (FR-040): U2 has the same barcode='T340-A-BAR-001'
 *      but lives at STORE_A_Y. The link path writes a STORE_A_Y-scoped alias,
 *      which lands in a different partition of the store-scoped unique index
 *      and does NOT collide. Expects 200 (succeeds). This is the canonical
 *      FR-040 store-partitioning behaviour — store_id of the item's origin
 *      determines the partition, so a different store does not conflict.
 *   3. Counter assertion (FR-043): catalog_duplicate_alias_conflict_total
 *      is NOT yet registered in CATALOG_METRIC_NAMES (api.metrics.ts confirms
 *      only 3 Wave 1 counters). This assertion is deferred to T650 /
 *      005-WAVE2-METRICS per the Phase 3 Note at tasks.md line 436.
 *   4. Cross-tenant probe (FR-051 / FR-052 / SI-004 non-disclosing): TENANT_B
 *      admin attempts to link TENANT_A's unknown item U1. Expects 404 —
 *      the response must not disclose the item's existence (non-disclosing).
 *
 * Fixture basis:
 *   seedAliasConflictFixture seeds a STORE-SCOPED product_aliases row at
 *   (TENANT_A, store_id=STORE_A_X, identifier_type='barcode',
 *   value='T340-A-BAR-001') bound to PRODUCT_A_ACTIVE, plus U1 (STORE_A_X) and
 *   U2 (STORE_A_Y) both carrying that same barcode. The link path writes the
 *   new alias with store_id = the unknown item's store, so linking U1 reproduces
 *   (TENANT_A, STORE_A_X, 'barcode', 'T340-A-BAR-001') and violates the
 *   store-scoped partial unique index (WHERE store_id IS NOT NULL) -> 23505 ->
 *   409. Linking U2 writes a STORE_A_Y-scoped alias in a different partition,
 *   so it does NOT conflict -> 200. The tenant-wide ALIAS_A_BARCODE
 *   (store_id=NULL) from isolation-harness.ts lives in the tenant-wide
 *   partition and is never touched by these store-scoped INSERTs.
 *
 * Harness choice:
 *   Minimal Test.createTestingModule with NO ReconciliationController (none
 *   exists). The app runs with GlobalExceptionFilter only — no
 *   IdempotencyMismatchFilter global registration (avoids PR #349 latent
 *   harness issue). ConfigurableContextGuard overrides the resolved context
 *   per test case so we can simulate TENANT_A and TENANT_B callers.
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
  TENANT_B,
  STORE_A_X,
  STORE_A_Y,
  PRODUCT_A_ACTIVE,
} from "../../__support__/isolation-harness";
import {
  seedAliasConflictFixture,
  UNK_CONFLICT_A_X_U1,
  UNK_CONFLICT_A_Y_U2,
} from "../../__support__/seed-unknown-items";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A_ADMIN_USER = "0a000000-0000-7000-8000-000006100001";
const TENANT_B_ADMIN_USER = "0b000000-0000-7000-8000-000006100002";

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
        `\n[T610 alias-conflict.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set — suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);
  await seedAliasConflictFixture(env);

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
  // GlobalExceptionFilter only — do NOT add IdempotencyMismatchFilter globally
  // (avoids the PR #349 latent harness issue documented in wave-status.md).
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
// T610 — FR-040 + FR-041 + FR-042 + FR-043 + cross-tenant probe
// ---------------------------------------------------------------------------

describe("T610 / 005-WAVE2-CONFLICT — alias-conflict safety floor (RED until LINK-HAPPY)", () => {
  // ----- Sub-scenario 1: Alias-conflict primary case (FR-040 + FR-042) -----
  describe("sub-scenario 1: TENANT_A admin links U1 (STORE_A_X) to PRODUCT_A_ACTIVE — store-scoped barcode conflict", () => {
    it(
      "returns 409 alias_conflict when barcode value already has a store-scoped alias at the same store [FR-040]",
      async () => {
        if (dockerSkipped) return;

        // U1 lives at STORE_A_X; the link path writes a STORE_A_X-scoped alias
        // which collides with the seeded store-scoped alias for this barcode.
        // The store context must match U1's store so RLS (app.current_store)
        // permits the read and the conflict fires at the store-scoped partition.
        contextGuard.tenantId = TENANT_A;
        contextGuard.storeId = STORE_A_X;
        contextGuard.userId = TENANT_A_ADMIN_USER;

        const res = await http()
          .post(LINK_URL(UNK_CONFLICT_A_X_U1))
          .send(LINK_BODY);

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          error: {
            code: "alias_conflict",
          },
        });
      },
    );

    it(
      "does NOT disclose the conflicting product name in the 409 response [FR-042]",
      async () => {
        if (dockerSkipped) return;

        contextGuard.tenantId = TENANT_A;
        contextGuard.storeId = STORE_A_X;
        contextGuard.userId = TENANT_A_ADMIN_USER;

        const res = await http()
          .post(LINK_URL(UNK_CONFLICT_A_X_U1))
          .send(LINK_BODY);

        // Response body must not contain any product name or product_id from
        // the conflicting alias row (non-disclosing per FR-042).
        expect(res.status).toBe(409);
        const bodyStr = JSON.stringify(res.body);
        expect(bodyStr).not.toMatch(/T340 Product A-Active/i);
        expect(bodyStr).not.toMatch(PRODUCT_A_ACTIVE);
      },
    );

    it(
      "leaves U1 resolution_status as 'pending' after alias_conflict [FR-040]",
      async () => {
        if (dockerSkipped) return;
        if (!env) throw new Error("env not initialised");

        contextGuard.tenantId = TENANT_A;
        contextGuard.storeId = STORE_A_X;
        contextGuard.userId = TENANT_A_ADMIN_USER;

        await http()
          .post(LINK_URL(UNK_CONFLICT_A_X_U1))
          .send(LINK_BODY);

        const row = await env.admin.query<{ resolution_status: string }>(
          `SELECT resolution_status FROM unknown_items WHERE id = $1`,
          [UNK_CONFLICT_A_X_U1],
        );
        expect(row.rows[0]?.resolution_status).toBe("pending");
      },
    );

    it(
      "does NOT add a new product_aliases row after alias_conflict [FR-040]",
      async () => {
        if (dockerSkipped) return;
        if (!env) throw new Error("env not initialised");

        // Count aliases for TENANT_A before (dynamic baseline — includes the
        // store-scoped conflict alias seeded by seedAliasConflictFixture).
        const before = await env.admin.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM product_aliases WHERE tenant_id = $1`,
          [TENANT_A],
        );
        const countBefore = parseInt(before.rows[0]?.count ?? "0", 10);

        contextGuard.tenantId = TENANT_A;
        contextGuard.storeId = STORE_A_X;
        contextGuard.userId = TENANT_A_ADMIN_USER;

        await http()
          .post(LINK_URL(UNK_CONFLICT_A_X_U1))
          .send(LINK_BODY);

        const after = await env.admin.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM product_aliases WHERE tenant_id = $1`,
          [TENANT_A],
        );
        const countAfter = parseInt(after.rows[0]?.count ?? "0", 10);

        // No new alias row should be created on conflict
        expect(countAfter).toBe(countBefore);
      },
    );
  });

  // ----- Sub-scenario 2: Store-scope isolation (FR-040) --------------------
  describe("sub-scenario 2: store-scope isolation — U2 from a different store does NOT conflict [FR-040]", () => {
    it(
      "U2 with same barcode at a different store (STORE_A_Y) succeeds (200) — store-scoped partition",
      async () => {
        if (dockerSkipped) return;

        // U2 lives at STORE_A_Y and shares (identifier_type='barcode',
        // value='T340-A-BAR-001') with U1. The link path writes the new alias
        // with store_id = the item's store, so linking U2 produces a
        // STORE_A_Y-scoped alias. The seeded conflict alias is at STORE_A_X,
        // a DIFFERENT partition of the store-scoped partial unique index
        // (WHERE store_id IS NOT NULL), so there is no collision. Per FR-040
        // store-scoped partitioning, the link succeeds and U2 resolves.
        contextGuard.tenantId = TENANT_A;
        contextGuard.storeId = STORE_A_Y;
        contextGuard.userId = TENANT_A_ADMIN_USER;

        const res = await http()
          .post(LINK_URL(UNK_CONFLICT_A_Y_U2))
          .send(LINK_BODY);

        expect(res.status).toBe(200);
      },
    );
  });

  // ----- Sub-scenario 3: FR-043 counter deferred to T650 -------------------
  it.todo(
    "FR-043: catalog_duplicate_alias_conflict_total increments on alias_conflict — " +
      "DEFERRED to T650 / 005-WAVE2-METRICS. " +
      "Counter is NOT yet registered in CATALOG_METRIC_NAMES (api.metrics.ts:397-401 " +
      "confirms only 3 Wave 1 counters: unknown_item_captured_total, " +
      "unknown_item_resolved_total, idempotency_token_mismatch_total). " +
      "Per tasks.md Phase 3 Note (line 436): register counter in WAVE2-METRICS slice " +
      "(allowed_files includes api.metrics.ts). Do NOT add to api.metrics.ts here.",
  );

  // ----- Sub-scenario 4: Cross-tenant probe (FR-051/052 non-disclosing) ----
  describe("sub-scenario 4: cross-tenant probe — 404 non-disclosing [SI-004 / FR-051]", () => {
    it(
      "TENANT_B admin attempting to link TENANT_A's unknown item receives 404 (non-disclosing)",
      async () => {
        if (dockerSkipped) return;

        // Switch to TENANT_B context — U1 belongs to TENANT_A.
        // Service must return 404 (not 403, not 409) so no information
        // about the item's existence leaks to TENANT_B.
        contextGuard.tenantId = TENANT_B;
        contextGuard.storeId = null;
        contextGuard.userId = TENANT_B_ADMIN_USER;

        const res = await http()
          .post(LINK_URL(UNK_CONFLICT_A_X_U1))
          .send({ product_id: "0b000000-0000-7000-8000-00000000b401" });

        // 404 is the correct result. Currently 404 for "route not found";
        // after LINK-HAPPY: 404 because the service cannot find the item
        // in TENANT_B's RLS scope — same status, different cause.
        expect(res.status).toBe(404);
        // Body must not expose 'alias_conflict' — the item should appear
        // non-existent, not conflicting.
        if (res.body?.error?.code !== undefined) {
          expect(res.body.error.code).not.toBe("alias_conflict");
        }
      },
    );
  });
});
