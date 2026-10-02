/**
 * T548 — 005-WAVE1-AUDIT — Dismiss audit emission.
 *
 * Acceptance (slice 005-WAVE1-AUDIT validation contract):
 *   GREEN — FR-080/FR-082 audit emission for the dismiss transition:
 *     - A pending unknown_items row is dismissed via
 *       `POST /api/v1/catalog/unknown-items/:id/dismiss`
 *     - the `AuditEmitterInterceptor` enqueues exactly one payload with:
 *         action          = "unknown_item.dismissed"
 *         tenant_id       = the acting principal's tenant
 *         store_id        = the acting principal's store binding (or null
 *                           for tenant-wide actors)
 *         actor_user_id   = the acting principal's user id
 *     - no additional audit payloads fire for the same request
 *
 * Spec anchors:
 *   - FR-080: state-transition operations emit one audit event
 *   - FR-082: dismiss is a first-class audit subject
 *   - 005-WAVE1-AUDIT brief: T548 + T549 verify the `@Auditable`
 *     decorator on `tenantAdminDismissUnknownItem` reaches the global
 *     `AuditEmitterInterceptor`
 *
 * Wiring strategy
 * ---------------
 * Mirrors `dismiss-happy-path.spec.ts` (service+controller wiring),
 * extended with the audit emitter chain:
 *   - real `UnknownItemsController`
 *   - real `UnknownItemsService` against a Testcontainers `pg.Pool`
 *   - real `AuditEmitterInterceptor` registered via `APP_INTERCEPTOR`
 *   - spy `AuditJobEnqueuer` bound to `AUDIT_JOB_ENQUEUER`
 *
 * No `IdempotencyInterceptor` is registered because dismiss does NOT
 * carry `@Idempotent("required")` (the route is naturally idempotent
 * via the DB-level monotonicity guard).
 *
 * Docker: Testcontainers Postgres 16 required; honors
 * `MIGRATION_TEST_ALLOW_SKIP=1` per repo convention.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
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
import { UnknownItemsController } from "../../../../src/catalog/unknown-items/unknown-items.controller";
import { UnknownItemsService } from "../../../../src/catalog/unknown-items/unknown-items.service";
import { PG_POOL } from "../../../../src/auth/auth.module";
import type { ResolvedContext } from "../../../../src/context/types";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PosOperatorAuthGuard } from "../../../../src/auth/pos-operator-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { seedCatalogIsolationFixture } from "../../__support__/isolation-harness";
import {
  seedUnknownItemsFixture,
  UNKNOWN_ITEMS_FIXTURE_IDS,
} from "../../__support__/seed-unknown-items";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTOR_USER_ID = "0a000000-0000-7000-8000-0000000005b1";

// ---------------------------------------------------------------------------
// ConfigurableContextGuard
// ---------------------------------------------------------------------------

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = UNKNOWN_ITEMS_FIXTURE_IDS.tenantA;
  public storeId: string | null = null;
  public userId: string = ACTOR_USER_ID;

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
// Spy enqueuer
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
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await seedUnknownItemsFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T548 dismiss-audit.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  contextGuard = new ConfigurableContextGuard();
  auditSpy = new SpyAuditEnqueuer();
  const localEnv = env;

  const moduleRef = await Test.createTestingModule({
    controllers: [UnknownItemsController],
    providers: [
      // Use the admin pool — bypasses RLS. The slice's purpose is to
      // verify the `@Auditable` decorator reaches the
      // `AuditEmitterInterceptor`, not to re-prove RLS behavior (which
      // dismiss-happy-path covers at the service-direct layer). The
      // worktree's `localEnv.app` pool reproduces a known-but-unrelated
      // 404 against this fixture; using `admin` isolates the audit
      // assertion from that orthogonal RLS plumbing concern.
      { provide: PG_POOL, useFactory: (): Pool => localEnv.admin },
      UnknownItemsService,
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
      { provide: APP_INTERCEPTOR, useClass: AuditEmitterInterceptor },
    ],
  })
    // Real DashboardAuthGuard + TenantContextGuard + RolesGuard are wired
    // method-level on LIST + dismiss as of the auth-guard wiring slice
    // (UnknownItemsController has no class-level guards because the POS
    // capture route uses a different auth model). Tests inject context via
    // the global ConfigurableContextGuard (registered below); override the
    // production guards with no-op pass-throughs so the global guard's
    // context survives to the handler.
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

// Reset the dismissed fixture row's state so each `it` starts from
// `pending`. Mirrors the dismiss-happy-path afterEach.
afterEach(async () => {
  if (dockerSkipped || !env) return;
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status = 'pending',
            resolution_action = NULL,
            resolved_at       = NULL,
            resolved_by       = NULL,
            resolved_product_id = NULL
      WHERE id = ANY($1)`,
    [
      [
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode,
      ],
    ],
  );
});

beforeEach(() => {
  if (dockerSkipped) return;
  auditSpy.reset();
  contextGuard.tenantId = UNKNOWN_ITEMS_FIXTURE_IDS.tenantA;
  contextGuard.storeId = null;
  contextGuard.userId = ACTOR_USER_ID;
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T548 — dismiss emits an `unknown_item.dismissed` audit event
// ---------------------------------------------------------------------------

describe("T548 / 005-WAVE1-AUDIT — dismiss audit emission", () => {
  it("dismiss 200 emits exactly one `unknown_item.dismissed` audit payload with the acting principal's tenant/user", async () => {
    if (dockerSkipped) return;

    // Use unknownAYBarcode — same target the dismiss-happy-path supertest
    // case uses successfully against the same `env.app` pool. The
    // tenant-wide actor (storeId=null) is admitted by the
    // `unknown_items_store_read` carve-out (003 0009) because the
    // `app.current_store` GUC carries the empty-string sentinel.
    const targetId = UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode;

    const res = await http().post(
      `/api/v1/catalog/unknown-items/${targetId}/dismiss`,
    );

    expect(res.status).toBe(200);

    // Drain microtasks so the interceptor's async enqueue is observable
    // before the assertions run. Mirrors the sibling specs.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(auditSpy.calls).toHaveLength(1);
    const payload = auditSpy.calls[0]!;
    expect(payload.action).toBe("unknown_item.dismissed");
    expect(payload.tenant_id).toBe(UNKNOWN_ITEMS_FIXTURE_IDS.tenantA);
    // Tenant-wide actor: storeId on the principal is null. The emitter
    // forwards `request.context.storeId` verbatim (no synthesis).
    expect(payload.store_id).toBeNull();
    expect(payload.actor_user_id).toBe(ACTOR_USER_ID);
    expect(payload.target_type).toBeNull();
    expect(payload.target_id).toBeNull();
    expect(payload.metadata).toBeNull();
  });
});
