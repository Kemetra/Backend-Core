/**
 * RT-192 — the 025 console sync-ops read model is bound to the caller's
 * membership store scope (HTTP + Testcontainers, the real module graph).
 *
 * Covered reads:
 *   GET /summary                consoleGetSyncOpsSummary
 *   GET /posting-backlog        consoleListPostingBacklog
 *   GET /reconciliation-runs    consoleListReconciliationRuns
 *
 * For each: a `specific`-membership owner and tenant_admin see only their
 * granted store; an `all`-membership owner sees every store of the tenant (an
 * active store does not narrow it). A `store_id` outside the caller's accessible
 * stores is the contract's non-disclosing 404, identical to a foreign or missing
 * store. Cursor paging stays gap-free when rows are filtered out.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import request from "supertest";

import { ErpnextSyncOpsModule } from "../../../src/catalog/erpnext-sync-ops/erpnext-sync-ops.module";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, STORE_B_X } from "../__support__/isolation-harness";
import {
  bootScopedApp,
  countDeadletters,
  DL_DEL,
  DL_X1,
  DL_X2,
  DL_X3,
  DL_Y1,
  DL_Y2,
  NON_EXISTENT,
  RUN_DEL,
  RUN_X,
  RUN_X2,
  RUN_Y,
  S_DELETED,
  SES_OWNER_ALL,
  SES_OWNER_ALL_ACTIVE,
  SES_OWNER_SPEC,
  SPECIFIC_SESSIONS,
  seedReadStoreScope,
} from "../erpnext-reconciliation/__support__/read-store-scope";

const BASE = "/api/v1/catalog/erpnext-sync-ops";
const SUMMARY = `${BASE}/summary`;
const BACKLOG = `${BASE}/posting-backlog`;
const RUNS = `${BASE}/reconciliation-runs`;

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let app: INestApplication | null = null;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReadStoreScope(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-192 sync-ops-store-scope] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  app = await bootScopedApp(env, ErpnextSyncOpsModule);
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-192 sync-ops-store-scope] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function get(path: string, session: string, query: Record<string, string | number> = {}) {
  return request(app!.getHttpServer()).get(path).set("x-test-session", session).query(query);
}

/** Walk a sync-ops list to its end at `page_size`; the ids `key` picks, in order. */
async function walk(
  path: string,
  key: "postingStatusId" | "runId",
  session: string,
  pageSize: number,
  query: Record<string, string> = {},
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages += 1) {
    const res: request.Response = await get(path, session, { ...query, page_size: pageSize, ...(cursor ? { cursor } : {}) }).expect(200);
    ids.push(...(res.body.items as Array<Record<string, string>>).map((i) => i[key]!));
    cursor = res.body.nextCursor;
    if (cursor === null) return ids;
  }
  throw new Error(`${path} paging did not terminate`);
}

async function postingHeadline(session: string, query: Record<string, string> = {}): Promise<number> {
  const res = await get(SUMMARY, session, query).expect(200);
  const posting = (res.body.domains as Array<{ domain: string; headlineCount: number }>).find(
    (d) => d.domain === "posting",
  );
  return posting!.headlineCount;
}

async function reconciliationHeadline(session: string): Promise<number> {
  const res = await get(SUMMARY, session).expect(200);
  const rec = (res.body.domains as Array<{ domain: string; headlineCount: number }>).find(
    (d) => d.domain === "reconciliation",
  );
  return rec!.headlineCount;
}

const OUT_OF_SCOPE_STORES = [STORE_A_Y, S_DELETED, STORE_B_X, NON_EXISTENT];

// ---------------------------------------------------------------------------
// consoleGetSyncOpsSummary
// ---------------------------------------------------------------------------

describe("RT-192 sync-ops summary — membership store scope", () => {
  it.each(SPECIFIC_SESSIONS)("a specific-membership %s counts only the granted store", async (_role, session) => {
    if (skip()) return;
    expect(await postingHeadline(session)).toBe(await countDeadletters(env!.admin, [STORE_A_X]));
    // RUN_A carries the fixture's RESULT_A + RESULT_A2 (open); RUN_Y / RUN_DEL are out of scope.
    expect(await reconciliationHeadline(session)).toBe(2);
  });

  it.each([
    ["no active store", SES_OWNER_ALL],
    ["an active store", SES_OWNER_ALL_ACTIVE],
  ])("an all-membership owner with %s counts every store of the tenant", async (_label, session) => {
    if (skip()) return;
    expect(await postingHeadline(session)).toBe(await countDeadletters(env!.admin, null));
    expect(await reconciliationHeadline(session)).toBe(4);
  });

  it("an in-scope store_id filter narrows the summary", async () => {
    if (skip()) return;
    expect(await postingHeadline(SES_OWNER_ALL, { store_id: STORE_A_Y })).toBe(2);
    expect(await postingHeadline(SES_OWNER_SPEC, { store_id: STORE_A_X })).toBe(
      await countDeadletters(env!.admin, [STORE_A_X]),
    );
  });

  it("out-of-scope, deleted, foreign and missing store_id filters are the identical 404", async () => {
    if (skip()) return;
    for (const store_id of OUT_OF_SCOPE_STORES) {
      const res = await get(SUMMARY, SES_OWNER_SPEC, { store_id }).expect(404);
      expect(res.body.error).toMatchObject({ code: "not_found", message: "Not found." });
    }
  });
});

// ---------------------------------------------------------------------------
// consoleListPostingBacklog
// ---------------------------------------------------------------------------

describe("RT-192 sync-ops posting-backlog — membership store scope", () => {
  it.each(SPECIFIC_SESSIONS)("a specific-membership %s sees only the granted store's dead-letters", async (_role, session) => {
    if (skip()) return;
    expect(await walk(BACKLOG, "postingStatusId", session, 100)).toEqual([DL_X1, DL_X2, DL_X3]);
  });

  it.each([1, 2])("paging at page_size %i stays gap-free while out-of-scope rows are skipped", async (pageSize) => {
    if (skip()) return;
    expect(await walk(BACKLOG, "postingStatusId", SES_OWNER_SPEC, pageSize)).toEqual([DL_X1, DL_X2, DL_X3]);
  });

  it("an all-membership owner with an active store sees every store and may filter to another", async () => {
    if (skip()) return;
    const ids = await walk(BACKLOG, "postingStatusId", SES_OWNER_ALL_ACTIVE, 2);
    expect(ids).toEqual(expect.arrayContaining([DL_X1, DL_Y1, DL_X2, DL_Y2, DL_X3, DL_DEL]));
    expect(ids).toHaveLength(await countDeadletters(env!.admin, null));
    expect(await walk(BACKLOG, "postingStatusId", SES_OWNER_ALL_ACTIVE, 100, { store_id: STORE_A_Y })).toEqual([
      DL_Y1,
      DL_Y2,
    ]);
  });

  it.each(SPECIFIC_SESSIONS)("a specific-membership %s: an out-of-scope store_id → 404", async (_role, session) => {
    if (skip()) return;
    for (const store_id of OUT_OF_SCOPE_STORES) await get(BACKLOG, session, { store_id }).expect(404);
  });
});

// ---------------------------------------------------------------------------
// consoleListReconciliationRuns
// ---------------------------------------------------------------------------

describe("RT-192 sync-ops reconciliation-runs — membership store scope", () => {
  it.each(SPECIFIC_SESSIONS)("a specific-membership %s sees only the granted store's runs", async (_role, session) => {
    if (skip()) return;
    expect((await walk(RUNS, "runId", session, 100)).sort()).toEqual([RUN_X, RUN_X2].sort());
  });

  it("paging at page_size 1 stays gap-free while out-of-scope runs are skipped", async () => {
    if (skip()) return;
    const ids = await walk(RUNS, "runId", SES_OWNER_SPEC, 1);
    expect(ids).toHaveLength(2);
    expect(ids.sort()).toEqual([RUN_X, RUN_X2].sort());
  });

  it.each([
    ["no active store", SES_OWNER_ALL],
    ["an active store", SES_OWNER_ALL_ACTIVE],
  ])("an all-membership owner with %s sees every store's runs", async (_label, session) => {
    if (skip()) return;
    expect((await walk(RUNS, "runId", session, 1)).sort()).toEqual([RUN_X, RUN_X2, RUN_Y, RUN_DEL].sort());
  });

  it.each(SPECIFIC_SESSIONS)("a specific-membership %s: an out-of-scope store_id → 404", async (_role, session) => {
    if (skip()) return;
    for (const store_id of OUT_OF_SCOPE_STORES) await get(RUNS, session, { store_id }).expect(404);
  });
});
