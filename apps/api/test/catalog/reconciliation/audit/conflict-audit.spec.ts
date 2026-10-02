/**
 * T644 — 005-WAVE2-AUDIT — Conflict-rejection audit emission (RED).
 *
 * Spec anchors: FR-043, FR-082 — every reconciliation rejection emits
 *               `unknown_item.reconciliation_conflict_rejected` with the
 *               discriminating reason in metadata.
 *
 * The AuditEmitterInterceptor only fires on the success (tap.next) path — a
 * thrown 4xx never reaches it. So the rejection events are emitted explicitly
 * by ReconciliationService AFTER the transaction resolves/rolls back (T645).
 * This spec drives all three reasons through the LINK route (which can produce
 * all three) and asserts the rejection event + reason:
 *
 *   (a) alias_conflict      — link to a product whose store-scoped alias
 *                             collides with the item's identifier.
 *   (b) target_unavailable  — link to a retired product.
 *   (c) already_reconciled  — link to a pre-resolved item.
 *
 * not_found is intentionally NOT audited — a non-disclosing 404 must not
 * confirm the item's existence via an audit row (SI-001 / FR-092).
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
import type { Pool, PoolClient, QueryResult } from "pg";
import request from "supertest";

import type { Logger } from "@data-pulse-2/shared";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { AuditEmitterInterceptor } from "../../../../src/audit/audit-emitter.interceptor";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import { PG_POOL } from "../../../../src/auth/auth.module";
import type { ResolvedContext } from "../../../../src/context/types";
import { ReconciliationController } from "../../../../src/catalog/reconciliation/reconciliation.controller";
import { ReconciliationService } from "../../../../src/catalog/reconciliation/reconciliation.service";

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
  PRODUCT_A_RETIRED,
} from "../../__support__/isolation-harness";

// alias_conflict fixture: store-scoped alias at STORE_A_X + item sharing it.
const UNK_T644_CONFLICT = "0a000000-0000-7000-8000-00000644c001";
const UNK_T644_CONFLICT_CORR = "0a000000-0000-7000-8000-000006440c01";
const T644_CONFLICT_BARCODE = "T644-CONFLICT-001";
const ALIAS_T644_SCOPED = "0a000000-0000-7000-8000-000006440a01";

// target_unavailable fixture: item linked to a retired product.
const UNK_T644_RETIRED = "0a000000-0000-7000-8000-00000644c002";
const UNK_T644_RETIRED_CORR = "0a000000-0000-7000-8000-000006440c02";
const T644_RETIRED_BARCODE = "T644-RETIRED-001";

// already_reconciled fixture: item pre-resolved before the link attempt.
const UNK_T644_RESOLVED = "0a000000-0000-7000-8000-00000644c003";
const UNK_T644_RESOLVED_CORR = "0a000000-0000-7000-8000-000006440c03";
const T644_RESOLVED_BARCODE = "T644-RESOLVED-001";

const TENANT_A_ADMIN_USER = "0a000000-0000-7000-8000-000006440001";

const LINK_URL = (id: string) => `/api/v1/catalog/unknown-items/${id}/link`;
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
        `\n[T644 conflict-audit.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Store-scoped alias for the alias_conflict case.
  await env.admin.query(
    `INSERT INTO product_aliases
       (id, tenant_id, product_id, identifier_type, value,
        source_system, store_id, created_by)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, $5, $6)
     ON CONFLICT DO NOTHING`,
    [
      ALIAS_T644_SCOPED,
      TENANT_A,
      PRODUCT_A_ACTIVE,
      T644_CONFLICT_BARCODE,
      STORE_A_X,
      TENANT_A_ADMIN_USER,
    ],
  );

  // Two PENDING unknown items (conflict + retired-target cases).
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES
       ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5),
       ($6, $2, $3, 'barcode', $7, NULL, 'pending', $8)
     ON CONFLICT DO NOTHING`,
    [
      UNK_T644_CONFLICT, TENANT_A, STORE_A_X, T644_CONFLICT_BARCODE, UNK_T644_CONFLICT_CORR,
      UNK_T644_RETIRED, T644_RETIRED_BARCODE, UNK_T644_RETIRED_CORR,
    ],
  );

  // Pre-RESOLVED item for the already_reconciled case. All resolved fields
  // must be consistent per unknown_items_resolved_fields_consistent +
  // unknown_items_linked_product_present (0007_catalog.sql:414-425):
  // non-pending => resolved_at/resolved_by/resolution_action NOT NULL, and
  // action 'linked'/'created' => resolved_product_id NOT NULL.
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value, source_system,
        resolution_status, resolution_action, resolved_at, resolved_by,
        resolved_product_id, correlation_id)
     VALUES ($1, $2, $3, 'barcode', $4, NULL,
             'resolved', 'linked', now(), $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [
      UNK_T644_RESOLVED, TENANT_A, STORE_A_X, T644_RESOLVED_BARCODE,
      TENANT_A_ADMIN_USER, PRODUCT_A_ACTIVE, UNK_T644_RESOLVED_CORR,
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

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function rejectionEvents(): AuditJobPayload[] {
  return auditSpy.calls.filter((c) => c.action === REJECTION_ACTION);
}

describe("T644 / 005-WAVE2-AUDIT — conflict-rejection audit emission [FR-043, FR-082]", () => {
  it(
    "(a) alias_conflict rejection emits reconciliation_conflict_rejected{reason=alias_conflict}",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(LINK_URL(UNK_T644_CONFLICT))
        .send({ product_id: PRODUCT_A_ACTIVE });
      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("alias_conflict");

      await drainMicrotasks();

      const events = rejectionEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({ reason: "alias_conflict" });
      expect(events[0]!.tenant_id).toBe(TENANT_A);
      expect(events[0]!.actor_user_id).toBe(TENANT_A_ADMIN_USER);
    },
  );

  it(
    "(b) target_unavailable rejection emits reconciliation_conflict_rejected{reason=target_unavailable}",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(LINK_URL(UNK_T644_RETIRED))
        .send({ product_id: PRODUCT_A_RETIRED });
      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("target_unavailable");

      await drainMicrotasks();

      const events = rejectionEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({ reason: "target_unavailable" });
    },
  );

  it(
    "(c) already_reconciled rejection emits reconciliation_conflict_rejected{reason=already_reconciled}",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(LINK_URL(UNK_T644_RESOLVED))
        .send({ product_id: PRODUCT_A_ACTIVE });
      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("already_reconciled");

      await drainMicrotasks();

      const events = rejectionEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({ reason: "already_reconciled" });
    },
  );

  it(
    "(d) not_found does NOT emit a rejection event (non-disclosing per SI-001 / FR-092)",
    async () => {
      if (dockerSkipped) return;

      const FABRICATED = "0a000000-0000-7000-8000-0000064400ff";
      const res = await http()
        .post(LINK_URL(FABRICATED))
        .send({ product_id: PRODUCT_A_ACTIVE });
      expect(res.status).toBe(404);

      await drainMicrotasks();

      // No audit row — a non-disclosing 404 must not confirm existence.
      expect(rejectionEvents()).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// T645 — error-path branch coverage (Docker-free unit harness)
// ---------------------------------------------------------------------------
//
// The integration cases above drive the *happy* rejection paths. Two service
// branches are unreachable through Testcontainers because they require an
// infrastructure fault rather than a domain outcome:
//
//   1. emitConflictRejection's best-effort `.catch` — exercised only when the
//      audit enqueue itself REJECTS. The integration SpyAuditEnqueuer always
//      resolves, so the catch (and the `this.logger?` optional-chain inside
//      it) never runs. FR-082 requires a failed enqueue to be logged, not
//      silently dropped — this asserts that contract on both logger states.
//
//   2. createProductFromUnknownItem's outer `else { throw err }` — reached
//      only when a NON-AliasConflictSentinel error escapes the transaction
//      (e.g. a pg connection drop / deadlock). The sentinel branch is covered
//      by the create-path alias_conflict tests; this covers its complement,
//      proving an unexpected DB error propagates rather than being mis-mapped
//      to a 4xx kind.
//
// These run via a hand-rolled mock Pool — no Postgres, no Docker — so they
// execute even when the integration suite above is soft-skipped. The mock
// satisfies the runWithTenantContext contract (BEGIN, set_config x2, the
// service's own queries, then COMMIT/ROLLBACK, then release).

const UNIT_TENANT = TENANT_A;
const UNIT_STORE = STORE_A_X;
const UNIT_ACTOR = TENANT_A_ADMIN_USER;
const UNIT_ITEM = "0a000000-0000-7000-8000-00000644e001";
const UNIT_PRODUCT = PRODUCT_A_ACTIVE;

/** Enqueuer whose enqueue() always rejects — drives emitConflictRejection's catch. */
class RejectingAuditEnqueuer implements AuditJobEnqueuer {
  public calls = 0;
  async enqueue(): Promise<void> {
    this.calls += 1;
    throw new Error("simulated audit enqueue failure");
  }
}

const emptyResult = (): QueryResult => ({
  command: "",
  rowCount: 0,
  oid: 0,
  rows: [],
  fields: [],
});

/** An active (non-retired) product row for the link path's tenant_products check. */
const activeProductRow = (): Record<string, unknown> => ({
  id: UNIT_PRODUCT,
  retired_at: null,
});

/**
 * Build a mock PoolClient that drives the service's query sequence:
 *   - the FOR UPDATE `unknown_items` select returns `lockRow` (or 0 rows),
 *   - the `tenant_products` select returns an active product (link path only),
 *   - the `unknown_items` UPDATE ... RETURNING returns `updateRows` rows,
 * and lets a test inject a fault via `onWork(sql)` (throw to simulate a DB
 * error) on any other query. All control queries (BEGIN/COMMIT/ROLLBACK/
 * set_config) and unmatched queries return empty results.
 *
 * `updateRows` defaults to 1 (UPDATE matched the locked pending row). Set it
 * to 0 to drive the defensive `if (!updated) throw` invariant branches.
 */
function buildMockClient(opts: {
  lockRow: Record<string, unknown> | null;
  updateRows?: number;
  onWork?: (sql: string) => void;
}): { client: PoolClient; rolledBack: () => boolean } {
  let rolledBack = false;
  let lockServed = false;
  const updateRows = opts.updateRows ?? 1;

  const query = async (sql: string): Promise<QueryResult> => {
    if (sql === "ROLLBACK") rolledBack = true;
    // The FOR UPDATE lock select — serve the discriminator row once.
    if (!lockServed && /FROM unknown_items/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      lockServed = true;
      return {
        ...emptyResult(),
        rowCount: opts.lockRow ? 1 : 0,
        rows: opts.lockRow ? [opts.lockRow] : [],
      };
    }
    // Link path's target-product check — serve an active product.
    if (/FROM tenant_products/i.test(sql)) {
      return { ...emptyResult(), rowCount: 1, rows: [activeProductRow()] };
    }
    // The terminal UPDATE ... RETURNING — control rowCount to exercise the
    // invariant guard. The locked pending row is echoed back when matched.
    if (/UPDATE unknown_items/i.test(sql) && /RETURNING/i.test(sql)) {
      if (opts.onWork) opts.onWork(sql);
      return {
        ...emptyResult(),
        rowCount: updateRows,
        rows: updateRows > 0 ? [pendingLockRow()] : [],
      };
    }
    if (opts.onWork) opts.onWork(sql);
    return emptyResult();
  };

  const client = {
    query: query as PoolClient["query"],
    release: (() => undefined) as PoolClient["release"],
  } as unknown as PoolClient;

  return { client, rolledBack: () => rolledBack };
}

function buildMockPool(client: PoolClient): Pool {
  return { connect: async () => client } as unknown as Pool;
}

/** A pending lock row good enough for the create path to proceed to INSERT. */
const pendingLockRow = (): Record<string, unknown> => ({
  id: UNIT_ITEM,
  tenant_id: UNIT_TENANT,
  store_id: UNIT_STORE,
  identifier_type: "barcode",
  value: "T645-UNIT-001",
  source_system: null,
  resolution_status: "pending",
  resolution_action: null,
  resolved_at: null,
  resolved_by: null,
  resolved_product_id: null,
  encountered_at: new Date(),
  sale_context: null,
});

/** A non-pending lock row → service returns already_reconciled (a rejection kind). */
const resolvedLockRow = (): Record<string, unknown> => ({
  ...pendingLockRow(),
  resolution_status: "resolved",
  resolution_action: "linked",
  resolved_at: new Date(),
  resolved_by: UNIT_ACTOR,
  resolved_product_id: UNIT_PRODUCT,
});

describe("T645 / 005-WAVE2-AUDIT — service error-path branches [FR-082]", () => {
  it("logs (does not throw) when the conflict-rejection audit enqueue fails — logger present", async () => {
    const enqueuer = new RejectingAuditEnqueuer();
    const errorSpy = jest.fn();
    const logger = { error: errorSpy } as unknown as Logger;
    // already_reconciled is a rejection kind → emitConflictRejection runs →
    // the rejecting enqueuer drives the best-effort .catch + logger?.error.
    const { client } = buildMockClient({ lockRow: resolvedLockRow() });
    const svc = new ReconciliationService(buildMockPool(client), enqueuer, logger);

    const result = await svc.linkUnknownItem({
      tenantId: UNIT_TENANT,
      storeId: UNIT_STORE,
      storeScope: { kind: "stores", storeIds: [UNIT_STORE] },
      unknownItemId: UNIT_ITEM,
      productId: UNIT_PRODUCT,
      actorUserId: UNIT_ACTOR,
    });

    // The HTTP outcome is unchanged by the failed enqueue (best-effort).
    expect(result.kind).toBe("already_reconciled");
    expect(enqueuer.calls).toBe(1);
    // FR-082: the dropped rejection event is observable via the logger.
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // PII-safe logging contract: the log payload carries ONLY the bounded
    // reason + action (and the error), never tenant/store/user identifiers.
    // A regression that logged ctx fields would leak PII into log sinks.
    const logPayload = errorSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(logPayload).toMatchObject({
      action: "unknown_item.reconciliation_conflict_rejected",
      reason: "already_reconciled",
    });
    expect(Object.keys(logPayload).sort()).toEqual(["action", "err", "reason"]);
    const serialized = JSON.stringify({
      ...logPayload,
      err: String((logPayload as { err?: unknown }).err),
    });
    expect(serialized).not.toContain(UNIT_TENANT);
    expect(serialized).not.toContain(UNIT_STORE);
    expect(serialized).not.toContain(UNIT_ACTOR);
  });

  it("swallows the failed enqueue silently when no logger is injected — logger absent", async () => {
    const enqueuer = new RejectingAuditEnqueuer();
    const { client } = buildMockClient({ lockRow: resolvedLockRow() });
    // No third constructor arg → this.logger is undefined → logger? short-circuits.
    const svc = new ReconciliationService(buildMockPool(client), enqueuer);

    const result = await svc.linkUnknownItem({
      tenantId: UNIT_TENANT,
      storeId: UNIT_STORE,
      storeScope: { kind: "stores", storeIds: [UNIT_STORE] },
      unknownItemId: UNIT_ITEM,
      productId: UNIT_PRODUCT,
      actorUserId: UNIT_ACTOR,
    });

    expect(result.kind).toBe("already_reconciled");
    expect(enqueuer.calls).toBe(1);
  });

  it("re-throws a non-sentinel DB error from the create transaction (else branch)", async () => {
    const enqueuer = new RejectingAuditEnqueuer();
    const boom = new Error("simulated connection drop");
    // Throw on the tenant_products INSERT (a non-AliasConflictSentinel error).
    // runWithTenantContext rolls back and re-throws; the create-path outer
    // catch hits `else { throw err }` rather than mapping to a 4xx kind.
    const { client, rolledBack } = buildMockClient({
      lockRow: pendingLockRow(),
      onWork: (sql) => {
        if (/INSERT INTO tenant_products/i.test(sql)) throw boom;
      },
    });
    const svc = new ReconciliationService(buildMockPool(client), enqueuer);

    await expect(
      svc.createProductFromUnknownItem({
        tenantId: UNIT_TENANT,
        storeId: UNIT_STORE,
        storeScope: { kind: "stores", storeIds: [UNIT_STORE] },
        unknownItemId: UNIT_ITEM,
        actorUserId: UNIT_ACTOR,
        name: "Widget T645",
        taxCategory: "standard",
        categoryId: null,
      }),
    ).rejects.toThrow("simulated connection drop");

    // The transaction rolled back; no rejection audit was emitted for a
    // non-domain error (the throw bypasses the post-transaction block).
    expect(rolledBack()).toBe(true);
    expect(enqueuer.calls).toBe(0);
  });

  it("LINK: re-throws a non-23505 error from the alias INSERT (catch fall-through)", async () => {
    const enqueuer = new RejectingAuditEnqueuer();
    const boom = new Error("simulated deadlock");
    // A non-unique-violation error from the product_aliases INSERT is NOT
    // mapped to alias_conflict — the link-path catch falls through to
    // `throw err`. (The 23505 path is covered by the integration alias_conflict
    // case; this covers its complement.)
    const { client, rolledBack } = buildMockClient({
      lockRow: pendingLockRow(),
      onWork: (sql) => {
        if (/INSERT INTO product_aliases/i.test(sql)) throw boom;
      },
    });
    const svc = new ReconciliationService(buildMockPool(client), enqueuer);

    await expect(
      svc.linkUnknownItem({
        tenantId: UNIT_TENANT,
        storeId: UNIT_STORE,
        storeScope: { kind: "stores", storeIds: [UNIT_STORE] },
        unknownItemId: UNIT_ITEM,
        productId: UNIT_PRODUCT,
        actorUserId: UNIT_ACTOR,
      }),
    ).rejects.toThrow("simulated deadlock");

    expect(rolledBack()).toBe(true);
    expect(enqueuer.calls).toBe(0);
  });

  it("CREATE: re-throws a non-23505 error from the alias INSERT (sentinel catch fall-through)", async () => {
    const enqueuer = new RejectingAuditEnqueuer();
    const boom = new Error("simulated deadlock");
    // Inside the create transaction, a non-23505 alias INSERT error skips the
    // AliasConflictSentinel throw and falls through to `throw err`, which the
    // outer catch then re-throws (not mapped to alias_conflict).
    const { client, rolledBack } = buildMockClient({
      lockRow: pendingLockRow(),
      onWork: (sql) => {
        if (/INSERT INTO product_aliases/i.test(sql)) throw boom;
      },
    });
    const svc = new ReconciliationService(buildMockPool(client), enqueuer);

    await expect(
      svc.createProductFromUnknownItem({
        tenantId: UNIT_TENANT,
        storeId: UNIT_STORE,
        storeScope: { kind: "stores", storeIds: [UNIT_STORE] },
        unknownItemId: UNIT_ITEM,
        actorUserId: UNIT_ACTOR,
        name: "Widget T645",
        taxCategory: "standard",
        categoryId: null,
      }),
    ).rejects.toThrow("simulated deadlock");

    expect(rolledBack()).toBe(true);
    expect(enqueuer.calls).toBe(0);
  });

  it("LINK: throws the invariant error when the terminal UPDATE matches 0 rows", async () => {
    const enqueuer = new RejectingAuditEnqueuer();
    // FOR UPDATE locked a pending row, alias INSERT succeeded, but the
    // unknown_items UPDATE matched 0 rows — a logic-error invariant. The
    // service throws to abort and roll back rather than commit inconsistent
    // state.
    const { client, rolledBack } = buildMockClient({
      lockRow: pendingLockRow(),
      updateRows: 0,
    });
    const svc = new ReconciliationService(buildMockPool(client), enqueuer);

    await expect(
      svc.linkUnknownItem({
        tenantId: UNIT_TENANT,
        storeId: UNIT_STORE,
        storeScope: { kind: "stores", storeIds: [UNIT_STORE] },
        unknownItemId: UNIT_ITEM,
        productId: UNIT_PRODUCT,
        actorUserId: UNIT_ACTOR,
      }),
    ).rejects.toThrow(/invariant/i);

    expect(rolledBack()).toBe(true);
    // An invariant throw is not a domain rejection — the post-transaction
    // rejection-audit block must be bypassed entirely (no enqueue attempt).
    expect(enqueuer.calls).toBe(0);
  });

  it("CREATE: throws the invariant error when the terminal UPDATE matches 0 rows", async () => {
    const enqueuer = new RejectingAuditEnqueuer();
    const { client, rolledBack } = buildMockClient({
      lockRow: pendingLockRow(),
      updateRows: 0,
    });
    const svc = new ReconciliationService(buildMockPool(client), enqueuer);

    await expect(
      svc.createProductFromUnknownItem({
        tenantId: UNIT_TENANT,
        storeId: UNIT_STORE,
        storeScope: { kind: "stores", storeIds: [UNIT_STORE] },
        unknownItemId: UNIT_ITEM,
        actorUserId: UNIT_ACTOR,
        name: "Widget T645",
        taxCategory: "standard",
        categoryId: null,
      }),
    ).rejects.toThrow(/invariant/i);

    expect(rolledBack()).toBe(true);
    expect(enqueuer.calls).toBe(0);
  });
});
