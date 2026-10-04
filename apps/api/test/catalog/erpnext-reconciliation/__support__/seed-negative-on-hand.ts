/**
 * apps/api/test/catalog/erpnext-reconciliation/__support__/seed-negative-on-hand.ts
 *
 * RT-177 — fixtures for the ERPNext negative on-hand read model. Builds on the
 * catalog isolation fixture (tenants A/B, stores X/Y, products) and adds, via the
 * `admin` (RLS-bypassing) pool:
 *
 *   - extra tenant-A stores, one per snapshot state, plus a soft-deleted store;
 *   - members: owner (all), store_manager (S_FIX only), store_staff (all),
 *     tenant_admin (all), each with a live session and no active store, plus
 *     owner + tenant_admin sessions with S_PAGE selected as the active store;
 *   - a confirmed 013 item map for ITEM_A (ITEM_C stays unmapped);
 *   - 014 warehouse maps (S_UNMAPPED has only a `returns` map and a retired one);
 *   - stored Connector snapshots in the exact shape `reportSnapshot` writes (019).
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `0177`
 * mnemonic (hex only).
 */
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { Pool } from "pg";

import { deterministicId } from "@data-pulse-2/shared";

import type { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
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
// Fixture IDs
// ---------------------------------------------------------------------------

export const S_FIX = STORE_A_X; // AC2 / AC4 / AC3-pending — recorded via reportSnapshot
export const S_STALE = STORE_A_Y; // AC3 stale
export const S_UNMAPPED = "0a000000-0000-7000-8000-0000017700a1";
export const S_NOSNAP = "0a000000-0000-7000-8000-0000017700a2";
export const S_PEND = "0a000000-0000-7000-8000-0000017700a3";
export const S_INCOMPLETE = "0a000000-0000-7000-8000-0000017700a4";
export const S_PAGE = "0a000000-0000-7000-8000-0000017700a5";
export const S_DELETED = "0a000000-0000-7000-8000-0000017700a6";
export const NON_EXISTENT = "0a000000-0000-7000-8000-0000017700ff";

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

export const SES_OWNER = "0a000000-0000-7000-8000-0000017704a1";
export const SES_MGR = "0a000000-0000-7000-8000-0000017704a2";
export const SES_STAFF = "0a000000-0000-7000-8000-0000017704a3";
export const SES_ADMIN = "0a000000-0000-7000-8000-0000017704a4";
/** Owner / tenant_admin sessions with an ACTIVE store selected (S_PAGE). */
export const SES_OWNER_ACTIVE = "0a000000-0000-7000-8000-0000017704a5";
export const SES_ADMIN_ACTIVE = "0a000000-0000-7000-8000-0000017704a6";

const SESSION_USER: Readonly<Record<string, string>> = {
  [SES_OWNER]: USER_OWNER,
  [SES_MGR]: USER_MGR,
  [SES_STAFF]: USER_STAFF,
  [SES_ADMIN]: USER_ADMIN,
  [SES_OWNER_ACTIVE]: USER_OWNER,
  [SES_ADMIN_ACTIVE]: USER_ADMIN,
};

export const RUN_FIX_1 = "0a000000-0000-7000-8000-0000017705a1";
export const RUN_FIX_2 = "0a000000-0000-7000-8000-0000017705a2";
export const RUN_STALE = "0a000000-0000-7000-8000-0000017705a3";
export const RUN_PEND = "0a000000-0000-7000-8000-0000017705a4";
export const RUN_INC_OLD = "0a000000-0000-7000-8000-0000017705a5";
export const RUN_INC_NEW = "0a000000-0000-7000-8000-0000017705a6";
const RUN_PAGE = "0a000000-0000-7000-8000-0000017705a7";
const RUN_B = "0b000000-0000-7000-8000-0000017705b1";
const RUN_UNMAPPED_OLD = "0a000000-0000-7000-8000-0000017705af";
const RUN_DELETED = "0a000000-0000-7000-8000-0000017705ae";

export const BIN_VIEW_REQUEST_NS = "0190b1de-0000-7000-8000-0000000be019";
export const ITEM_A = "RT177-ITEM-A";
export const ITEM_B = "RT177-ITEM-B";
export const ITEM_C = "RT177-ITEM-C";

// ---------------------------------------------------------------------------
// Cookie-auth stand-in
// ---------------------------------------------------------------------------

/**
 * Stands in for cookie authentication ONLY: a test header names the session.
 * Without the header the real `DashboardAuthGuard` decides (no cookie → 401).
 */
export class HeaderSessionAuthGuard implements CanActivate {
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

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

export function hoursAgo(h: number): string {
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

export async function insertRun(
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

/** A completed run carrying a snapshot recorded (and read) `ageHours` ago. */
async function insertSnapshotRun(
  admin: Pool,
  opts: {
    id: string;
    tenantId?: string;
    storeId: string;
    warehouse: string;
    ageHours: number;
    entries: readonly SeedEntry[];
  },
): Promise<void> {
  const at = hoursAgo(opts.ageHours);
  await insertRun(admin, {
    id: opts.id,
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    storeId: opts.storeId,
    status: "completed",
    startedAt: at,
    report: storedReport({
      runId: opts.id, warehouse: opts.warehouse, recordedAt: at, readAt: at, entries: opts.entries,
    }),
  });
}

/** One 014 warehouse map row (tenant A, purpose `stock`, active unless stated). */
interface WarehouseMapSeed {
  readonly storeId: string;
  readonly warehouse: string;
  readonly tenantId?: string;
  readonly purpose?: "stock" | "returns";
  readonly retired?: boolean;
}

async function mapStore(admin: Pool, m: WarehouseMapSeed): Promise<void> {
  await admin.query(
    `INSERT INTO erpnext_warehouse_map
       (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version, retired_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 1,
             CASE WHEN $6::boolean THEN now() ELSE NULL END)`,
    [m.tenantId ?? TENANT_A, m.storeId, m.purpose ?? "stock", m.warehouse, USER_OWNER, m.retired ?? false],
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

// ---------------------------------------------------------------------------
// Seed steps
// ---------------------------------------------------------------------------

async function seedStores(admin: Pool): Promise<void> {
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
}

async function seedUsersAndRoles(admin: Pool): Promise<void> {
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
}

/** Memberships (the store_manager is granted S_FIX only) + live sessions. */
async function seedMembershipsAndSessions(admin: Pool): Promise<void> {
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
  await admin.query(
    `INSERT INTO sessions
       (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
     VALUES
       ($1, $2, $5, $6, now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($3, $4, $5, $6, now() + interval '1 hour', decode(md5(random()::text), 'hex'))`,
    [SES_OWNER_ACTIVE, USER_OWNER, SES_ADMIN_ACTIVE, USER_ADMIN, TENANT_A, S_PAGE],
  );
}

/** ITEM_A resolves to PRODUCT_A_ACTIVE (confirmed 013 map); ITEM_C does not. Returns the product name. */
async function seedItemMap(admin: Pool): Promise<string> {
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
  return product.rows[0]!.name;
}

/** S_UNMAPPED has only a `returns` map and a RETIRED stock map. */
const WAREHOUSE_MAPS: readonly WarehouseMapSeed[] = [
  { storeId: S_FIX, warehouse: "WH-FIX" },
  { storeId: S_STALE, warehouse: "WH-STALE" },
  { storeId: S_NOSNAP, warehouse: "WH-NOSNAP" },
  { storeId: S_PEND, warehouse: "WH-PEND" },
  { storeId: S_INCOMPLETE, warehouse: "WH-INC" },
  { storeId: S_PAGE, warehouse: "WH-PAGE" },
  { storeId: S_DELETED, warehouse: "WH-DEL" },
  { storeId: S_UNMAPPED, warehouse: "WH-RET", purpose: "returns" },
  { storeId: S_UNMAPPED, warehouse: "WH-OLD", retired: true },
  { storeId: STORE_B_X, warehouse: "WH-B", tenantId: TENANT_B },
];

async function seedWarehouseMaps(admin: Pool): Promise<void> {
  for (const m of WAREHOUSE_MAPS) await mapStore(admin, m);
}

/** Stale (3 days), pending-only and paging-volume snapshots. */
async function seedStateRuns(admin: Pool): Promise<void> {
  // An old unmapped-store snapshot must NOT surface (no active stock map wins).
  await insertSnapshotRun(admin, {
    id: RUN_UNMAPPED_OLD, storeId: S_UNMAPPED, warehouse: "WH-OLD", ageHours: 5,
    entries: [{ name: "OLD", quantity: "-4" }],
  });
  await insertSnapshotRun(admin, {
    id: RUN_STALE, storeId: S_STALE, warehouse: "WH-STALE", ageHours: 72,
    entries: [{ name: "STALE-X", quantity: "-2.000000" }, { name: "STALE-Y", quantity: "1.000000" }],
  });
  await insertRun(admin, { id: RUN_PEND, storeId: S_PEND, status: "running", startedAt: hoursAgo(1) });
  await insertSnapshotRun(admin, {
    id: RUN_PAGE, storeId: S_PAGE, warehouse: "WH-PAGE", ageHours: 1, entries: pageEntriesFixture(),
  });
}

/**
 * RT-175 forward-compat: a newer report marked complete:false is not usable;
 * its still-running run is the pending request; the older snapshot is served.
 */
async function seedIncompleteRuns(admin: Pool): Promise<void> {
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
}

/** Deleted store + tenant B: snapshots exist but must never be visible to A. */
async function seedHiddenRuns(admin: Pool): Promise<void> {
  await insertSnapshotRun(admin, {
    id: RUN_DELETED, storeId: S_DELETED, warehouse: "WH-DEL", ageHours: 1,
    entries: [{ name: "DEL", quantity: "-1" }],
  });
  await insertSnapshotRun(admin, {
    id: RUN_B, tenantId: TENANT_B, storeId: STORE_B_X, warehouse: "WH-B", ageHours: 1,
    entries: [{ name: "B-ITEM", quantity: "-7" }],
  });
}

/** Seed the whole RT-177 fixture. Returns the mapped product's name (PRODUCT_A_ACTIVE). */
export async function seedNegativeOnHandFixture(admin: Pool): Promise<string> {
  await seedCatalogIsolationFixture({ admin });
  await seedStores(admin);
  await seedUsersAndRoles(admin);
  await seedMembershipsAndSessions(admin);
  const productAName = await seedItemMap(admin);
  await seedWarehouseMaps(admin);
  await seedStateRuns(admin);
  await seedIncompleteRuns(admin);
  await seedHiddenRuns(admin);
  return productAName;
}
