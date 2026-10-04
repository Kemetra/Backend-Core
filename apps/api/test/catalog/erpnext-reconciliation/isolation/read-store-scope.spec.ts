/**
 * RT-192 — the ERPNext reconciliation READS are bound to the caller's
 * membership store scope (HTTP + Testcontainers, the real module graph).
 *
 * Covered reads (the RT-191 follow-up; the writes are RT-191's
 * `write-store-scope.spec.ts`):
 *   GET /postings/backlog          listPostingBacklog
 *   GET /runs/:runId               getReconciliationRun
 *   GET /runs/:runId/results       listReconciliationResults
 *
 * For each: a `specific`-membership owner and tenant_admin see only their
 * granted store; an `all`-membership owner sees every store of the tenant (an
 * active store does not narrow it). The backlog's `storeId` filter outside the
 * scope is an empty page (the contract declares no 404 for this list); a run
 * outside the scope is the same non-disclosing 404 as a missing or foreign one.
 * Cursor paging stays gap-free when rows are filtered out. A grant on a
 * soft-deleted store does not widen a `specific` scope; the tenant-wide scope
 * still reads that store's history (deletion blocks writes, RT-191).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import request from "supertest";

import { ErpnextReconciliationModule } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.module";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, STORE_B_X } from "../../__support__/isolation-harness";
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
  RESULT_A2,
  RUN_DEL,
  RUN_X,
  RUN_Y,
  S_DELETED,
  SES_OWNER_ALL,
  SES_OWNER_ALL_ACTIVE,
  SES_OWNER_SPEC,
  SPECIFIC_SESSIONS,
  seedReadStoreScope,
} from "../__support__/read-store-scope";
import { RESULT_A, RUN_B } from "../__support__/seed-reconciliation";

const BASE = "/api/v1/catalog/erpnext-reconciliation";
const BACKLOG = `${BASE}/postings/backlog`;
const run = (id: string): string => `${BASE}/runs/${id}`;
const results = (id: string): string => `${BASE}/runs/${id}/results`;

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
      console.warn(`\n[RT-192 read-store-scope] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  app = await bootScopedApp(env, ErpnextReconciliationModule);
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-192 read-store-scope] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function get(path: string, session: string, query: Record<string, string | number> = {}) {
  return request(app!.getHttpServer()).get(path).set("x-test-session", session).query(query);
}

/** Walk the backlog to its end at `limit` per page; the work-item refs in order. */
async function walkBacklog(session: string, limit: number, query: Record<string, string> = {}): Promise<string[]> {
  const refs: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages += 1) {
    const res: request.Response = await get(BACKLOG, session, { ...query, limit, ...(cursor ? { cursor } : {}) }).expect(200);
    refs.push(...(res.body.items as Array<{ workItemRef: string }>).map((i) => i.workItemRef));
    cursor = res.body.nextCursor;
    if (cursor === null) return refs;
  }
  throw new Error("backlog paging did not terminate");
}

// ---------------------------------------------------------------------------
// listPostingBacklog
// ---------------------------------------------------------------------------

describe("RT-192 listPostingBacklog — membership store scope", () => {
  it.each(SPECIFIC_SESSIONS)("a specific-membership %s sees only the granted store's dead-letters", async (_role, session) => {
    if (skip()) return;
    expect(await walkBacklog(session, 100)).toEqual([DL_X1, DL_X2, DL_X3]);
  });

  it.each([1, 2])("paging at limit %i stays gap-free and in order while out-of-scope rows are skipped", async (limit) => {
    if (skip()) return;
    expect(await walkBacklog(SES_OWNER_SPEC, limit)).toEqual([DL_X1, DL_X2, DL_X3]);
  });

  it.each(SPECIFIC_SESSIONS)("a specific-membership %s: an out-of-scope storeId filter is an empty page", async (_role, session) => {
    if (skip()) return;
    const res = await get(BACKLOG, session, { storeId: STORE_A_Y }).expect(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it("an in-scope storeId filter (any case) returns that store's dead-letters", async () => {
    if (skip()) return;
    expect(await walkBacklog(SES_OWNER_SPEC, 100, { storeId: STORE_A_X.toUpperCase() })).toEqual([DL_X1, DL_X2, DL_X3]);
  });

  it("deleted, foreign and missing storeId filters are the same empty page", async () => {
    if (skip()) return;
    for (const storeId of [S_DELETED, STORE_B_X, NON_EXISTENT]) {
      const res = await get(BACKLOG, SES_OWNER_SPEC, { storeId }).expect(200);
      expect(res.body).toEqual({ items: [], nextCursor: null });
    }
  });

  it.each([
    ["no active store", SES_OWNER_ALL],
    ["an active store", SES_OWNER_ALL_ACTIVE],
  ])("an all-membership owner with %s sees every store of the tenant", async (_label, session) => {
    if (skip()) return;
    const refs = await walkBacklog(session, 2);
    expect(refs).toEqual(expect.arrayContaining([DL_X1, DL_Y1, DL_X2, DL_Y2, DL_X3, DL_DEL]));
    expect(refs).toHaveLength(await countDeadletters(env!.admin, null));
  });

  it("an all-membership owner filters to a non-active store", async () => {
    if (skip()) return;
    expect(await walkBacklog(SES_OWNER_ALL_ACTIVE, 100, { storeId: STORE_A_Y })).toEqual([DL_Y1, DL_Y2]);
  });
});

// ---------------------------------------------------------------------------
// getReconciliationRun
// ---------------------------------------------------------------------------

describe("RT-192 getReconciliationRun — membership store scope", () => {
  it.each(SPECIFIC_SESSIONS)("a specific-membership %s: granted run → 200, other store's run → 404", async (_role, session) => {
    if (skip()) return;
    const ok = await get(run(RUN_X), session).expect(200);
    expect(ok.body).toMatchObject({ id: RUN_X, storeId: STORE_A_X });
    await get(run(RUN_Y), session).expect(404);
  });

  it("out-of-scope, deleted-store, foreign and missing runs answer the identical 404 body", async () => {
    if (skip()) return;
    const bodies = await Promise.all(
      [RUN_Y, RUN_DEL, RUN_B, NON_EXISTENT].map((id) => get(run(id), SES_OWNER_SPEC).expect(404)),
    );
    for (const res of bodies) expect(res.body.error).toMatchObject({ code: "not_found", message: "Run not found." });
  });

  it.each([
    ["no active store", SES_OWNER_ALL],
    ["an active store", SES_OWNER_ALL_ACTIVE],
  ])("an all-membership owner with %s reads any store's run, a deleted store's history included", async (_label, session) => {
    if (skip()) return;
    for (const id of [RUN_X, RUN_Y, RUN_DEL]) await get(run(id), session).expect(200);
    await get(run(RUN_B), session).expect(404);
  });
});

// ---------------------------------------------------------------------------
// listReconciliationResults
// ---------------------------------------------------------------------------

describe("RT-192 listReconciliationResults — membership store scope", () => {
  it.each(SPECIFIC_SESSIONS)("a specific-membership %s: granted run's results → 200, other store's → 404", async (_role, session) => {
    if (skip()) return;
    const ok = await get(results(RUN_X), session).expect(200);
    expect(ok.body.items.map((r: { id: string }) => r.id).sort()).toEqual([RESULT_A, RESULT_A2].sort());
    const denied = await get(results(RUN_Y), session).expect(404);
    expect(denied.body.error).toMatchObject({ code: "not_found", message: "Run not found." });
  });

  it("a deleted-store, foreign or missing run's results are the same 404 for a specific member", async () => {
    if (skip()) return;
    for (const id of [RUN_DEL, RUN_B, NON_EXISTENT]) {
      const res = await get(results(id), SES_OWNER_SPEC).expect(404);
      expect(res.body.error).toMatchObject({ code: "not_found", message: "Run not found." });
    }
  });

  it("results of a granted run page at limit 1 without gaps", async () => {
    if (skip()) return;
    const first = await get(results(RUN_X), SES_OWNER_SPEC, { limit: 1 }).expect(200);
    const second = await get(results(RUN_X), SES_OWNER_SPEC, { limit: 1, cursor: first.body.nextCursor }).expect(200);
    const ids = [...first.body.items, ...second.body.items].map((r: { id: string }) => r.id);
    expect(ids.sort()).toEqual([RESULT_A, RESULT_A2].sort());
  });

  it("an all-membership owner with an active store reads another store's results", async () => {
    if (skip()) return;
    const res = await get(results(RUN_Y), SES_OWNER_ALL_ACTIVE).expect(200);
    expect(res.body.items).toHaveLength(1);
    await get(results(RUN_DEL), SES_OWNER_ALL).expect(200);
  });
});
