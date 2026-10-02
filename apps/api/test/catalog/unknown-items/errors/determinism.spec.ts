/**
 * T074 — 007-POLISH-AUDIT-SWEEP — Failure-determinism (FR-053).
 *
 * The same logical action against the same authoritative state under the same
 * actor scope MUST yield the IDENTICAL failure category AND the same
 * non-disclosing wording across repeated calls — no nondeterministic detail
 * (timestamps / ids) leaks into the compared envelope.
 *
 * Cases (over the 007 reopen op, which has the richest failure taxonomy):
 *   (a) two identical OUT-OF-SCOPE reopen attempts → byte-identical 404 envelope.
 *   (b) two identical reopen-on-RESOLVED attempts → byte-identical 409
 *       already_reconciled body (incl. details.prior_state).
 *   (c) two identical in-scope store-scoped reopens → byte-identical 403
 *       forbidden envelope.
 *
 * "byte-identical" = the full `error` envelope MINUS `request_id` (the only
 * legitimately per-request field). Comparing the whole envelope-minus-request_id
 * (not just code+message) also catches a nondeterministic `details` leak.
 *
 * Harness mirrors reopen-authority.spec. Docker: Testcontainers Postgres 16,
 * honors MIGRATION_TEST_ALLOW_SKIP=1.
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
  STORE_A_Y,
  ACTOR_A,
} from "../../__support__/isolation-harness";
import {
  seedUnknownItemsFixture,
  UNK_007_A_X_DISMISSED,
  UNK_007_A_Y_DISMISSED,
  UNK_007_A_X_RESOLVED,
} from "../../__support__/seed-unknown-items";

const REOPEN_URL = (id: string) =>
  `/api/v1/catalog/unknown-items/${id}/reopen`;

/** Strip the only legitimately per-request field; everything else MUST match. */
function stableEnvelope(body: { error?: Record<string, unknown> }) {
  const err = { ...(body.error ?? {}) };
  delete err["request_id"];
  return err;
}

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(p: AuditJobPayload): Promise<void> {
    this.calls.push(p);
  }
  reset(): void {
    this.calls = [];
  }
}

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string | null = null;
  public userId: string = ACTOR_A;
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext }>();
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: this.storeId,
      isPlatformAdmin: false,
      source: "session",
      storeAccess: { kind: "all" },
    };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let contextGuard: ConfigurableContextGuard;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[T074 determinism.spec] Docker NOT AVAILABLE: ${msg}\nMIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);
  await seedUnknownItemsFixture(env);

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  const auditSpy = new SpyAuditEnqueuer();
  const reflector = new Reflector();

  const moduleRef = await Test.createTestingModule({
    controllers: [ReconciliationController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ReconciliationService,
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
      { provide: APP_INTERCEPTOR, useValue: new AuditEmitterInterceptor(reflector, auditSpy) },
    ],
  })
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
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = null;
  contextGuard.userId = ACTOR_A;
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

describe("T074 / 007 — failure determinism [FR-053]", () => {
  it("(a) two identical out-of-scope reopens → byte-identical 404 envelope", async () => {
    if (dockerSkipped) return;
    // Store-scoped actor at STORE_A_X reopening the STORE_A_Y dismissed row →
    // RLS-filtered → non-disclosing 404, deterministically.
    contextGuard.storeId = STORE_A_X;

    const first = await http().post(REOPEN_URL(UNK_007_A_Y_DISMISSED)).set("Idempotency-Key", "t074-404-aaaaaaaaaaaaa1").send({});
    const second = await http().post(REOPEN_URL(UNK_007_A_Y_DISMISSED)).set("Idempotency-Key", "t074-404-aaaaaaaaaaaaa2").send({});

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(stableEnvelope(second.body)).toEqual(stableEnvelope(first.body));
    expect(stableEnvelope(first.body)).toMatchObject({ code: "not_found" });
  });

  it("(b) two identical reopen-on-resolved → byte-identical 409 already_reconciled body", async () => {
    if (dockerSkipped) return;
    contextGuard.storeId = null; // tenant-wide — passes authority, hits the resolved guard

    const first = await http().post(REOPEN_URL(UNK_007_A_X_RESOLVED)).set("Idempotency-Key", "t074-409-bbbbbbbbbbbbb1").send({});
    const second = await http().post(REOPEN_URL(UNK_007_A_X_RESOLVED)).set("Idempotency-Key", "t074-409-bbbbbbbbbbbbb2").send({});

    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(stableEnvelope(second.body)).toEqual(stableEnvelope(first.body));
    expect(stableEnvelope(first.body)).toMatchObject({
      code: "already_reconciled",
      details: { prior_state: "resolved" },
    });
  });

  it("(c) two identical in-scope store-scoped reopens → byte-identical 403 forbidden envelope", async () => {
    if (dockerSkipped) return;
    // Store-scoped actor at STORE_A_X reopening the in-scope STORE_A_X dismissed
    // row → 403 forbidden (service-layer authority split), deterministically.
    contextGuard.storeId = STORE_A_X;

    const first = await http().post(REOPEN_URL(UNK_007_A_X_DISMISSED)).set("Idempotency-Key", "t074-403-ccccccccccccc1").send({});
    const second = await http().post(REOPEN_URL(UNK_007_A_X_DISMISSED)).set("Idempotency-Key", "t074-403-ccccccccccccc2").send({});

    expect(first.status).toBe(403);
    expect(second.status).toBe(403);
    expect(stableEnvelope(second.body)).toEqual(stableEnvelope(first.body));
    expect(stableEnvelope(first.body)).toMatchObject({ code: "forbidden" });
  });
});
