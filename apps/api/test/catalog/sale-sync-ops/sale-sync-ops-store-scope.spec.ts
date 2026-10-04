/**
 * RT-193 — the 032 sale-sync-ops read/repair surface is bound to the caller's
 * membership store scope (HTTP + Testcontainers, the real module graph: real
 * TenantContextGuard / RolesGuard / MembershipRepository / IdempotencyModule).
 *
 * Covered routes:
 *   GET  /sales/{saleRef}/status          consoleGetSaleSyncStatus
 *   GET  /sales/{saleRef}/audit-timeline  consoleGetSaleAuditTimeline
 *   GET  /needs-repair                    consoleListNeedsRepair
 *   POST /sales/{saleRef}/repair          consoleRepairSaleSync
 *
 * A `specific`-membership owner and tenant_admin reach only their granted
 * store: a sale on another store (or a deleted store, another tenant, or no
 * sale at all) is the identical non-disclosing 404, and a 404 repair writes
 * nothing (no status change, no dead-letter resolution, no audit). An `all`
 * owner keeps tenant-wide reach, not narrowed by an active store. An empty
 * scope fails closed. Cursor paging stays gap-free while rows are filtered out.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import request from "supertest";

import type { AuditJobPayload } from "../../../src/audit/audit-job.types";
import { SaleSyncOpsModule } from "../../../src/catalog/sale-sync-ops/sale-sync-ops.module";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, STORE_B_X } from "../__support__/isolation-harness";
import {
  bootScopedApp,
  NON_EXISTENT,
  S_DELETED,
  SES_OWNER_ALL,
  SES_OWNER_ALL_ACTIVE,
  SES_OWNER_SPEC,
  SPECIFIC_SESSIONS,
} from "../erpnext-reconciliation/__support__/read-store-scope";
import {
  SES_ADMIN_EMPTY,
  saleRepairState,
  seedSaleSyncStoreScope,
  SS_B,
  SS_DEL,
  SS_MISSING,
  SS_X1,
  SS_X2,
  SS_X3,
  SS_Y1,
  SS_Y2,
} from "./__support__/sale-sync-store-scope";

const BASE = "/api/v1/catalog/sale-sync-ops";
const NEEDS_REPAIR = `${BASE}/needs-repair`;
const status = (sale: string): string => `${BASE}/sales/${sale}/status`;
const timeline = (sale: string): string => `${BASE}/sales/${sale}/audit-timeline`;
const repairPath = (sale: string): string => `${BASE}/sales/${sale}/repair`;

const NOT_FOUND = { code: "not_found", message: "Not found." };
/** Sales a `specific` (STORE_A_X) member must not reach: other store, deleted store, other tenant, none. */
const OUT_OF_SCOPE_SALES = [SS_Y1, SS_DEL, SS_B, SS_MISSING];
const OUT_OF_SCOPE_STORES = [STORE_A_Y, S_DELETED, STORE_B_X, NON_EXISTENT];
const ALL_OWNER_SESSIONS: ReadonlyArray<readonly [string, string]> = [
  ["no active store", SES_OWNER_ALL],
  ["an active store", SES_OWNER_ALL_ACTIVE],
];
const OBJECT_READS: ReadonlyArray<readonly [string, (sale: string) => string]> = [
  ["status", status],
  ["audit-timeline", timeline],
];

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let app: INestApplication | null = null;
const audited: AuditJobPayload[] = [];

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedSaleSyncStoreScope(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-193 sale-sync-ops-store-scope] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  app = await bootScopedApp(env, SaleSyncOpsModule, {
    enqueue: async (payload) => {
      audited.push(payload);
    },
  });
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-193 sale-sync-ops-store-scope] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function get(path: string, session: string, query: Record<string, string | number> = {}) {
  return request(app!.getHttpServer()).get(path).set("x-test-session", session).query(query);
}

let keySeq = 0;
function repair(sale: string, session: string) {
  keySeq += 1;
  return request(app!.getHttpServer())
    .post(repairPath(sale))
    .set("x-test-session", session)
    .set("Idempotency-Key", `rt193-repair-key-${String(keySeq).padStart(4, "0")}`);
}

/** Walk the NEEDS_REPAIR list to its end at `page_size`; the sale refs, in order. */
async function walk(session: string, pageSize: number, query: Record<string, string> = {}): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages += 1) {
    const res: request.Response = await get(NEEDS_REPAIR, session, {
      ...query,
      page_size: pageSize,
      ...(cursor ? { cursor } : {}),
    }).expect(200);
    ids.push(...(res.body.items as Array<{ saleRef: string }>).map((i) => i.saleRef));
    cursor = res.body.nextCursor;
    if (cursor === null) return ids;
  }
  throw new Error("needs-repair paging did not terminate");
}

// ---------------------------------------------------------------------------
// consoleGetSaleSyncStatus / consoleGetSaleAuditTimeline
// ---------------------------------------------------------------------------

describe.each(OBJECT_READS)("RT-193 sale-sync-ops %s — membership store scope", (_name, path) => {
  it.each(SPECIFIC_SESSIONS)("a specific-membership %s reads a sale on the granted store", async (_role, session) => {
    if (skip()) return;
    const res = await get(path(SS_X1), session).expect(200);
    expect(res.body.saleRef).toBe(SS_X1);
  });

  it.each(SPECIFIC_SESSIONS)(
    "a specific-membership %s: other-store, deleted-store, foreign and missing sales are the identical 404",
    async (_role, session) => {
      if (skip()) return;
      for (const sale of OUT_OF_SCOPE_SALES) {
        const res = await get(path(sale), session).expect(404);
        expect(res.body.error).toMatchObject(NOT_FOUND);
      }
    },
  );

  it.each(ALL_OWNER_SESSIONS)("an all-membership owner with %s reads every store's sales", async (_label, session) => {
    if (skip()) return;
    for (const sale of [SS_X1, SS_Y1, SS_DEL]) {
      const res = await get(path(sale), session).expect(200);
      expect(res.body.saleRef).toBe(sale);
    }
  });

  it("another tenant's sale is 404 even for an all-membership owner", async () => {
    if (skip()) return;
    const res = await get(path(SS_B), SES_OWNER_ALL).expect(404);
    expect(res.body.error).toMatchObject(NOT_FOUND);
  });

  it("an empty store scope fails closed", async () => {
    if (skip()) return;
    const res = await get(path(SS_X1), SES_ADMIN_EMPTY).expect(404);
    expect(res.body.error).toMatchObject(NOT_FOUND);
  });
});

describe("RT-193 sale-sync-ops status — the projection is unchanged in scope", () => {
  it("returns the sale's store, status and open dead-letter", async () => {
    if (skip()) return;
    const res = await get(status(SS_Y1), SES_OWNER_ALL).expect(200);
    expect(res.body).toMatchObject({
      saleRef: SS_Y1,
      storeId: STORE_A_Y,
      syncStatus: "failed-needs-repair",
      deadLetter: { classification: "needs-repair", reasonCode: "validation_failure", resolvedAt: null },
    });
  });
});

// ---------------------------------------------------------------------------
// consoleListNeedsRepair
// ---------------------------------------------------------------------------

describe("RT-193 sale-sync-ops needs-repair — membership store scope", () => {
  it.each(SPECIFIC_SESSIONS)("a specific-membership %s lists only the granted store", async (_role, session) => {
    if (skip()) return;
    expect(await walk(session, 100)).toEqual([SS_X3, SS_X2, SS_X1]);
  });

  it.each([1, 2])("paging at page_size %i stays gap-free while out-of-scope rows are skipped", async (pageSize) => {
    if (skip()) return;
    expect(await walk(SES_OWNER_SPEC, pageSize)).toEqual([SS_X3, SS_X2, SS_X1]);
  });

  it.each(ALL_OWNER_SESSIONS)("an all-membership owner with %s lists every store of the tenant", async (_label, session) => {
    if (skip()) return;
    expect(await walk(session, 2)).toEqual([SS_DEL, SS_X3, SS_Y2, SS_X2, SS_Y1, SS_X1]);
  });

  it("an in-scope store_id filter narrows the list", async () => {
    if (skip()) return;
    expect(await walk(SES_OWNER_ALL_ACTIVE, 1, { store_id: STORE_A_Y })).toEqual([SS_Y2, SS_Y1]);
    expect(await walk(SES_OWNER_SPEC, 1, { store_id: STORE_A_X })).toEqual([SS_X3, SS_X2, SS_X1]);
  });

  it.each(SPECIFIC_SESSIONS)(
    "a specific-membership %s: out-of-scope, deleted, foreign and missing store_id filters are the identical 404",
    async (_role, session) => {
      if (skip()) return;
      for (const store_id of OUT_OF_SCOPE_STORES) {
        const res = await get(NEEDS_REPAIR, session, { store_id }).expect(404);
        expect(res.body.error).toMatchObject(NOT_FOUND);
      }
    },
  );

  it("an empty store scope lists nothing", async () => {
    if (skip()) return;
    const res = await get(NEEDS_REPAIR, SES_ADMIN_EMPTY).expect(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });
});

// ---------------------------------------------------------------------------
// consoleRepairSaleSync — last: the successful repairs change the queue.
// ---------------------------------------------------------------------------

describe("RT-193 sale-sync-ops repair — membership store scope", () => {
  const UNTOUCHED = { syncStatus: "failed-needs-repair", openDeadletters: 1, retryCount: 0 };

  it.each(SPECIFIC_SESSIONS)(
    "a specific-membership %s: an out-of-scope repair is the identical 404 and writes nothing",
    async (_role, session) => {
      if (skip()) return;
      const before = audited.length;
      for (const sale of OUT_OF_SCOPE_SALES) {
        const res = await repair(sale, session).expect(404);
        expect(res.body.error).toMatchObject(NOT_FOUND);
      }
      for (const sale of [SS_Y1, SS_DEL, SS_B]) {
        expect(await saleRepairState(env!.admin, sale)).toEqual(UNTOUCHED);
      }
      expect(audited.slice(before)).toEqual([]);
    },
  );

  it("an empty store scope cannot repair", async () => {
    if (skip()) return;
    await repair(SS_X1, SES_ADMIN_EMPTY).expect(404);
    expect(await saleRepairState(env!.admin, SS_X1)).toEqual(UNTOUCHED);
  });

  it("a specific-membership owner repairs a sale on the granted store", async () => {
    if (skip()) return;
    const res = await repair(SS_X1, SES_OWNER_SPEC).expect((r) => expect(r.status).toBeLessThan(300));
    expect(res.body).toMatchObject({ saleRef: SS_X1, storeId: STORE_A_X, syncStatus: "failed-retryable" });
    expect(await saleRepairState(env!.admin, SS_X1)).toEqual({
      syncStatus: "failed-retryable",
      openDeadletters: 0,
      retryCount: 1,
    });
    expect(audited.map((a) => a.action)).toContain("sale_sync_ops.repair.requested");
  });

  it("an all-membership owner with an active store still repairs another store's sale", async () => {
    if (skip()) return;
    await repair(SS_Y2, SES_OWNER_ALL_ACTIVE).expect((r) => expect(r.status).toBeLessThan(300));
    expect((await saleRepairState(env!.admin, SS_Y2)).syncStatus).toBe("failed-retryable");
  });

  it("another tenant's sale is 404 even for an all-membership owner", async () => {
    if (skip()) return;
    await repair(SS_B, SES_OWNER_ALL).expect(404);
    expect(await saleRepairState(env!.admin, SS_B)).toEqual(UNTOUCHED);
  });
});
