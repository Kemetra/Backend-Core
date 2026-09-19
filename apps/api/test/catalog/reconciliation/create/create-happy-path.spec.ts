/**
 * T630 — 005-WAVE2-CREATE-HAPPY — Tenant admin creates new product from
 * unknown item (GREEN path).
 *
 * Spec anchors: FR-060, FR-061, FR-062, FR-063, FR-080, FR-081,
 *               Constitution §III (backend authority on tenant_id).
 *
 * Route under test: POST /api/v1/catalog/unknown-items/:id/create-product
 * operationId: tenantAdminCreateProductFromUnknownItem
 * Source of truth: packages/contracts/openapi/catalog/unknown-items.yaml
 *
 * Sub-cases:
 *   (a) Happy path — new tenant_products row + new product_aliases row +
 *       unknown_items transitioned to resolved/created. Audit emits
 *       exactly one `unknown_item.resolved.created` event AND zero
 *       `catalog.product.create` events (dual-emission guard per
 *       tasks.md L477).
 *   (b) Constitution §III non-trust — body-supplied tenantId is rejected
 *       by the `.strict()` Zod schema (additionalProperties: false per
 *       OpenAPI L754).
 *   (c) unknown_item_resolved_total{action='created'} counter increments
 *       exactly once on success.
 *   (d) [todo] atomicity (T662 ownership): a fault between the
 *       tenant_products INSERT and the product_aliases INSERT must roll
 *       back both. The PG-level transactional rollback inside
 *       runWithTenantContext covers this; explicit fault injection is
 *       deferred to T662.
 *
 * Harness:
 *   ReconciliationController + ReconciliationService against a
 *   Testcontainers Postgres 16 pool. AuditEmitterInterceptor with a
 *   SpyAuditEnqueuer, no IdempotencyInterceptor. PG_POOL bound to
 *   `localEnv.app` (RLS-active) per PR #357 audit pattern.
 *
 * Docker: Testcontainers Postgres 16. Honors MIGRATION_TEST_ALLOW_SKIP=1.
 *
 * Fixture (seeded inline in beforeAll):
 *   - One pending unknown_items row UNK_T630_HAPPY in TENANT_A / STORE_A_X
 *     with identifier_type='barcode', value='T630-CREATE-001'.
 *     No product_aliases row exists for this barcode — create should succeed.
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
} from "../../__support__/isolation-harness";

// ---------------------------------------------------------------------------
// T630-specific fixture constants
// ---------------------------------------------------------------------------

/** Pending unknown item seeded by this spec's beforeAll. */
const UNK_T630_HAPPY = "0a000000-0000-7000-8000-00000630a001";
const UNK_T630_HAPPY_CORR = "0a000000-0000-7000-8000-000006300c01";
const UNK_T630_BARCODE_VALUE = "T630-CREATE-001";

const TENANT_A_ADMIN_USER = "0a000000-0000-7000-8000-000006300001";

const CREATE_URL = (id: string) =>
  `/api/v1/catalog/unknown-items/${id}/create-product`;

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
        `\n[T630 create-happy-path.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Seed T630-specific fixture: one pending unknown item with no
  // pre-existing alias — create should succeed cleanly.
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5)
     ON CONFLICT DO NOTHING`,
    [
      UNK_T630_HAPPY,
      TENANT_A,
      STORE_A_X,
      UNK_T630_BARCODE_VALUE,
      UNK_T630_HAPPY_CORR,
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
      // RLS-active pool (PR #357 audit pattern). The
      // ReconciliationService runs INSERTs under
      // runWithTenantContext which sets app.current_tenant.
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
  // Reset the T630 fixture row back to pending after each test so sub-cases
  // run against a clean slate.
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status   = 'pending',
            resolution_action   = NULL,
            resolved_at         = NULL,
            resolved_by         = NULL,
            resolved_product_id = NULL
      WHERE id = $1`,
    [UNK_T630_HAPPY],
  );
  // Remove any product_aliases rows created by these tests.
  await env.admin.query(
    `DELETE FROM product_aliases
      WHERE tenant_id = $1
        AND value     = $2`,
    [TENANT_A, UNK_T630_BARCODE_VALUE],
  );
  // Remove any tenant_products rows created by these tests (by name).
  await env.admin.query(
    `DELETE FROM tenant_products
      WHERE tenant_id = $1
        AND name IN ('Widget T630', 'Widget T630B')`,
    [TENANT_A],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T630 happy path tests
// ---------------------------------------------------------------------------

describe("T630 / 005-WAVE2-CREATE-HAPPY — tenant admin creates product from unknown item [FR-060..063]", () => {
  // -------------------------------------------------------------------------
  // T630-a — happy path full assertion bundle
  // -------------------------------------------------------------------------

  it(
    "(a) creates new tenant_products + product_aliases + resolves unknown_item with exactly one audit event 'unknown_item.resolved.created' (and zero 'catalog.product.create')",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(CREATE_URL(UNK_T630_HAPPY))
        .send({ name: "Widget T630", tax_category: "standard" });

      // Per OpenAPI L478: 201 Created with UnknownItem body.
      expect(res.status).toBe(201);

      // Response is the UnknownItem shape — not a product.
      expect(res.body).toMatchObject({
        id: UNK_T630_HAPPY,
        tenant_id: TENANT_A,
        store_id: STORE_A_X,
        identifier_type: "barcode",
        identifier_value: UNK_T630_BARCODE_VALUE,
        resolution_status: "resolved",
        resolution_action: "created",
      });
      expect(typeof res.body.resolved_product_id).toBe("string");
      expect(res.body.resolved_product_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      const newProductId: string = res.body.resolved_product_id;

      // DB invariants ------------------------------------------------------

      // 1. exactly one new tenant_products row
      const productCheck = await env!.admin.query<{
        id: string;
        tenant_id: string;
        name: string;
        tax_category: string;
        retired_at: Date | null;
      }>(
        `SELECT id, tenant_id, name, tax_category, retired_at
           FROM tenant_products
          WHERE id = $1`,
        [newProductId],
      );
      expect(productCheck.rows).toHaveLength(1);
      expect(productCheck.rows[0]).toMatchObject({
        id: newProductId,
        tenant_id: TENANT_A,
        name: "Widget T630",
        tax_category: "standard",
        retired_at: null,
      });

      // 2. exactly one new product_aliases row binding the barcode
      const aliasCheck = await env!.admin.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM product_aliases
          WHERE tenant_id       = $1
            AND product_id      = $2
            AND identifier_type = 'barcode'
            AND value           = $3
            AND store_id        = $4`,
        [TENANT_A, newProductId, UNK_T630_BARCODE_VALUE, STORE_A_X],
      );
      expect(aliasCheck.rows[0]?.count).toBe("1");

      // 3. unknown_items transitioned to resolved/created
      const itemCheck = await env!.admin.query<{
        resolution_status: string;
        resolution_action: string;
        resolved_product_id: string;
        resolved_by: string;
      }>(
        `SELECT resolution_status, resolution_action,
                resolved_product_id, resolved_by
           FROM unknown_items
          WHERE id = $1`,
        [UNK_T630_HAPPY],
      );
      expect(itemCheck.rows[0]).toMatchObject({
        resolution_status: "resolved",
        resolution_action: "created",
        resolved_product_id: newProductId,
        resolved_by: TENANT_A_ADMIN_USER,
      });

      // Audit invariants ---------------------------------------------------

      // Drain microtasks to let the AuditEmitterInterceptor's async enqueue
      // settle (same drain pattern as link-happy-path.spec.ts).
      for (let i = 0; i < 50; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      const createdEvents = auditSpy.calls.filter(
        (ev) => ev.action === "unknown_item.resolved.created",
      );
      expect(createdEvents).toHaveLength(1);

      // Dual-emission guard (tasks.md L477): MUST NOT emit
      // `catalog.product.create` from this surface — that subject belongs
      // exclusively to TenantCatalogService.create, which is NOT called.
      const productCreateEvents = auditSpy.calls.filter(
        (ev) => ev.action === "catalog.product.create",
      );
      expect(productCreateEvents).toHaveLength(0);
    },
  );

  // -------------------------------------------------------------------------
  // T630-b — Constitution §III backend authority on tenant_id
  // -------------------------------------------------------------------------

  it(
    "(b) rejects body-supplied tenantId with 400 validation_error (Zod .strict() per OpenAPI additionalProperties: false)",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(CREATE_URL(UNK_T630_HAPPY))
        .send({
          name: "Widget T630B",
          tax_category: "standard",
          tenantId: "00000000-0000-0000-0000-000000000bad",
        });

      // OpenAPI L754 — additionalProperties: false. The Zod .strict() on
      // CreateProductFromUnknownItemRequestSchema turns this into a 400
      // rather than silently stripping. The envelope code is
      // `validation_error` (ErrorCodes.VALIDATION) — the operating
      // convention emitted by ZodValidationPipe -> GlobalExceptionFilter.
      // OpenAPI and runtime both use the platform `validation_error` code.
      expect(res.status).toBe(400);
      expect(res.body?.error?.code).toBe("validation_error");

      // Tenant-scoped: confirm no product was persisted under the
      // attacker tenant. The .strict() Zod rejection ensures the
      // request never reaches the service in the first place, so no
      // tenant_products row should exist for ANY tenant under this
      // name AND specifically not under the attacker tenant_id.
      const noLeakCheck = await env!.admin.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM tenant_products
          WHERE tenant_id = $1
            AND name = $2`,
        ["00000000-0000-0000-0000-000000000bad", "Widget T630B"],
      );
      expect(noLeakCheck.rows[0]?.count).toBe("0");

      // The unknown_items row remains pending.
      const stillPending = await env!.admin.query<{
        resolution_status: string;
      }>(
        `SELECT resolution_status FROM unknown_items WHERE id = $1`,
        [UNK_T630_HAPPY],
      );
      expect(stillPending.rows[0]?.resolution_status).toBe("pending");
    },
  );

  // -------------------------------------------------------------------------
  // T630-c — counter increment
  // -------------------------------------------------------------------------

  it(
    "(c) increments unknown_item_resolved_total{action='created'} exactly once",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(CREATE_URL(UNK_T630_HAPPY))
        .send({ name: "Widget T630", tax_category: "standard" });

      expect(res.status).toBe(201);

      // Drain microtasks — recordUnknownItemResolved is synchronous in the
      // service handler, but setImmediate ensures no pending microtask
      // queue surprises (mirrors link-happy-path.spec.ts drain).
      for (let i = 0; i < 50; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(resolvedCount).toBe(1);
      expect(resolvedSpy).toHaveBeenCalledWith({ action: "created" });
    },
  );

  // -------------------------------------------------------------------------
  // T630-d — atomicity (deferred to T662)
  // -------------------------------------------------------------------------

  it.todo(
    "(d) atomicity: alias INSERT failure rolls back tenant_products INSERT + unknown_items UPDATE (T662 ownership)",
  );
});
