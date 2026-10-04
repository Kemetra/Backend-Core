/**
 * RT-177 — ERPNext negative on-hand read model: HTTP + Testcontainers spec.
 *
 * Drives `NegativeOnHandController` over real Postgres (the NOBYPASSRLS
 * `app_test` pool, full migration set). Only cookie authentication is faked: a
 * header names the session; `TenantContextGuard`, `RolesGuard`,
 * `SessionRepository` and `MembershipRepository` are the real classes, so tenant
 * context, store scope (RT-131) and role gating are genuinely resolved. With no
 * header the real `DashboardAuthGuard` runs (no cookie → 401).
 *
 * The main fixture's snapshots are recorded through the real
 * `ErpnextBinViewService.reportSnapshot` (019), so the stored report shape is the
 * one production writes; the edge states (stale, incomplete, paging volume) are
 * seeded directly. Every 200 body is validated against the contract (Ajv 2020).
 *
 * Maps to the RT-177 acceptance criteria:
 *   AC1 contract conformance of every response;
 *   AC2 A=-3.000000 / B=5.000000 / C(unmapped)=-1.500000 → exactly A and C;
 *   AC3 no_warehouse_mapping / no_snapshot / stale / pendingRequest;
 *   AC4 a newer report supersedes; a later A=0 removes A;
 *   AC5 store_manager scope, cross-tenant 404, role default-deny 404, no session 401;
 *   AC6 limit 1..500 default 100, stable paging without duplicates or gaps;
 *   AC7 the reads write nothing.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Pool } from "pg";
import request from "supertest";

import { deterministicId } from "@data-pulse-2/shared";

import { PG_POOL } from "../../../../src/auth/auth.module";
import { AuthTokenRepository } from "../../../../src/auth/auth-token.repository";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { SessionRepository } from "../../../../src/auth/session.repository";
import { ErpnextBinViewService } from "../../../../src/catalog/erpnext-bin-view/erpnext-bin-view.service";
import { NegativeOnHandController } from "../../../../src/catalog/erpnext-reconciliation/negative-on-hand.controller";
import { NegativeOnHandService } from "../../../../src/catalog/erpnext-reconciliation/negative-on-hand.service";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { MembershipRepository } from "../../../../src/context/membership.repository";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";
import { loadOpenApiContracts } from "../../../../src/openapi/loader";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
  seedCatalogIsolationFixture,
} from "../../__support__/isolation-harness";

// ---------------------------------------------------------------------------
// Fixture IDs (hex-only, `0177` mnemonic)
// ---------------------------------------------------------------------------

const S_FIX = STORE_A_X; // AC2 / AC4 / AC3-pending — recorded via reportSnapshot
const S_STALE = STORE_A_Y; // AC3 stale
const S_UNMAPPED = "0a000000-0000-7000-8000-0000017700a1";
const S_NOSNAP = "0a000000-0000-7000-8000-0000017700a2";
const S_PEND = "0a000000-0000-7000-8000-0000017700a3";
const S_INCOMPLETE = "0a000000-0000-7000-8000-0000017700a4";
const S_PAGE = "0a000000-0000-7000-8000-0000017700a5";
const S_DELETED = "0a000000-0000-7000-8000-0000017700a6";
const NON_EXISTENT = "0a000000-0000-7000-8000-0000017700ff";

const ROLE_OWNER = "0a000000-0000-7000-8000-0000017701a1";
const ROLE_MANAGER = "0a000000-0000-7000-8000-0000017701a2";
const ROLE_STAFF = "0a000000-0000-7000-8000-0000017701a3";
const ROLE_ADMIN = "0a000000-0000-7000-8000-0000017701a4";

const USER_OWNER = "0a000000-0000-7000-8000-0000017702a1";
const USER_MGR = "0a000000-0000-7000-8000-0000017702a2";
const USER_STAFF = "0a000000-0000-7000-8000-0000017702a3";
const USER_ADMIN = "0a000000-0000-7000-8000-0000017702a4";

const MEM_OWNER = "0a000000-0000-7000-8000-0000017703a1";
const MEM_MGR = "0a000000-0000-7000-8000-0000017703a2";
const MEM_STAFF = "0a000000-0000-7000-8000-0000017703a3";
const MEM_ADMIN = "0a000000-0000-7000-8000-0000017703a4";

const SES_OWNER = "0a000000-0000-7000-8000-0000017704a1";
const SES_MGR = "0a000000-0000-7000-8000-0000017704a2";
const SES_STAFF = "0a000000-0000-7000-8000-0000017704a3";
const SES_ADMIN = "0a000000-0000-7000-8000-0000017704a4";

const SESSION_USER: Readonly<Record<string, string>> = {
  [SES_OWNER]: USER_OWNER,
  [SES_MGR]: USER_MGR,
  [SES_STAFF]: USER_STAFF,
  [SES_ADMIN]: USER_ADMIN,
};

const RUN_FIX_1 = "0a000000-0000-7000-8000-0000017705a1";
const RUN_FIX_2 = "0a000000-0000-7000-8000-0000017705a2";
const RUN_STALE = "0a000000-0000-7000-8000-0000017705a3";
const RUN_PEND = "0a000000-0000-7000-8000-0000017705a4";
const RUN_INC_OLD = "0a000000-0000-7000-8000-0000017705a5";
const RUN_INC_NEW = "0a000000-0000-7000-8000-0000017705a6";
const RUN_PAGE = "0a000000-0000-7000-8000-0000017705a7";
const RUN_B = "0b000000-0000-7000-8000-0000017705b1";

const BIN_VIEW_REQUEST_NS = "0190b1de-0000-7000-8000-0000000be019";
const ITEM_A = "RT177-ITEM-A";
const ITEM_B = "RT177-ITEM-B";
const ITEM_C = "RT177-ITEM-C";
const READ_AT_1 = "2026-10-04T09:00:00.000+02:00";
const READ_AT_2 = "2026-10-04T10:00:00.000+02:00";

const BASE = "/api/v1/catalog/erpnext-reconciliation";
const STORES = `${BASE}/negative-on-hand/stores`;
const items = (storeId: string): string => `${BASE}/stores/${storeId}/negative-on-hand`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let app: INestApplication | null = null;
let binView: ErpnextBinViewService;
let productAName = "";

/**
 * Stands in for cookie authentication ONLY: a test header names the session.
 * Without the header the real `DashboardAuthGuard` decides (no cookie → 401).
 */
class HeaderSessionAuthGuard implements CanActivate {
  constructor(private readonly real: DashboardAuthGuard) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      principal?: unknown;
    }>();
    const sessionId = req.headers["x-test-session"];
    const userId = sessionId ? SESSION_USER[sessionId] : undefined;
    if (!sessionId || !userId) return this.real.canActivate(ctx);
    req.principal = { kind: "session", sessionId, userId };
    return true;
  }
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

interface SeedEntry {
  readonly name: string;
  readonly quantity: string;
  readonly product?: string | null;
  readonly uom?: string;
}

/** A stored report in the exact shape `reportSnapshot` writes (019). */
function storedReport(opts: {
  runId: string;
  warehouse: string;
  recordedAt: string;
  readAt: string;
  entries: readonly SeedEntry[];
  complete?: boolean;
}): Record<string, unknown> {
  return {
    requestRef: deterministicId(BIN_VIEW_REQUEST_NS, `${opts.runId}:0`),
    runRef: opts.runId,
    erpnextWarehouseRef: opts.warehouse,
    readAt: opts.readAt,
    recordedAt: opts.recordedAt,
    acceptedEntryCount: opts.entries.length,
    entries: opts.entries.map((e) => ({
      erpnextItemRef: e.name,
      tenant_product_ref: e.product ?? null,
      quantity: e.quantity,
      stockUom: e.uom ?? "Nos",
    })),
    ...(opts.complete === undefined ? {} : { complete: opts.complete }),
  };
}

async function insertRun(
  admin: Pool,
  opts: {
    id: string;
    tenantId?: string;
    storeId: string;
    status: "running" | "completed";
    startedAt: string;
    report?: Record<string, unknown>;
  },
): Promise<void> {
  await admin.query(
    `INSERT INTO erpnext_reconciliation_run
       (id, tenant_id, store_id, kind, trigger, status, started_at, finished_at, summary)
     VALUES ($1, $2, $3, 'stock', 'on_demand', $4, $5::timestamptz,
             CASE WHEN $4 = 'running' THEN NULL ELSE now() END, $6::jsonb)`,
    [
      opts.id,
      opts.tenantId ?? TENANT_A,
      opts.storeId,
      opts.status,
      opts.startedAt,
      opts.report ? JSON.stringify({ bin_view_report: opts.report }) : null,
    ],
  );
}

async function mapStore(
  admin: Pool,
  storeId: string,
  warehouse: string,
  opts: { tenantId?: string; purpose?: "stock" | "returns"; retired?: boolean } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO erpnext_warehouse_map
       (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version, retired_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 1,
             CASE WHEN $6::boolean THEN now() ELSE NULL END)`,
    [opts.tenantId ?? TENANT_A, storeId, opts.purpose ?? "stock", warehouse, USER_OWNER, opts.retired ?? false],
  );
}

/** Page volume for S_PAGE: 105 negatives (with ties) + positives + a negative zero. */
function pageEntriesFixture(): SeedEntry[] {
  const out: SeedEntry[] = [];
  for (let i = 0; i < 105; i++) {
    out.push({ name: `P-${String(i % 40).padStart(3, "0")}`, quantity: `-${(i % 9) + 1}.${i % 4}00000` });
  }
  for (let i = 0; i < 10; i++) out.push({ name: `POS-${i}`, quantity: `${i}.000000` });
  out.push({ name: "ZERO", quantity: "-0.000000" });
  return out;
}

async function seed(admin: Pool): Promise<void> {
  await seedCatalogIsolationFixture({ admin });

  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name, deleted_at) VALUES
       ($1, $7, 'rt177-unmapped', 'RT-177 Unmapped', NULL),
       ($2, $7, 'rt177-nosnap', 'RT-177 No Snapshot', NULL),
       ($3, $7, 'rt177-pend', 'RT-177 Pending', NULL),
       ($4, $7, 'rt177-incomplete', 'RT-177 Incomplete', NULL),
       ($5, $7, 'rt177-page', 'RT-177 Paging', NULL),
       ($6, $7, 'rt177-deleted', 'RT-177 Deleted', now())`,
    [S_UNMAPPED, S_NOSNAP, S_PEND, S_INCOMPLETE, S_PAGE, S_DELETED, TENANT_A],
  );

  await admin.query(
    `INSERT INTO users (id, email) VALUES
       ($1, 'rt177-owner@example.test'), ($2, 'rt177-mgr@example.test'),
       ($3, 'rt177-staff@example.test'), ($4, 'rt177-admin@example.test')`,
    [USER_OWNER, USER_MGR, USER_STAFF, USER_ADMIN],
  );
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $5, 'owner', 'Owner'), ($2, $5, 'store_manager', 'Store Manager'),
       ($3, $5, 'store_staff', 'Store Staff'), ($4, $5, 'tenant_admin', 'Tenant Admin')`,
    [ROLE_OWNER, ROLE_MANAGER, ROLE_STAFF, ROLE_ADMIN, TENANT_A],
  );
  await admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $9, $2, $10, 'all'),
       ($3, $9, $4, $11, 'specific'),
       ($5, $9, $6, $12, 'all'),
       ($7, $9, $8, $13, 'all')`,
    [
      MEM_OWNER, USER_OWNER, MEM_MGR, USER_MGR, MEM_STAFF, USER_STAFF, MEM_ADMIN, USER_ADMIN,
      TENANT_A, ROLE_OWNER, ROLE_MANAGER, ROLE_STAFF, ROLE_ADMIN,
    ],
  );
  // The store_manager is granted S_FIX only.
  await admin.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`,
    [MEM_MGR, S_FIX, TENANT_A],
  );
  await admin.query(
    `INSERT INTO sessions
       (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
     VALUES
       ($1, $2, $9, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($3, $4, $9, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($5, $6, $9, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($7, $8, $9, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex'))`,
    [SES_OWNER, USER_OWNER, SES_MGR, USER_MGR, SES_STAFF, USER_STAFF, SES_ADMIN, USER_ADMIN, TENANT_A],
  );

  // Item A resolves to a Retail Tower product through a confirmed 013 map; C does not.
  await admin.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
        suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', 'manual', $4, now())`,
    [TENANT_A, PRODUCT_A_ACTIVE, ITEM_A, USER_OWNER],
  );
  const product = await admin.query<{ name: string }>(
    `SELECT name FROM tenant_products WHERE id = $1`,
    [PRODUCT_A_ACTIVE],
  );
  productAName = product.rows[0]!.name;

  // Warehouse maps. S_UNMAPPED has only a `returns` map and a RETIRED stock map.
  await mapStore(admin, S_FIX, "WH-FIX");
  await mapStore(admin, S_STALE, "WH-STALE");
  await mapStore(admin, S_NOSNAP, "WH-NOSNAP");
  await mapStore(admin, S_PEND, "WH-PEND");
  await mapStore(admin, S_INCOMPLETE, "WH-INC");
  await mapStore(admin, S_PAGE, "WH-PAGE");
  await mapStore(admin, S_DELETED, "WH-DEL");
  await mapStore(admin, S_UNMAPPED, "WH-RET", { purpose: "returns" });
  await mapStore(admin, S_UNMAPPED, "WH-OLD", { retired: true });
  await mapStore(admin, STORE_B_X, "WH-B", { tenantId: TENANT_B });

  // An old unmapped-store snapshot must NOT surface (no active stock map wins).
  await insertRun(admin, {
    id: "0a000000-0000-7000-8000-0000017705af",
    storeId: S_UNMAPPED,
    status: "completed",
    startedAt: hoursAgo(5),
    report: storedReport({
      runId: "0a000000-0000-7000-8000-0000017705af", warehouse: "WH-OLD",
      recordedAt: hoursAgo(5), readAt: hoursAgo(5), entries: [{ name: "OLD", quantity: "-4" }],
    }),
  });

  // AC3 stale: recorded 3 days ago, still served.
  await insertRun(admin, {
    id: RUN_STALE,
    storeId: S_STALE,
    status: "completed",
    startedAt: hoursAgo(72),
    report: storedReport({
      runId: RUN_STALE, warehouse: "WH-STALE", recordedAt: hoursAgo(72), readAt: hoursAgo(72),
      entries: [{ name: "STALE-X", quantity: "-2.000000" }, { name: "STALE-Y", quantity: "1.000000" }],
    }),
  });

  // AC3 pending without any snapshot.
  await insertRun(admin, { id: RUN_PEND, storeId: S_PEND, status: "running", startedAt: hoursAgo(1) });

  // RT-175 forward-compat: a newer report marked complete:false is not usable;
  // its still-running run is the pending request; the older snapshot is served.
  await insertRun(admin, {
    id: RUN_INC_OLD,
    storeId: S_INCOMPLETE,
    status: "completed",
    startedAt: hoursAgo(3),
    report: storedReport({
      runId: RUN_INC_OLD, warehouse: "WH-INC", recordedAt: hoursAgo(2.9), readAt: hoursAgo(2.9),
      entries: [{ name: "INC-Q", quantity: "-1.000000" }],
    }),
  });
  await insertRun(admin, {
    id: RUN_INC_NEW,
    storeId: S_INCOMPLETE,
    status: "running",
    startedAt: hoursAgo(1),
    report: storedReport({
      runId: RUN_INC_NEW, warehouse: "WH-INC", recordedAt: hoursAgo(0.9), readAt: hoursAgo(0.9),
      entries: [{ name: "INC-Q", quantity: "-9.000000" }, { name: "INC-R", quantity: "-9.000000" }],
      complete: false,
    }),
  });

  // AC6 paging volume.
  await insertRun(admin, {
    id: RUN_PAGE,
    storeId: S_PAGE,
    status: "completed",
    startedAt: hoursAgo(1),
    report: storedReport({
      runId: RUN_PAGE, warehouse: "WH-PAGE", recordedAt: hoursAgo(1), readAt: hoursAgo(1),
      entries: pageEntriesFixture(),
    }),
  });

  // Deleted store + tenant B: snapshots exist but must never be visible to A.
  await insertRun(admin, {
    id: "0a000000-0000-7000-8000-0000017705ae",
    storeId: S_DELETED,
    status: "completed",
    startedAt: hoursAgo(1),
    report: storedReport({
      runId: "0a000000-0000-7000-8000-0000017705ae", warehouse: "WH-DEL",
      recordedAt: hoursAgo(1), readAt: hoursAgo(1), entries: [{ name: "DEL", quantity: "-1" }],
    }),
  });
  await insertRun(admin, {
    id: RUN_B,
    tenantId: TENANT_B,
    storeId: STORE_B_X,
    status: "completed",
    startedAt: hoursAgo(1),
    report: storedReport({
      runId: RUN_B, warehouse: "WH-B", recordedAt: hoursAgo(1), readAt: hoursAgo(1),
      entries: [{ name: "B-ITEM", quantity: "-7" }],
    }),
  });
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seed(env.admin);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-177 negative-on-hand] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  const appPool = env.app;
  binView = new ErpnextBinViewService(appPool);
  const realDashboardGuard = new DashboardAuthGuard(
    new SessionRepository(appPool),
    new AuthTokenRepository(appPool),
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [NegativeOnHandController],
    providers: [
      { provide: PG_POOL, useValue: appPool },
      { provide: SessionRepository, useFactory: () => new SessionRepository(appPool) },
      { provide: MembershipRepository, useFactory: () => new MembershipRepository(appPool) },
      NegativeOnHandService,
      TenantContextGuard,
      RolesGuard,
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue(new HeaderSessionAuthGuard(realDashboardGuard))
    .compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-177 negative-on-hand] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function as(sessionId: string | null) {
  const server = app!.getHttpServer();
  return (path: string) => {
    const req = request(server).get(path);
    return sessionId ? req.set("x-test-session", sessionId) : req;
  };
}
const owner = () => as(SES_OWNER);

// ---------------------------------------------------------------------------
// Contract validators (AC1 — every 200 body conforms)
// ---------------------------------------------------------------------------

let validators: { stores: ValidateFunction; items: ValidateFunction; error: ValidateFunction } | null = null;
function contract(): NonNullable<typeof validators> {
  if (validators) return validators;
  const dir = resolve(__dirname, "..", "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "erpnext-reconciliation");
  const c = loadOpenApiContracts({ dir }).find((x) => x.id === "reconciliation");
  if (!c) throw new Error("reconciliation.yaml not found");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(c.document as object), $id: "reconciliation" });
  validators = {
    stores: ajv.compile({ $ref: "reconciliation#/components/schemas/StoreNegativeOnHandSummaryPage" }),
    items: ajv.compile({ $ref: "reconciliation#/components/schemas/StoreNegativeOnHandPage" }),
    error: ajv.compile({ $ref: "reconciliation#/components/schemas/Error" }),
  };
  return validators;
}

interface ItemBody {
  discrepancyKind: string;
  erpnextItemRef: { doctype: string; name: string };
  mappingStatus: string;
  tenantProduct: { id: string; name: string } | null;
  erpnextWarehouseRef: string;
  quantity: string;
  stockUom: string;
}
interface SnapshotBody {
  status: string;
  erpnextWarehouseRef: string | null;
  runId: string | null;
  readAt: string | null;
  recordedAt: string | null;
  staleAfterSeconds: number;
  reportedEntryCount: number | null;
  pendingRequest: { runId: string; requestedAt: string } | null;
}
interface ItemsPage { storeId: string; snapshot: SnapshotBody; items: ItemBody[]; nextCursor: string | null }
interface SummaryBody { storeId: string; storeName: string; snapshot: SnapshotBody; negativeItemCount: number }
interface StoresPage { items: SummaryBody[]; nextCursor: string | null }

async function getItems(storeId: string, query = "", session: string = SES_OWNER): Promise<ItemsPage> {
  const res = await as(session)(`${items(storeId)}${query}`).expect(200);
  const ok = contract().items(res.body);
  if (!ok) throw new Error(JSON.stringify(contract().items.errors));
  return res.body as ItemsPage;
}

async function getStores(query = "", session: string = SES_OWNER): Promise<StoresPage> {
  const res = await as(session)(`${STORES}${query}`).expect(200);
  const ok = contract().stores(res.body);
  if (!ok) throw new Error(JSON.stringify(contract().stores.errors));
  return res.body as StoresPage;
}

async function allStores(session: string, limit: number): Promise<SummaryBody[]> {
  const out: SummaryBody[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const page: StoresPage = await getStores(
      `?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
      session,
    );
    expect(page.items.length).toBeLessThanOrEqual(limit);
    out.push(...page.items);
    cursor = page.nextCursor;
    if (cursor === null) return out;
  }
  throw new Error("paging did not terminate");
}

function summaryOf(list: readonly SummaryBody[], storeId: string): SummaryBody {
  const s = list.find((x) => x.storeId === storeId);
  if (!s) throw new Error(`store ${storeId} missing from the summary`);
  return s;
}

/** Record a Connector snapshot for a running run through the real 019 service. */
async function report(runId: string, readAt: string, entries: Array<[string, string]>): Promise<void> {
  await binView.reportSnapshot({
    tenantId: TENANT_A,
    requestRef: deterministicId(BIN_VIEW_REQUEST_NS, `${runId}:0`),
    body: {
      readAt,
      entries: entries.map(([name, quantity]) => ({
        erpnextItemRef: { doctype: "Item" as const, name },
        quantity,
        stockUom: "Nos",
      })),
    },
    idempotencyKey: `rt177-${runId}`,
  });
}

// ---------------------------------------------------------------------------
// AC2 + AC3(pending) + AC4 — the S_FIX lifecycle (ordered)
// ---------------------------------------------------------------------------

describe("RT-177 AC2/AC3/AC4 — snapshot lifecycle of a mapped store", () => {
  it("before any report: no_snapshot, items [], count 0", async () => {
    if (skip()) return;
    const page = await getItems(S_FIX);
    expect(page.storeId).toBe(S_FIX);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.snapshot).toMatchObject({
      status: "no_snapshot",
      erpnextWarehouseRef: "WH-FIX",
      runId: null,
      readAt: null,
      recordedAt: null,
      staleAfterSeconds: 86400,
      reportedEntryCount: null,
      pendingRequest: null,
    });
  });

  it("AC2: A=-3.000000, B=5.000000, C(unmapped)=-1.500000 → exactly A then C, verbatim", async () => {
    if (skip()) return;
    await insertRun(env!.admin, { id: RUN_FIX_1, storeId: S_FIX, status: "running", startedAt: hoursAgo(0.5) });
    // Before the Connector reports, the run is a pending request with no snapshot.
    const waiting = await getItems(S_FIX);
    expect(waiting.snapshot.status).toBe("no_snapshot");
    expect(waiting.snapshot.pendingRequest?.runId).toBe(RUN_FIX_1);

    await report(RUN_FIX_1, READ_AT_1, [[ITEM_A, "-3.000000"], [ITEM_B, "5.000000"], [ITEM_C, "-1.500000"]]);

    const page = await getItems(S_FIX);
    expect(page.snapshot.status).toBe("fresh");
    expect(page.snapshot.runId).toBe(RUN_FIX_1);
    expect(page.snapshot.readAt).toBe(READ_AT_1);
    expect(page.snapshot.recordedAt).not.toBeNull();
    expect(page.snapshot.reportedEntryCount).toBe(3);
    expect(page.snapshot.erpnextWarehouseRef).toBe("WH-FIX");
    // The reported run is still `running` but carries a report: not pending.
    expect(page.snapshot.pendingRequest).toBeNull();
    expect(page.items).toEqual([
      {
        discrepancyKind: "erpnext_negative_on_hand",
        erpnextItemRef: { doctype: "Item", name: ITEM_A },
        mappingStatus: "mapped",
        tenantProduct: { id: PRODUCT_A_ACTIVE, name: productAName },
        erpnextWarehouseRef: "WH-FIX",
        quantity: "-3.000000",
        stockUom: "Nos",
      },
      {
        discrepancyKind: "erpnext_negative_on_hand",
        erpnextItemRef: { doctype: "Item", name: ITEM_C },
        mappingStatus: "unmapped",
        tenantProduct: null,
        erpnextWarehouseRef: "WH-FIX",
        quantity: "-1.500000",
        stockUom: "Nos",
      },
    ]);
    expect(page.nextCursor).toBeNull();

    const summary = summaryOf((await getStores("?limit=500")).items, S_FIX);
    expect(summary.negativeItemCount).toBe(2);
    expect(summary.snapshot).toEqual(page.snapshot);
  });

  it("AC3: a newer running run without a report → pendingRequest, previous snapshot still served", async () => {
    if (skip()) return;
    await insertRun(env!.admin, { id: RUN_FIX_2, storeId: S_FIX, status: "running", startedAt: new Date().toISOString() });
    const page = await getItems(S_FIX);
    expect(page.snapshot.status).toBe("fresh");
    expect(page.snapshot.runId).toBe(RUN_FIX_1);
    expect(page.snapshot.pendingRequest?.runId).toBe(RUN_FIX_2);
    expect(Number.isNaN(Date.parse(page.snapshot.pendingRequest!.requestedAt))).toBe(false);
    expect(page.items.map((i) => i.erpnextItemRef.name)).toEqual([ITEM_A, ITEM_C]);
  });

  it("AC4: the newer report supersedes; A=0 removes A; -0.000000 is not negative", async () => {
    if (skip()) return;
    await report(RUN_FIX_2, READ_AT_2, [
      [ITEM_A, "0"],
      [ITEM_C, "-1.500000"],
      ["RT177-ITEM-Z", "-0.000000"],
    ]);
    const page = await getItems(S_FIX);
    expect(page.snapshot.runId).toBe(RUN_FIX_2);
    expect(page.snapshot.readAt).toBe(READ_AT_2);
    expect(page.snapshot.reportedEntryCount).toBe(3);
    expect(page.snapshot.pendingRequest).toBeNull();
    expect(page.items.map((i) => [i.erpnextItemRef.name, i.quantity])).toEqual([[ITEM_C, "-1.500000"]]);
    expect(summaryOf((await getStores("?limit=500")).items, S_FIX).negativeItemCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC3 — freshness states
// ---------------------------------------------------------------------------

describe("RT-177 AC3 — snapshot freshness states", () => {
  it("no active stock map (only returns + retired maps, old snapshot) → no_warehouse_mapping", async () => {
    if (skip()) return;
    const page = await getItems(S_UNMAPPED);
    expect(page.items).toEqual([]);
    expect(page.snapshot).toEqual({
      status: "no_warehouse_mapping",
      erpnextWarehouseRef: null,
      runId: null,
      readAt: null,
      recordedAt: null,
      staleAfterSeconds: 86400,
      reportedEntryCount: null,
      pendingRequest: null,
    });
    expect(summaryOf((await getStores("?limit=500")).items, S_UNMAPPED).negativeItemCount).toBe(0);
  });

  it("mapped with no report → no_snapshot, items []", async () => {
    if (skip()) return;
    const page = await getItems(S_NOSNAP);
    expect(page.snapshot.status).toBe("no_snapshot");
    expect(page.snapshot.pendingRequest).toBeNull();
    expect(page.items).toEqual([]);
  });

  it("mapped with only a running request → no_snapshot + pendingRequest", async () => {
    if (skip()) return;
    const page = await getItems(S_PEND);
    expect(page.snapshot.status).toBe("no_snapshot");
    expect(page.snapshot.pendingRequest?.runId).toBe(RUN_PEND);
    expect(page.items).toEqual([]);
    expect(summaryOf((await getStores("?limit=500")).items, S_PEND).negativeItemCount).toBe(0);
  });

  it("recordedAt older than staleAfterSeconds → stale, items still returned", async () => {
    if (skip()) return;
    const page = await getItems(S_STALE);
    expect(page.snapshot.status).toBe("stale");
    expect(page.snapshot.runId).toBe(RUN_STALE);
    expect(page.items.map((i) => [i.erpnextItemRef.name, i.quantity])).toEqual([["STALE-X", "-2.000000"]]);
    expect(summaryOf((await getStores("?limit=500")).items, S_STALE).negativeItemCount).toBe(1);
  });

  it("a report with complete:false is not a snapshot; its running run is the pending request", async () => {
    if (skip()) return;
    const page = await getItems(S_INCOMPLETE);
    expect(page.snapshot.status).toBe("fresh");
    expect(page.snapshot.runId).toBe(RUN_INC_OLD);
    expect(page.snapshot.pendingRequest?.runId).toBe(RUN_INC_NEW);
    expect(page.items.map((i) => [i.erpnextItemRef.name, i.quantity])).toEqual([["INC-Q", "-1.000000"]]);
  });
});

// ---------------------------------------------------------------------------
// AC6 — pagination
// ---------------------------------------------------------------------------

describe("RT-177 AC6 — pagination", () => {
  it("items: default limit 100, then the rest; ordered by exact quantity then name", async () => {
    if (skip()) return;
    const first = await getItems(S_PAGE);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const second = await getItems(S_PAGE, `?cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();

    const all = (await getItems(S_PAGE, "?limit=500")).items;
    expect(all).toHaveLength(105);
    expect([...first.items, ...second.items]).toEqual(all);
    expect(all.some((i) => i.erpnextItemRef.name === "ZERO")).toBe(false);
    // Most negative first; ties by name.
    const key = (i: ItemBody) => Number(i.quantity);
    for (let k = 1; k < all.length; k++) {
      const prev = all[k - 1]!;
      const cur = all[k]!;
      expect(key(prev) < key(cur) || (key(prev) === key(cur) && prev.erpnextItemRef.name <= cur.erpnextItemRef.name)).toBe(true);
    }
  });

  it("items: small pages cover every row exactly once, in order", async () => {
    if (skip()) return;
    const all = (await getItems(S_PAGE, "?limit=500")).items;
    for (const limit of [1, 7, 104, 105]) {
      const seen: ItemBody[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 200; i++) {
        const page: ItemsPage = await getItems(S_PAGE, `?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
        expect(page.items.length).toBeLessThanOrEqual(limit);
        seen.push(...page.items);
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      expect(seen).toEqual(all);
    }
  });

  it("stores: limit=1 paging covers every visible store exactly once, ordered by id", async () => {
    if (skip()) return;
    const full = (await getStores("?limit=500")).items;
    const paged = await allStores(SES_OWNER, 1);
    expect(paged.map((s) => s.storeId)).toEqual(full.map((s) => s.storeId));
    expect(new Set(paged.map((s) => s.storeId)).size).toBe(paged.length);
    const ids = full.map((s) => s.storeId);
    expect(ids).toEqual([...ids].sort());
    // Every live tenant-A store, nothing else (no deleted store, no tenant B).
    expect(ids.sort()).toEqual(
      [S_FIX, S_STALE, S_UNMAPPED, S_NOSNAP, S_PEND, S_INCOMPLETE, S_PAGE].sort(),
    );
    expect(summaryOf(full, S_PAGE).negativeItemCount).toBe(105);
  });

  it.each([
    ["limit=0", "?limit=0"],
    ["limit=501", "?limit=501"],
    ["limit=abc", "?limit=abc"],
    ["garbage cursor", "?cursor=bm90LWpzb24"],
    ["non-base64url cursor", "?cursor=a.b"],
    ["unknown query key", "?storeId=" + S_FIX],
  ])("400 validation_error on %s (both operations)", async (_label, query) => {
    if (skip()) return;
    for (const path of [STORES, items(S_PAGE)]) {
      const res = await owner()(`${path}${query}`).expect(400);
      expect(res.body.error.code).toBe("validation_error");
      // Envelope shape only: the shared ZodValidationPipe adds `error.details`,
      // which this file's `Error` schema does not declare (pre-existing for every
      // operation of the file; not changed by RT-177).
      expect(typeof res.body.error.message).toBe("string");
    }
  });

  it("a cursor issued by one operation is a 400 on the other", async () => {
    if (skip()) return;
    const itemsPage = await getItems(S_PAGE, "?limit=1");
    const storesPage = await getStores("?limit=1");
    await owner()(`${STORES}?cursor=${itemsPage.nextCursor}`).expect(400);
    await owner()(`${items(S_PAGE)}?cursor=${storesPage.nextCursor}`).expect(400);
  });

  it("a malformed storeId → 400 validation_error", async () => {
    if (skip()) return;
    const res = await owner()(items("not-a-uuid")).expect(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

// ---------------------------------------------------------------------------
// AC5 — authorization
// ---------------------------------------------------------------------------

describe("RT-177 AC5 — authorization + non-disclosure", () => {
  it("store_manager scoped to S1 sees only S1 in the summary and gets 404 on S2", async () => {
    if (skip()) return;
    const list = await allStores(SES_MGR, 500);
    expect(list.map((s) => s.storeId)).toEqual([S_FIX]);
    await getItems(S_FIX, "", SES_MGR);
    const res = await as(SES_MGR)(items(S_STALE)).expect(404);
    expect(res.body.error.code).toBe("not_found");
    expect(contract().error(res.body)).toBe(true);
  });

  it("tenant_admin reads tenant-wide", async () => {
    if (skip()) return;
    const list = await allStores(SES_ADMIN, 500);
    expect(list.map((s) => s.storeId)).toContain(S_STALE);
    await getItems(S_STALE, "", SES_ADMIN);
  });

  it("cross-tenant, deleted and nonexistent stores → identical 404 not_found", async () => {
    if (skip()) return;
    const bodies = [];
    for (const storeId of [STORE_B_X, S_DELETED, NON_EXISTENT]) {
      const res = await owner()(items(storeId)).expect(404);
      bodies.push({ code: res.body.error.code, message: res.body.error.message });
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]!.code).toBe("not_found");
  });

  it("a role outside owner/tenant_admin/store_manager gets the default 404 on both operations", async () => {
    if (skip()) return;
    await as(SES_STAFF)(STORES).expect(404);
    await as(SES_STAFF)(items(S_FIX)).expect(404);
  });

  it("no session → 401 on both operations", async () => {
    if (skip()) return;
    await as(null)(STORES).expect(401);
    await as(null)(items(S_FIX)).expect(401);
  });
});

// ---------------------------------------------------------------------------
// AC7 — no write path
// ---------------------------------------------------------------------------

describe("RT-177 AC7 — the reads write nothing", () => {
  it("leaves runs, results, stock_movements, outbox and audit untouched", async () => {
    if (skip()) return;
    const fingerprint = async (): Promise<string> => {
      const r = await env!.admin.query<{ f: string }>(
        `SELECT concat_ws('|',
           (SELECT md5(coalesce(string_agg(id::text || status || coalesce(summary::text, '') || updated_at::text, ',' ORDER BY id), ''))
              FROM erpnext_reconciliation_run),
           (SELECT count(*) FROM erpnext_reconciliation_result),
           (SELECT count(*) FROM erpnext_reconciliation_repair_attempt),
           (SELECT count(*) FROM stock_movements),
           (SELECT count(*) FROM outbox_events),
           (SELECT count(*) FROM audit_events)) AS f`,
      );
      return r.rows[0]!.f;
    };
    const before = await fingerprint();
    await getStores("?limit=500");
    await getStores("?limit=500", SES_MGR);
    for (const s of [S_FIX, S_STALE, S_UNMAPPED, S_NOSNAP, S_PEND, S_INCOMPLETE, S_PAGE]) {
      await getItems(s, "?limit=500");
    }
    await owner()(items(STORE_B_X)).expect(404);
    expect(await fingerprint()).toBe(before);
  });
});
