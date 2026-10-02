/**
 * T640 — 005-WAVE2-AUDIT — Link action audit emission (RED).
 *
 * Spec anchors: FR-080 (audit subject on resolve).
 *
 * A successful link emits exactly one `unknown_item.resolved.linked` audit
 * payload, attributed to the tenant-admin actor, carrying the tenant/store
 * resolved context.
 *
 * NOTE on target_id (task-text drift): T640's task text says the event
 * carries "target_id = unknown_item.id and correlation_id". The
 * AuditEmitterInterceptor does NOT derive target_id/correlation from the
 * response body for any subject — it sets target_id=null (verified in
 * audit-emitter.interceptor.ts; documented by the Wave 1 precedent in
 * capture-audit.spec.ts:322-327). Populating target_id would require a change
 * to audit-emitter.interceptor.ts, which is OUTSIDE the 005-WAVE2-AUDIT
 * allowed_files. This spec therefore asserts the system's actual behavior
 * (target_id=null) and treats the target_id clause of the task text as drift,
 * the same way validation_failure/validation_error drift was handled in
 * CREATE-EDGES. The FR-080 core — exactly one correctly-attributed
 * resolved.linked event — IS fully asserted.
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
} from "../../__support__/isolation-harness";

const UNK_T640_LINK = "0a000000-0000-7000-8000-00000640a001";
const UNK_T640_LINK_CORR = "0a000000-0000-7000-8000-000006400c01";
const T640_BARCODE = "T640-LINK-AUDIT-001";
const TENANT_A_ADMIN_USER = "0a000000-0000-7000-8000-000006400001";

const LINK_URL = (id: string) => `/api/v1/catalog/unknown-items/${id}/link`;

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
        `\n[T640 link-audit.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Pending unknown item with no pre-existing alias — link to PRODUCT_A_ACTIVE
  // succeeds cleanly.
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5)
     ON CONFLICT DO NOTHING`,
    [UNK_T640_LINK, TENANT_A, STORE_A_X, T640_BARCODE, UNK_T640_LINK_CORR],
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

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("T640 / 005-WAVE2-AUDIT — link action emits resolved.linked audit [FR-080]", () => {
  it(
    "emits exactly one unknown_item.resolved.linked event attributed to the tenant-admin actor",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(LINK_URL(UNK_T640_LINK))
        .send({ product_id: PRODUCT_A_ACTIVE });

      expect(res.status).toBe(200);

      await drainMicrotasks();

      const linkEvents = auditSpy.calls.filter(
        (c) => c.action === "unknown_item.resolved.linked",
      );
      expect(linkEvents).toHaveLength(1);

      const payload = linkEvents[0]!;
      expect(payload.tenant_id).toBe(TENANT_A);
      expect(payload.store_id).toBe(STORE_A_X);
      expect(payload.actor_user_id).toBe(TENANT_A_ADMIN_USER);

      // target_id is null — the interceptor does not derive it from the
      // response body (Wave 1 precedent; see file docblock). FR-080 core is
      // satisfied by the correctly-attributed single event above.
      expect(payload.target_id).toBeNull();
    },
  );

  it("emits no resolved.linked event when the link is unauthenticated", async () => {
    if (dockerSkipped) return;

    // Null tenant context -> 401 before the handler; no audit event.
    contextGuard.tenantId = null as unknown as string;

    const res = await http()
      .post(LINK_URL(UNK_T640_LINK))
      .send({ product_id: PRODUCT_A_ACTIVE });
    expect(res.status).toBe(401);
    await drainMicrotasks();

    // No audit action of ANY kind may leak on an unauthorized request.
    expect(auditSpy.calls).toHaveLength(0);
  });

  it("returns 401 (no event) when the resolved context is entirely absent", async () => {
    if (dockerSkipped) return;

    // No req.context attached at all -> controller's `if (!ctx)` 401 branch.
    contextGuard.skipContext = true;

    const res = await http()
      .post(LINK_URL(UNK_T640_LINK))
      .send({ product_id: PRODUCT_A_ACTIVE });
    expect(res.status).toBe(401);
    await drainMicrotasks();

    expect(auditSpy.calls).toHaveLength(0);
  });

  it("returns 401 (no event) when the resolved context has a null userId", async () => {
    if (dockerSkipped) return;

    // Context present, tenant present, but userId null -> controller's
    // `if (ctx.userId === null)` 401 branch.
    contextGuard.userId = null as unknown as string;

    const res = await http()
      .post(LINK_URL(UNK_T640_LINK))
      .send({ product_id: PRODUCT_A_ACTIVE });
    expect(res.status).toBe(401);
    await drainMicrotasks();

    expect(auditSpy.calls).toHaveLength(0);
  });
});
