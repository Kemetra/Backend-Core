/**
 * T623 — 005-WAVE2-LINK-EDGES — Link target unavailable (RED).
 *
 * Spec anchors: FR-051 (retired/cross-tenant rejection), FR-092
 * (non-disclosing 404 — never reveal whether the unknown item or the
 * target product was absent).
 *
 * Route under test: POST /api/v1/catalog/unknown-items/:id/link
 * Operationid: tenantAdminLinkUnknownItem
 *
 * Sub-cases covered:
 *   (a) Link to a retired product in the SAME tenant (PRODUCT_A_RETIRED
 *       seeded with retired_at = now()) → 409 with error.code='target_unavailable'.
 *   (b) Link to a product in ANOTHER tenant (PRODUCT_B_ACTIVE) → 404
 *       non-disclosing; response body MUST NOT contain the cross-tenant
 *       product UUID, tenant_id, or any tenant slug. The shape must be
 *       structurally indistinguishable from case (c).
 *   (c) Link to a fabricated UUID that does not exist anywhere → 404
 *       non-disclosing.
 *
 * Invariants (all three cases):
 *   - U1.resolution_status stays 'pending'.
 *   - No new product_aliases row inserted (count remains the pre-test
 *     baseline of 0 for the U1 identifier).
 *   - No audit event emitted (auditSpy.calls is empty for the link action).
 *
 * Harness: ReconciliationController + ReconciliationService against
 * Testcontainers Postgres 16. PG_POOL bound to localEnv.app (RLS-active)
 * per the PR #357 audit pattern — the runtime role exercises the RLS
 * policies the production service would face.
 *
 * Docker: honors MIGRATION_TEST_ALLOW_SKIP=1 — suite soft-skips when
 * Docker is unavailable.
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
  TENANT_B,
  STORE_A_X,
  PRODUCT_A_RETIRED,
  PRODUCT_B_ACTIVE,
} from "../../__support__/isolation-harness";

// ---------------------------------------------------------------------------
// T623-specific fixture constants
// ---------------------------------------------------------------------------

const UNK_T623_EDGES = "0a000000-0000-7000-8000-00000623ed01";
const UNK_T623_EDGES_CORR = "0a000000-0000-7000-8000-00000623ec01";
const UNK_T623_BARCODE_VALUE = "T623-LINK-EDGES-001";

const TENANT_A_ADMIN_USER = "0a000000-0000-7000-8000-000006230001";

/** Non-existent UUID for sub-case (c). */
const FABRICATED_UUID = "0f000000-0000-7000-8000-000000000fff";

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
        `\n[T623 link-target-unavailable.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Seed a pending unknown item in TENANT_A / STORE_A_X for T623 cases.
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5)
     ON CONFLICT DO NOTHING`,
    [UNK_T623_EDGES, TENANT_A, STORE_A_X, UNK_T623_BARCODE_VALUE, UNK_T623_EDGES_CORR],
  );

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  auditSpy = new SpyAuditEnqueuer();

  const reflector = new Reflector();
  const auditInterceptor = new AuditEmitterInterceptor(reflector, auditSpy);

  const moduleRef = await Test.createTestingModule({
    controllers: [ReconciliationController],
    providers: [
      // PG_POOL bound to the RLS-active `app` pool — matches the PR #357
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
  // Defensive: reset U1 back to pending so each sub-case sees a clean slate.
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status   = 'pending',
            resolution_action   = NULL,
            resolved_at         = NULL,
            resolved_by         = NULL,
            resolved_product_id = NULL
      WHERE id = $1`,
    [UNK_T623_EDGES],
  );
  // Defensive: scrub any product_aliases row this spec may have leaked.
  await env.admin.query(
    `DELETE FROM product_aliases
      WHERE tenant_id = $1
        AND value     = $2`,
    [TENANT_A, UNK_T623_BARCODE_VALUE],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

/** Pre-test invariant: the alias count for the U1 identifier is 0. */
async function aliasCount(): Promise<number> {
  const r = await env!.admin.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM product_aliases
      WHERE tenant_id = $1
        AND value     = $2`,
    [TENANT_A, UNK_T623_BARCODE_VALUE],
  );
  return Number(r.rows[0]?.count ?? "0");
}

async function unknownItemStatus(): Promise<string> {
  const r = await env!.admin.query<{ resolution_status: string }>(
    `SELECT resolution_status FROM unknown_items WHERE id = $1`,
    [UNK_T623_EDGES],
  );
  return r.rows[0]?.resolution_status ?? "missing";
}

// ---------------------------------------------------------------------------
// T623 — link target unavailable [FR-051, FR-092]
// ---------------------------------------------------------------------------

describe("T623 / 005-WAVE2-LINK-EDGES — link to retired/cross-tenant/non-existent product [FR-051, FR-092]", () => {
  // -------------------------------------------------------------------------
  // T623-a — retired product (SAME tenant) → 409 target_unavailable
  // -------------------------------------------------------------------------
  it(
    "(a) returns 409 target_unavailable when linking to a retired product in the same tenant",
    async () => {
      if (dockerSkipped) return;

      // Sanity: PRODUCT_A_RETIRED is seeded by isolation-harness with
      // retired_at = now(). Confirm so a future fixture change surfaces here.
      const retiredCheck = await env!.admin.query<{ retired_at: Date | null }>(
        `SELECT retired_at FROM tenant_products WHERE id = $1`,
        [PRODUCT_A_RETIRED],
      );
      expect(retiredCheck.rows[0]?.retired_at).not.toBeNull();

      const beforeAliases = await aliasCount();

      const res = await http()
        .post(LINK_URL(UNK_T623_EDGES))
        .send({ product_id: PRODUCT_A_RETIRED });

      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("target_unavailable");

      // U1 still pending; no alias row.
      expect(await unknownItemStatus()).toBe("pending");
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

  // -------------------------------------------------------------------------
  // T623-b — cross-tenant product → 404 non-disclosing
  // -------------------------------------------------------------------------
  it(
    "(b) returns 404 non-disclosing when linking to a product belonging to another tenant; body MUST NOT leak the cross-tenant identity",
    async () => {
      if (dockerSkipped) return;

      const beforeAliases = await aliasCount();

      const res = await http()
        .post(LINK_URL(UNK_T623_EDGES))
        .send({ product_id: PRODUCT_B_ACTIVE });

      expect(res.status).toBe(404);

      // Non-disclosure: the response body must NOT mention the
      // cross-tenant product UUID or the other tenant's UUID.
      const bodyJson = JSON.stringify(res.body);
      expect(bodyJson).not.toContain(PRODUCT_B_ACTIVE);
      expect(bodyJson).not.toContain(TENANT_B);
      // Defensive: the body must not contain phrasing that confirms
      // existence (e.g., "retired", "another tenant", "different tenant").
      expect(bodyJson.toLowerCase()).not.toContain("retired");
      expect(bodyJson.toLowerCase()).not.toContain("another tenant");
      expect(bodyJson.toLowerCase()).not.toContain("different tenant");
      expect(bodyJson.toLowerCase()).not.toContain("cross-tenant");

      expect(await unknownItemStatus()).toBe("pending");
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

  // -------------------------------------------------------------------------
  // T623-c — non-existent UUID → 404 non-disclosing
  // -------------------------------------------------------------------------
  it(
    "(c) returns 404 non-disclosing when linking to a UUID that does not exist anywhere",
    async () => {
      if (dockerSkipped) return;

      // Sanity: the fabricated UUID is genuinely absent.
      const missingCheck = await env!.admin.query<{ id: string }>(
        `SELECT id FROM tenant_products WHERE id = $1`,
        [FABRICATED_UUID],
      );
      expect(missingCheck.rows).toHaveLength(0);

      const beforeAliases = await aliasCount();

      const res = await http()
        .post(LINK_URL(UNK_T623_EDGES))
        .send({ product_id: FABRICATED_UUID });

      expect(res.status).toBe(404);

      const bodyJson = JSON.stringify(res.body);
      expect(bodyJson).not.toContain(FABRICATED_UUID);
      expect(bodyJson.toLowerCase()).not.toContain("retired");

      expect(await unknownItemStatus()).toBe("pending");
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

  // -------------------------------------------------------------------------
  // T623-d — non-disclosure parity: cases (b) and (c) yield the same shape
  // -------------------------------------------------------------------------
  it(
    "(d) cross-tenant and non-existent responses are structurally indistinguishable (FR-092 non-disclosure)",
    async () => {
      if (dockerSkipped) return;

      const crossTenant = await http()
        .post(LINK_URL(UNK_T623_EDGES))
        .send({ product_id: PRODUCT_B_ACTIVE });

      const nonExistent = await http()
        .post(LINK_URL(UNK_T623_EDGES))
        .send({ product_id: FABRICATED_UUID });

      expect(crossTenant.status).toBe(nonExistent.status);
      // Same top-level keys; same message shape. We do not require bytewise
      // equality (timestamps/trace IDs may differ) — only the key set + the
      // human-readable `message` field, which is the disclosure surface.
      const keys = (obj: unknown): string[] =>
        obj && typeof obj === "object"
          ? Object.keys(obj as Record<string, unknown>).sort()
          : [];
      expect(keys(crossTenant.body)).toEqual(keys(nonExistent.body));
      expect((crossTenant.body as { message?: string }).message).toBe(
        (nonExistent.body as { message?: string }).message,
      );
    },
  );
});
