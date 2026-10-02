/**
 * T642 — 005-WAVE2-AUDIT — Create-new action audit emission + dual-emission guard (RED).
 *
 * Spec anchors: FR-080 (audit subject on resolve), tasks.md L477 (no
 *               dual-emission of catalog.product.create).
 *
 * A successful create-new emits exactly one `unknown_item.resolved.created`
 * audit payload AND zero `catalog.product.create` payloads. The dual-emission
 * guard is the reason createProductFromUnknownItem owns the raw
 * INSERT INTO tenant_products rather than calling TenantCatalogService.create
 * (which emits its own catalog.product.create audit row in-transaction). This
 * spec's catalog.product.create==0 assertion is the regression tripwire that
 * would catch a future refactor reintroducing that call.
 *
 * Harness: ReconciliationController + ReconciliationService against
 * Testcontainers Postgres 16. AuditEmitterInterceptor + SpyAuditEnqueuer.
 * PG_POOL bound to localEnv.app (RLS-active). Honors MIGRATION_TEST_ALLOW_SKIP=1.
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
  CATEGORY_A,
} from "../../__support__/isolation-harness";

const UNK_T642_CREATE = "0a000000-0000-7000-8000-00000642a001";
const UNK_T642_CREATE_CORR = "0a000000-0000-7000-8000-000006420c01";
const T642_BARCODE = "T642-CREATE-AUDIT-001";

// alias_conflict rejection fixture: store-scoped alias + item sharing it.
const UNK_T642_CONFLICT = "0a000000-0000-7000-8000-00000642a002";
const UNK_T642_CONFLICT_CORR = "0a000000-0000-7000-8000-000006420c02";
const T642_CONFLICT_BARCODE = "T642-CONFLICT-001";
const ALIAS_T642_SCOPED = "0a000000-0000-7000-8000-000006420aa1";

// already_reconciled rejection fixture: pre-resolved item.
const UNK_T642_RESOLVED = "0a000000-0000-7000-8000-00000642a003";
const UNK_T642_RESOLVED_CORR = "0a000000-0000-7000-8000-000006420c03";
const T642_RESOLVED_BARCODE = "T642-RESOLVED-001";

const TENANT_A_ADMIN_USER = "0a000000-0000-7000-8000-000006420001";

const CREATE_URL = (id: string) =>
  `/api/v1/catalog/unknown-items/${id}/create-product`;
const CREATE_BODY = { name: "Widget T642", tax_category: "standard" };
const REJECTION_ACTION = "unknown_item.reconciliation_conflict_rejected";

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
  public userId: string = TENANT_A_ADMIN_USER;
  /** When true, do NOT attach req.context — exercises the controller's `!ctx` 401. */
  public skipContext = false;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    if (this.skipContext) {
      return true;
    }
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
        `\n[T642 create-audit.spec] Docker NOT AVAILABLE: ${msg}\n` +
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
        source_system, resolution_status, correlation_id)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5)
     ON CONFLICT DO NOTHING`,
    [UNK_T642_CREATE, TENANT_A, STORE_A_X, T642_BARCODE, UNK_T642_CREATE_CORR],
  );

  // Store-scoped alias for the create-path alias_conflict rejection case.
  await env.admin.query(
    `INSERT INTO product_aliases
       (id, tenant_id, product_id, identifier_type, value,
        source_system, store_id, created_by)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, $5, $6)
     ON CONFLICT DO NOTHING`,
    [
      ALIAS_T642_SCOPED, TENANT_A, PRODUCT_A_ACTIVE,
      T642_CONFLICT_BARCODE, STORE_A_X, TENANT_A_ADMIN_USER,
    ],
  );

  // Pending item sharing the conflicting barcode (create -> alias_conflict).
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5)
     ON CONFLICT DO NOTHING`,
    [UNK_T642_CONFLICT, TENANT_A, STORE_A_X, T642_CONFLICT_BARCODE, UNK_T642_CONFLICT_CORR],
  );

  // Pre-resolved item (create -> already_reconciled). Resolved fields must be
  // consistent per unknown_items_resolved_fields_consistent +
  // unknown_items_linked_product_present (0007_catalog.sql:414-425).
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value, source_system,
        resolution_status, resolution_action, resolved_at, resolved_by,
        resolved_product_id, correlation_id)
     VALUES ($1, $2, $3, 'barcode', $4, NULL,
             'resolved', 'created', now(), $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [
      UNK_T642_RESOLVED, TENANT_A, STORE_A_X, T642_RESOLVED_BARCODE,
      TENANT_A_ADMIN_USER, PRODUCT_A_ACTIVE, UNK_T642_RESOLVED_CORR,
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
  contextGuard.skipContext = false;
});

afterEach(async () => {
  if (dockerSkipped || !env) return;
  // Reset U1 to pending + scrub the created product so the test is repeatable.
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status   = 'pending',
            resolution_action   = NULL,
            resolved_at         = NULL,
            resolved_by         = NULL,
            resolved_product_id = NULL
      WHERE id = $1`,
    [UNK_T642_CREATE],
  );
  await env.admin.query(
    `DELETE FROM product_aliases WHERE tenant_id = $1 AND value = $2`,
    [TENANT_A, T642_BARCODE],
  );
  await env.admin.query(
    `DELETE FROM tenant_products WHERE tenant_id = $1 AND name = $2`,
    [TENANT_A, CREATE_BODY.name],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("T642 / 005-WAVE2-AUDIT — create-new emits resolved.created; no dual emission [FR-080]", () => {
  it(
    "emits exactly one unknown_item.resolved.created event attributed to the actor",
    async () => {
      if (dockerSkipped) return;

      const res = await http().post(CREATE_URL(UNK_T642_CREATE)).send(CREATE_BODY);
      expect(res.status).toBe(201);

      await drainMicrotasks();

      const createdEvents = auditSpy.calls.filter(
        (c) => c.action === "unknown_item.resolved.created",
      );
      expect(createdEvents).toHaveLength(1);

      const payload = createdEvents[0]!;
      expect(payload.tenant_id).toBe(TENANT_A);
      expect(payload.store_id).toBe(STORE_A_X);
      expect(payload.actor_user_id).toBe(TENANT_A_ADMIN_USER);
    },
  );

  it(
    "succeeds with a non-null category_id (category passthrough; ?? left branch)",
    async () => {
      if (dockerSkipped) return;

      // Every other create test omits category_id, so the controller's
      // `body.category_id ?? null` only ever takes the nullish (right) side.
      // Sending a real CATEGORY_A FK exercises the present (left) side and
      // confirms the category flows through to the new product.
      const res = await http()
        .post(CREATE_URL(UNK_T642_CREATE))
        .send({ ...CREATE_BODY, category_id: CATEGORY_A });
      expect(res.status).toBe(201);

      await drainMicrotasks();

      const createdEvents = auditSpy.calls.filter(
        (c) => c.action === "unknown_item.resolved.created",
      );
      expect(createdEvents).toHaveLength(1);

      // Prove the passthrough: the newly created product carries CATEGORY_A,
      // not null. Without this, the test would pass even if the controller
      // dropped category_id on the floor.
      const newProductId = res.body?.resolved_product_id as string;
      expect(newProductId).toBeTruthy();
      const productRow = await env!.admin.query<{ category_id: string | null }>(
        `SELECT category_id FROM tenant_products WHERE id = $1`,
        [newProductId],
      );
      expect(productRow.rows[0]?.category_id).toBe(CATEGORY_A);
    },
  );

  it(
    "DUAL-EMISSION GUARD: emits ZERO catalog.product.create events (tasks.md L477)",
    async () => {
      if (dockerSkipped) return;

      const res = await http().post(CREATE_URL(UNK_T642_CREATE)).send(CREATE_BODY);
      expect(res.status).toBe(201);

      await drainMicrotasks();

      // The whole reason createProductFromUnknownItem uses a raw
      // INSERT INTO tenant_products instead of TenantCatalogService.create is
      // to avoid a second `catalog.product.create` audit row. If a future
      // refactor reintroduces that call, this assertion fails loudly.
      const productCreateEvents = auditSpy.calls.filter(
        (c) => c.action === "catalog.product.create",
      );
      expect(productCreateEvents).toHaveLength(0);
    },
  );

  it(
    "create alias_conflict emits reconciliation_conflict_rejected{reason=alias_conflict}",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(CREATE_URL(UNK_T642_CONFLICT))
        .send({ name: "Widget T642C", tax_category: "standard" });
      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("alias_conflict");

      await drainMicrotasks();

      const rejections = auditSpy.calls.filter(
        (c) => c.action === REJECTION_ACTION,
      );
      expect(rejections).toHaveLength(1);
      expect(rejections[0]!.metadata).toMatchObject({ reason: "alias_conflict" });
      expect(rejections[0]!.tenant_id).toBe(TENANT_A);
      expect(rejections[0]!.store_id).toBe(STORE_A_X);
      expect(rejections[0]!.actor_user_id).toBe(TENANT_A_ADMIN_USER);
      // The rejection path must emit ONLY the rejection — never a success
      // resolved.created nor a dual-emission catalog.product.create.
      expect(
        auditSpy.calls.filter((c) => c.action === "unknown_item.resolved.created"),
      ).toHaveLength(0);
      expect(
        auditSpy.calls.filter((c) => c.action === "catalog.product.create"),
      ).toHaveLength(0);
    },
  );

  it(
    "create already_reconciled emits reconciliation_conflict_rejected{reason=already_reconciled}",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(CREATE_URL(UNK_T642_RESOLVED))
        .send({ name: "Widget T642R", tax_category: "standard" });
      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("already_reconciled");

      await drainMicrotasks();

      const rejections = auditSpy.calls.filter(
        (c) => c.action === REJECTION_ACTION,
      );
      expect(rejections).toHaveLength(1);
      expect(rejections[0]!.metadata).toMatchObject({
        reason: "already_reconciled",
      });
      expect(rejections[0]!.tenant_id).toBe(TENANT_A);
      expect(rejections[0]!.store_id).toBe(STORE_A_X);
      expect(rejections[0]!.actor_user_id).toBe(TENANT_A_ADMIN_USER);
      expect(
        auditSpy.calls.filter((c) => c.action === "unknown_item.resolved.created"),
      ).toHaveLength(0);
      expect(
        auditSpy.calls.filter((c) => c.action === "catalog.product.create"),
      ).toHaveLength(0);
    },
  );

  it("returns 401 (no event) when the resolved context is entirely absent", async () => {
    if (dockerSkipped) return;

    // No req.context attached -> controller's `if (!ctx)` 401 branch.
    contextGuard.skipContext = true;

    const res = await http().post(CREATE_URL(UNK_T642_CREATE)).send(CREATE_BODY);
    expect(res.status).toBe(401);
    await drainMicrotasks();

    // No audit action of ANY kind may leak on an unauthorized request.
    expect(auditSpy.calls).toHaveLength(0);
  });

  it("returns 401 (no event) when the resolved context has a null userId", async () => {
    if (dockerSkipped) return;

    // Context + tenant present, userId null -> `if (ctx.userId === null)` 401.
    contextGuard.userId = null as unknown as string;

    const res = await http().post(CREATE_URL(UNK_T642_CREATE)).send(CREATE_BODY);
    expect(res.status).toBe(401);
    await drainMicrotasks();

    expect(auditSpy.calls).toHaveLength(0);
  });

  it("returns 401 (no event) when the resolved context has a null tenantId", async () => {
    if (dockerSkipped) return;

    // Context present, userId present, but tenantId null -> the create route's
    // `if (ctx.tenantId === null)` 401 branch. The link route covers its own
    // copy of this guard; the create route's was previously untested.
    contextGuard.tenantId = null as unknown as string;

    const res = await http().post(CREATE_URL(UNK_T642_CREATE)).send(CREATE_BODY);
    expect(res.status).toBe(401);
    await drainMicrotasks();

    expect(auditSpy.calls).toHaveLength(0);
  });
});
