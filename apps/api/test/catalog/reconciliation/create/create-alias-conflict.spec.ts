/**
 * T633 — 005-WAVE2-CREATE-EDGES — Create-new product with alias conflict (RED).
 *
 * Spec anchors: FR-040 (alias uniqueness), FR-042 (non-disclosing conflict),
 *               FR-062 (create-new fails closed — neither product nor alias
 *               created), FR-063 (atomicity).
 *
 * Route under test: POST /api/v1/catalog/unknown-items/:id/create-product
 * operationId: tenantAdminCreateProductFromUnknownItem
 * Source of truth: packages/contracts/openapi/catalog/unknown-items.yaml
 *
 * Scenario:
 *   A pending unknown item U1 (TENANT_A / STORE_A_X, barcode 'T633-CONFLICT-001')
 *   shares its identifier with a pre-existing STORE-SCOPED product_aliases row
 *   bound to PRODUCT_A_ACTIVE at STORE_A_X. The create-new path writes the new
 *   alias with store_id = the unknown item's store (reconciliation.service.ts:
 *   "store_id carries the item's store"). Creating a product from U1 therefore
 *   reproduces (TENANT_A, STORE_A_X, 'barcode', 'T633-CONFLICT-001') and
 *   violates the store-scoped partial unique index (WHERE store_id IS NOT NULL)
 *   -> 23505 -> alias_conflict.
 *
 *   This is the same FR-040 store-partitioning model corrected in PR #366 for
 *   the LINK conflict spec. The seeded conflicting alias MUST be store-scoped
 *   at STORE_A_X (not tenant-wide) to land in the same partition the create
 *   path writes.
 *
 * Sub-cases:
 *   (a) Returns 409 with error.code='alias_conflict' (FR-062).
 *   (b) FR-062 atomicity: NO new tenant_products row is created (the prior
 *       INSERT INTO tenant_products is rolled back by the AliasConflictSentinel
 *       throw — PR #365 transaction-boundary fix).
 *   (c) U1 remains 'pending'; no lifecycle transition (FR-062 fail-closed).
 *   (d) FR-042 non-disclosure: the conflicting product (PRODUCT_A_ACTIVE) and
 *       its name are NOT named in the response body.
 *   (e) [todo] FR-043 counter: catalog_duplicate_alias_conflict_total is not
 *       yet registered in CATALOG_METRIC_NAMES (api.metrics.ts confirms only
 *       3 Wave 1 counters). Deferred to T650 / 005-WAVE2-METRICS, which owns
 *       api.metrics.ts and registers the counter. Mirrors the same deferral in
 *       alias-conflict.spec.ts (T610).
 *
 * Harness: ReconciliationController + ReconciliationService against
 * Testcontainers Postgres 16. PG_POOL bound to localEnv.app (RLS-active per
 * PR #357 audit pattern). Honors MIGRATION_TEST_ALLOW_SKIP=1.
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
// T633-specific fixture constants (hex-only UUID literals)
// ---------------------------------------------------------------------------

/** Pending unknown item in TENANT_A / STORE_A_X — barcode 'T633-CONFLICT-001'. */
const UNK_T633_CONFLICT = "0a000000-0000-7000-8000-00000633c001";
const UNK_T633_CONFLICT_CORR = "0a000000-0000-7000-8000-000006330c01";
const T633_BARCODE_VALUE = "T633-CONFLICT-001";

/** Store-scoped product_aliases row bound to PRODUCT_A_ACTIVE at STORE_A_X. */
const ALIAS_T633_SCOPED = "0a000000-0000-7000-8000-000006330a01";

const TENANT_A_ADMIN_USER = "0a000000-0000-7000-8000-000006330001";

const CREATE_URL = (id: string) =>
  `/api/v1/catalog/unknown-items/${id}/create-product`;

const CREATE_BODY = { name: "Widget T633", tax_category: "standard" };

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

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T633 create-alias-conflict.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Seed a STORE-SCOPED conflicting alias at STORE_A_X bound to
  // PRODUCT_A_ACTIVE. Per FR-040, the create path writes the new alias with
  // store_id = the unknown item's store (STORE_A_X), so this seeded row lands
  // in the same store-scoped partition -> 23505 on create. Tenant-wide would
  // be the WRONG partition (see PR #366 for the LINK-side correction).
  await env.admin.query(
    `INSERT INTO product_aliases
       (id, tenant_id, product_id, identifier_type, value,
        source_system, store_id, created_by)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, $5, $6)
     ON CONFLICT DO NOTHING`,
    [
      ALIAS_T633_SCOPED,
      TENANT_A,
      PRODUCT_A_ACTIVE,
      T633_BARCODE_VALUE,
      STORE_A_X,
      TENANT_A_ADMIN_USER,
    ],
  );

  // Seed the pending unknown item sharing the conflicting barcode at STORE_A_X.
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5)
     ON CONFLICT DO NOTHING`,
    [
      UNK_T633_CONFLICT,
      TENANT_A,
      STORE_A_X,
      T633_BARCODE_VALUE,
      UNK_T633_CONFLICT_CORR,
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
  // Defensive: reset U1 to pending and scrub any tenant_products /
  // product_aliases rows a leaking test may have created for this barcode.
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status   = 'pending',
            resolution_action   = NULL,
            resolved_at         = NULL,
            resolved_by         = NULL,
            resolved_product_id = NULL
      WHERE id = $1`,
    [UNK_T633_CONFLICT],
  );
  // Remove any product_aliases for this barcode EXCEPT the seeded conflict row.
  await env.admin.query(
    `DELETE FROM product_aliases
      WHERE tenant_id = $1
        AND value     = $2
        AND id       <> $3`,
    [TENANT_A, T633_BARCODE_VALUE, ALIAS_T633_SCOPED],
  );
  // Remove any tenant_products row a leaking create may have committed.
  await env.admin.query(
    `DELETE FROM tenant_products
      WHERE tenant_id = $1
        AND name      = $2`,
    [TENANT_A, CREATE_BODY.name],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

async function productCount(name: string): Promise<number> {
  const r = await env!.admin.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM tenant_products
      WHERE tenant_id = $1 AND name = $2`,
    [TENANT_A, name],
  );
  return Number(r.rows[0]?.count ?? "0");
}

async function unknownItemStatus(): Promise<string> {
  const r = await env!.admin.query<{ resolution_status: string }>(
    `SELECT resolution_status FROM unknown_items WHERE id = $1`,
    [UNK_T633_CONFLICT],
  );
  return r.rows[0]?.resolution_status ?? "missing";
}

// ---------------------------------------------------------------------------
// T633 — create-new alias conflict [FR-040, FR-042, FR-062, FR-063]
// ---------------------------------------------------------------------------

describe("T633 / 005-WAVE2-CREATE-EDGES — create-new product with store-scoped alias conflict [FR-062]", () => {
  it(
    "(a) returns 409 alias_conflict when the unknown item's identifier already has a store-scoped alias",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(CREATE_URL(UNK_T633_CONFLICT))
        .send(CREATE_BODY);

      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("alias_conflict");
    },
  );

  it(
    "(b) FR-062 atomicity: no new tenant_products row is created on conflict",
    async () => {
      if (dockerSkipped) return;

      const before = await productCount(CREATE_BODY.name);

      const res = await http()
        .post(CREATE_URL(UNK_T633_CONFLICT))
        .send(CREATE_BODY);
      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("alias_conflict");

      // The AliasConflictSentinel throw rolls back the prior
      // INSERT INTO tenant_products (PR #365 transaction-boundary fix).
      expect(await productCount(CREATE_BODY.name)).toBe(before);
    },
  );

  it(
    "(c) U1 remains 'pending' after conflict — fail-closed (FR-062)",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(CREATE_URL(UNK_T633_CONFLICT))
        .send(CREATE_BODY);
      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("alias_conflict");

      expect(await unknownItemStatus()).toBe("pending");
    },
  );

  it(
    "(d) FR-042 non-disclosure: the conflicting product is not named in the response",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(CREATE_URL(UNK_T633_CONFLICT))
        .send(CREATE_BODY);

      expect(res.status).toBe(409);
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain(PRODUCT_A_ACTIVE);
      expect(bodyStr.toLowerCase()).not.toMatch(/product a-active/i);
    },
  );

  // (e) FR-043 counter — deferred to T650 / 005-WAVE2-METRICS, which owns
  // api.metrics.ts and registers catalog_duplicate_alias_conflict_total.
  it.todo(
    "(e) FR-043: catalog_duplicate_alias_conflict_total increments on conflict — " +
      "deferred to T650 (counter not yet registered in CATALOG_METRIC_NAMES)",
  );

  // -------------------------------------------------------------------------
  // Create-path discriminator coverage: not_found + already_reconciled.
  // These exercise the two non-conflict early-return branches of
  // createProductFromUnknownItem (service steps 1+2) so the full
  // discriminated union (ok / not_found / already_reconciled / alias_conflict)
  // is covered. Mirrors the link path's edge specs.
  // -------------------------------------------------------------------------

  it(
    "(f) create from a non-existent unknown item -> 404 non-disclosing (not_found)",
    async () => {
      if (dockerSkipped) return;

      const FABRICATED = "0a000000-0000-7000-8000-0000063300ff";
      const res = await http()
        .post(CREATE_URL(FABRICATED))
        .send({ name: "Widget T633F", tax_category: "standard" });

      // SI-001 / FR-092 non-disclosing 404 — does not reveal whether the
      // unknown item exists. No product created.
      expect(res.status).toBe(404);
      expect(await productCount("Widget T633F")).toBe(0);
    },
  );

  it(
    "(g) create from an already-resolved item -> 409 already_reconciled",
    async () => {
      if (dockerSkipped) return;
      if (!env) throw new Error("env not initialised");

      // Pre-resolve U1 directly via the superuser pool to simulate a
      // concurrent resolution before this create attempt (FR-004 monotonic
      // lifecycle). Mirrors link-already-reconciled.spec.ts.
      await env.admin.query(
        `UPDATE unknown_items
            SET resolution_status   = 'resolved',
                resolution_action   = 'created',
                resolved_at         = now(),
                resolved_by         = $2,
                resolved_product_id = $3
          WHERE id = $1`,
        [UNK_T633_CONFLICT, TENANT_A_ADMIN_USER, PRODUCT_A_ACTIVE],
      );

      const res = await http()
        .post(CREATE_URL(UNK_T633_CONFLICT))
        .send({ name: "Widget T633G", tax_category: "standard" });

      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("already_reconciled");
      // No product created for the resolved item.
      expect(await productCount("Widget T633G")).toBe(0);
      // afterEach resets U1 back to pending for any subsequent run.
    },
  );
});
