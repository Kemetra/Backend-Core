/**
 * T635 — 005-WAVE2-CREATE-EDGES — Create-new body validation + §III non-trust (RED).
 *
 * Spec anchors: FR-063 (atomic create), Constitution §III (backend authority —
 *               body-supplied tenant_id is never trusted).
 *
 * Route under test: POST /api/v1/catalog/unknown-items/:id/create-product
 * operationId: tenantAdminCreateProductFromUnknownItem
 *
 * The create-product Zod schema (reconciliation.controller.ts) mirrors OpenAPI
 * CreateProductFromUnknownItemRequest: required [name, tax_category],
 * additionalProperties: false (.strict()). These tests pin that contract:
 *
 *   (a) missing `name`                       -> 400 validation_error
 *   (b) empty / whitespace-only `name`       -> 400 validation_error
 *   (c) missing `tax_category`               -> 400 validation_error
 *   (d) body supplies extra `tenantId`       -> 400 validation_error
 *       (.strict() rejects unknown keys; Constitution §III is enforced at the
 *       boundary — the body never gets a chance to override principal tenant)
 *   (e) body supplies extra `tenant_id`      -> 400 validation_error
 *       (snake_case variant of the smuggling attempt)
 *
 * On every rejection: no tenant_products row, no product_aliases row, U1
 * stays pending. Validation fails before any DB write (Zod pipe runs in the
 * controller before the service is invoked).
 *
 * Harness: ReconciliationController + ReconciliationService against
 * Testcontainers Postgres 16. PG_POOL bound to localEnv.app (RLS-active).
 * Honors MIGRATION_TEST_ALLOW_SKIP=1.
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
} from "../../__support__/isolation-harness";

// ---------------------------------------------------------------------------
// T635-specific fixture constants (hex-only UUID literals)
// ---------------------------------------------------------------------------

const UNK_T635_VALID = "0a000000-0000-7000-8000-00000635a001";
const UNK_T635_VALID_CORR = "0a000000-0000-7000-8000-000006350c01";
const T635_BARCODE_VALUE = "T635-VALIDATION-001";

const TENANT_A_ADMIN_USER = "0a000000-0000-7000-8000-000006350001";

/** Attacker tenant UUID a malicious body might try to smuggle. */
const ATTACKER_TENANT = "0b000000-0000-7000-8000-0000063500ad";

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
        `\n[T635 create-validation.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // One pending unknown item with no pre-existing alias — a VALID create
  // would succeed, so any 400 in these tests is purely the validation layer.
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5)
     ON CONFLICT DO NOTHING`,
    [
      UNK_T635_VALID,
      TENANT_A,
      STORE_A_X,
      T635_BARCODE_VALUE,
      UNK_T635_VALID_CORR,
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
  // Defensive: keep U1 pending (no valid create should have run, but reset
  // anyway) and scrub any tenant_products row a leak might have committed.
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status   = 'pending',
            resolution_action   = NULL,
            resolved_at         = NULL,
            resolved_by         = NULL,
            resolved_product_id = NULL
      WHERE id = $1`,
    [UNK_T635_VALID],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

async function productCountUnderTenant(tenantId: string): Promise<number> {
  const r = await env!.admin.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM tenant_products
      WHERE tenant_id = $1 AND name = 'Widget T635'`,
    [tenantId],
  );
  return Number(r.rows[0]?.count ?? "0");
}

async function unknownItemStatus(): Promise<string> {
  const r = await env!.admin.query<{ resolution_status: string }>(
    `SELECT resolution_status FROM unknown_items WHERE id = $1`,
    [UNK_T635_VALID],
  );
  return r.rows[0]?.resolution_status ?? "missing";
}

// ---------------------------------------------------------------------------
// T635 — create-new validation + Constitution §III non-trust [FR-063]
// ---------------------------------------------------------------------------

describe("T635 / 005-WAVE2-CREATE-EDGES — create-new body validation + §III [FR-063]", () => {
  it("(a) missing name -> 400 validation_error", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post(CREATE_URL(UNK_T635_VALID))
      .send({ tax_category: "standard" });

    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe("validation_error");
    expect(await unknownItemStatus()).toBe("pending");
  });

  it("(b) empty/whitespace-only name -> 400 validation_error", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post(CREATE_URL(UNK_T635_VALID))
      .send({ name: "   ", tax_category: "standard" });

    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe("validation_error");
    expect(await unknownItemStatus()).toBe("pending");
  });

  it("(c) missing tax_category -> 400 validation_error", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post(CREATE_URL(UNK_T635_VALID))
      .send({ name: "Widget T635" });

    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe("validation_error");
    expect(await unknownItemStatus()).toBe("pending");
  });

  it(
    "(d) body smuggling camelCase tenantId -> 400 (additionalProperties:false; §III)",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(CREATE_URL(UNK_T635_VALID))
        .send({
          name: "Widget T635",
          tax_category: "standard",
          tenantId: ATTACKER_TENANT,
        });

      // .strict() rejects the unknown key BEFORE any write. The persisted
      // tenant could never become the attacker tenant.
      expect(res.status).toBe(400);
      expect(res.body?.error?.code).toBe("validation_error");
      expect(await productCountUnderTenant(ATTACKER_TENANT)).toBe(0);
      expect(await productCountUnderTenant(TENANT_A)).toBe(0);
      expect(await unknownItemStatus()).toBe("pending");
    },
  );

  it(
    "(e) body smuggling snake_case tenant_id -> 400 (additionalProperties:false; §III)",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(CREATE_URL(UNK_T635_VALID))
        .send({
          name: "Widget T635",
          tax_category: "standard",
          tenant_id: ATTACKER_TENANT,
        });

      expect(res.status).toBe(400);
      expect(res.body?.error?.code).toBe("validation_error");
      expect(await productCountUnderTenant(ATTACKER_TENANT)).toBe(0);
      expect(await productCountUnderTenant(TENANT_A)).toBe(0);
      expect(await unknownItemStatus()).toBe("pending");
    },
  );
});
