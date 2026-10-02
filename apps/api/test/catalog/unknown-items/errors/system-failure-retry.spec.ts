/**
 * T075 — 007-POLISH-AUDIT-SWEEP — System-failure retry-safety (FR-054, SC-006).
 *
 * Inject a backend fault mid-action (a transient error inside the reopen
 * transaction) → the response is a `system-failure` (HTTP 500, wire code
 * `internal_error` — the runtime code for the system-failure category; the
 * contract prose calls it "system-failure"). A retry of the same logical
 * request then either succeeds idempotently OR returns the same failure —
 * NEVER a hidden partial commit.
 *
 * Atomicity proof (advisor-correct design): the pool is the REAL Testcontainers
 * pool, WRAPPED so a flagged transaction's INSERT throws AFTER queries have
 * really executed against Postgres. Because `runWithTenantContext` wraps the
 * callback in BEGIN/…/ROLLBACK-on-error (packages/db tenant-context middleware),
 * the thrown fault rolls the transaction back — so the post-fault DB read
 * (zero fresh pending rows) is MEANINGFUL, not vacuous (a pure mock would never
 * touch the DB and the no-row assertion would pass trivially).
 *
 * Reopen is the deliberate target: it is ONE transaction → a clean atomic
 * rollback. (Bulk-dismiss runs per-item transactions, so a fault on item N
 * leaves earlier items committed — that is a committed item + a failed batch,
 * not a "hidden partial commit"; the wrong invariant for this test.)
 *
 * Docker: Testcontainers Postgres 16, honors MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool, PoolClient } from "pg";
import request from "supertest";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import {
  AUDIT_JOB_ENQUEUER,
  NoOpAuditJobEnqueuer,
} from "../../../../src/audit/audit-job.enqueuer";
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
  ACTOR_A,
} from "../../__support__/isolation-harness";
import {
  seedUnknownItemsFixture,
  UNK_007_A_X_DISMISSED,
  UNK_007_VAL_A_X_DISMISSED,
} from "../../__support__/seed-unknown-items";

const REOPEN_URL = (id: string) => `/api/v1/catalog/unknown-items/${id}/reopen`;

/**
 * A Pool wrapper around the REAL Testcontainers pool. When `faultArmed` is set,
 * the NEXT client obtained via connect() throws a transient error on the reopen
 * fresh-pending INSERT — after BEGIN + the lock/sibling SELECTs have really run
 * — so runWithTenantContext rolls the transaction back. One-shot: the flag
 * clears after firing, so the retry runs clean against the same real pool.
 */
class FaultInjectingPool {
  public faultArmed = false;
  constructor(private readonly real: Pool) {}

  async connect(): Promise<PoolClient> {
    const client = await this.real.connect();
    if (!this.faultArmed) return client;
    this.faultArmed = false; // one-shot

    // Return a PROXY over the real client rather than MUTATING it. The pooled
    // client is shared and reused: monkeypatching its `.query` would leave the
    // throwing override attached after `release()`, so the retry (which may get
    // the same physical client) would fault again. A proxy leaves the
    // underlying client pristine — `release()` returns a clean client to the
    // pool and the retry runs normally.
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (...args: unknown[]) => {
            const first = args[0];
            const sql =
              typeof first === "string"
                ? first
                : first && typeof first === "object" && "text" in first
                  ? String((first as { text: unknown }).text)
                  : "";
            if (sql.includes("INSERT INTO unknown_items")) {
              const err = new Error(
                "simulated transient DB fault (T075)",
              ) as Error & { code?: string };
              err.code = "57P01"; // admin_shutdown — a transient class
              throw err;
            }
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  // Delegate the rest of the Pool surface the service/helpers may touch.
  query(...args: unknown[]): unknown {
    return (this.real.query as (...a: unknown[]) => unknown)(...args);
  }
  async end(): Promise<void> {
    return this.real.end();
  }
}

class ConfigurableContextGuard implements CanActivate {
  public storeId: string | null = null; // tenant-wide — passes authority
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext }>();
    req.context = {
      userId: ACTOR_A,
      tenantId: TENANT_A,
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
let faultPool: FaultInjectingPool;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[T075 system-failure-retry.spec] Docker NOT AVAILABLE: ${msg}\nMIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);
  await seedUnknownItemsFixture(env);

  const localEnv = env;
  faultPool = new FaultInjectingPool(localEnv.app);

  const moduleRef = await Test.createTestingModule({
    controllers: [ReconciliationController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => faultPool as unknown as Pool },
      ReconciliationService,
      { provide: AUDIT_JOB_ENQUEUER, useClass: NoOpAuditJobEnqueuer },
    ],
  })
    .overrideGuard(DashboardAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard).useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(new ConfigurableContextGuard());
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  if (dockerSkipped || !env) return;
  faultPool.faultArmed = false;
  await env.admin.query(
    `UPDATE unknown_items SET resolution_status='dismissed', resolution_action='dismissed',
        resolved_at=now(), resolved_by=$2, resolved_product_id=NULL WHERE id=$1`,
    [UNK_007_A_X_DISMISSED, ACTOR_A],
  );
  await env.admin.query(
    `DELETE FROM unknown_items WHERE tenant_id=$1 AND value=$2 AND resolution_status='pending'`,
    [TENANT_A, UNK_007_VAL_A_X_DISMISSED],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

async function pendingCount(): Promise<number> {
  const r = await env!.admin.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM unknown_items
       WHERE tenant_id=$1 AND value=$2 AND resolution_status='pending'`,
    [TENANT_A, UNK_007_VAL_A_X_DISMISSED],
  );
  return Number(r.rows[0]?.count ?? "0");
}

describe("T075 / 007 — system-failure retry-safety [FR-054, SC-006]", () => {
  it("a mid-action fault → 500 system-failure (internal_error), and NOTHING is partially committed", async () => {
    if (dockerSkipped) return;

    faultPool.faultArmed = true;
    const faulted = await http()
      .post(REOPEN_URL(UNK_007_A_X_DISMISSED))
      .set("Idempotency-Key", "t075-fault-key-00000000001")
      .send({});

    // System-failure category → HTTP 500, wire code internal_error (the
    // contract's "system-failure" category; never leaks the fault detail).
    expect(faulted.status).toBe(500);
    expect(faulted.body?.error?.code).toBe("internal_error");

    // Atomicity (SC-006): the transaction rolled back — NO fresh pending row
    // persisted, and the dismissed row is untouched. (Meaningful because the
    // fault fired against the REAL pool inside a real BEGIN/ROLLBACK txn.)
    expect(await pendingCount()).toBe(0);
    const dismissed = await env!.admin.query<{ resolution_status: string }>(
      `SELECT resolution_status FROM unknown_items WHERE id=$1`,
      [UNK_007_A_X_DISMISSED],
    );
    expect(dismissed.rows[0]?.resolution_status).toBe("dismissed");
  });

  it("a retry after the fault clears succeeds idempotently — exactly ONE fresh pending row (no partial-commit residue)", async () => {
    if (dockerSkipped) return;

    // First call faults (rolls back, nothing persisted).
    faultPool.faultArmed = true;
    const faulted = await http()
      .post(REOPEN_URL(UNK_007_A_X_DISMISSED))
      .set("Idempotency-Key", "t075-retry-key-aaaaaaaaaa1")
      .send({});
    expect(faulted.status).toBe(500);
    expect(await pendingCount()).toBe(0);

    // Retry with a FRESH key (avoids any 5xx-caching ambiguity in the
    // idempotency layer — not wired in this harness anyway): the fault flag is
    // now clear, so the reopen runs clean against the real pool.
    const retry = await http()
      .post(REOPEN_URL(UNK_007_A_X_DISMISSED))
      .set("Idempotency-Key", "t075-retry-key-bbbbbbbbbb2")
      .send({});
    expect(retry.status).toBe(201);

    // Exactly ONE fresh pending row — the faulted call left no residue, and the
    // retry created exactly one. No double-effect, no partial commit.
    expect(await pendingCount()).toBe(1);
  });
});
