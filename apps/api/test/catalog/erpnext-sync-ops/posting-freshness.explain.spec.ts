/**
 * RT-565 D7 — query-plan evidence for the posting-freshness read.
 *
 * Seeds a busy tenant (many stores, tens of thousands of posting rows, a
 * pending backlog, pre-0042 legacy rows), a quiet store and a legacy-only store
 * inside it, an empty store, and a second busy tenant. Then runs
 * `EXPLAIN (ANALYZE, BUFFERS)` of the EXACT runtime statements
 * (`TENANT_FRESHNESS_SQL` / `STORES_FRESHNESS_SQL`) under tenant RLS on the
 * NOBYPASSRLS app pool, default planner settings, for every D7 scope:
 *   tenant-wide · one busy store · a quiet store in a busy tenant ·
 *   a multi-store membership scope · an unknown (legacy-only) scope · a none scope.
 *
 * Each plan must reach erpnext_posting_status only through an index (no Seq
 * Scan) and use the D7 index for each probe. The facts are checked too.
 *
 * Set RT565_EXPLAIN_OUT=<file> to write the text plans (the PR evidence).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { appendFileSync, writeFileSync } from "node:fs";

import { runWithTenantContext } from "@data-pulse-2/db";

import {
  readPostingFreshness,
  STORES_FRESHNESS_SQL,
  TENANT_FRESHNESS_SQL,
} from "../../../src/catalog/erpnext-sync-ops/posting-freshness.read";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";

const TENANT = "0a000000-0000-7000-8000-000000565001";
const TENANT_OTHER = "0a000000-0000-7000-8000-000000565002";
const ACTOR = "0a000000-0000-7000-8000-000000565003";
const BUSY_STORES = 20;
const POSTED_PER_BUSY_STORE = 2500;
const PENDING_PER_BUSY_STORE = 100;
const LEGACY_PER_BUSY_STORE = 10;

const storeId = (tenantNo: number, n: number): string =>
  `0a000000-0000-7000-8000-${tenantNo.toString(16).padStart(4, "0")}${n.toString(16).padStart(8, "0")}`;
const BUSY = Array.from({ length: BUSY_STORES }, (_, i) => storeId(0x5651, i + 1));
const QUIET = storeId(0x5651, 0x100);
const LEGACY_ONLY = storeId(0x5651, 0x101);
const EMPTY = storeId(0x5651, 0x102);
const OTHER = storeId(0x5652, 1);

const IDX = {
  postedTenant: "idx_erpnext_posting_status_posted_at_tenant",
  postedStore: "idx_erpnext_posting_status_posted_at_store",
  pendingTenant: "idx_erpnext_posting_status_pending_created_tenant",
  pendingStore: "idx_erpnext_posting_status_pending_created_store",
  legacy: "idx_erpnext_posting_status_legacy_posted",
} as const;

let env: PgTestEnv | null = null;
let dockerSkipped = false;
const OUT = process.env["RT565_EXPLAIN_OUT"];

/** Seed `n` sales + posting rows on one store (one INSERT ... SELECT each). */
async function seed(
  tenantId: string,
  store: string,
  tag: string,
  n: number,
  status: "pending" | "posted" | "permanently_rejected",
  posted: "recent" | "old" | "null",
): Promise<void> {
  if (n === 0) return;
  await env!.admin.query(
    `WITH s AS (
       INSERT INTO sales
         (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
          business_date, source_system, external_id, payload_hash, created_by)
       SELECT gen_random_uuid(), $1, $2, 'EGP', 10, now(), current_date,
              'pos-565', $3 || '-' || g, repeat('c', 64), $4
         FROM generate_series(1, $5) g
       RETURNING id, tenant_id, store_id, external_id)
     INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system,
        external_id, payload_hash, status, document_ref, posted_at, created_at)
     SELECT gen_random_uuid(), s.tenant_id, s.store_id, s.id, 'sale_post', s.id,
            'pos-565', s.external_id, repeat('a', 64), $6,
            CASE WHEN $6 = 'posted' THEN 'SINV-' || s.external_id END,
            CASE $7 WHEN 'recent' THEN now() - random() * interval '7 days'
                    WHEN 'old' THEN now() - interval '90 days' - random() * interval '1 day' END,
            now() - random() * interval '60 days'
       FROM s`,
    [tenantId, store, tag, ACTOR, n, status, posted],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-565 posting-freshness.explain] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  const admin = env.admin;
  await admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'RT-565 busy', 'rt565-busy'), ($2, 'RT-565 other', 'rt565-other')`,
    [TENANT, TENANT_OTHER],
  );
  const stores = [...BUSY, QUIET, LEGACY_ONLY, EMPTY];
  for (const [i, id] of stores.entries()) {
    await admin.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, $3)`, [
      id,
      TENANT,
      `rt565-${i}`,
    ]);
  }
  await admin.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'rt565-o', 'rt565-o')`, [
    OTHER,
    TENANT_OTHER,
  ]);
  for (const [i, s] of BUSY.entries()) {
    await seed(TENANT, s, `b${i}-p`, POSTED_PER_BUSY_STORE, "posted", "recent");
    await seed(TENANT, s, `b${i}-q`, PENDING_PER_BUSY_STORE, "pending", "null");
    await seed(TENANT, s, `b${i}-l`, LEGACY_PER_BUSY_STORE, "posted", "null");
    await seed(TENANT, s, `b${i}-d`, 20, "permanently_rejected", "null");
  }
  await seed(TENANT, QUIET, "quiet-p", 3, "posted", "old");
  await seed(TENANT, QUIET, "quiet-q", 1, "pending", "null");
  await seed(TENANT, LEGACY_ONLY, "legacy-l", 5, "posted", "null");
  await seed(TENANT_OTHER, OTHER, "other-p", 30_000, "posted", "recent");
  await seed(TENANT_OTHER, OTHER, "other-q", 1000, "pending", "null");
  await admin.query("ANALYZE erpnext_posting_status");
  if (OUT) writeFileSync(OUT, `RT-565 D7 EXPLAIN (ANALYZE, BUFFERS) evidence\n`);
}, 600_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => dockerSkipped;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function walk(node: PlanNode, into: PlanNode[] = []): PlanNode[] {
  into.push(node);
  for (const child of node.Plans ?? []) walk(child, into);
  return into;
}

/** EXPLAIN ANALYZE the exact runtime statement under tenant RLS (default planner settings). */
async function explain(stores: readonly string[] | null, label: string): Promise<PlanNode[]> {
  const sql = stores === null ? TENANT_FRESHNESS_SQL : STORES_FRESHNESS_SQL;
  const params = stores === null ? [] : [stores];
  return runWithTenantContext(env!.app, { tenantId: TENANT, isPlatformAdmin: false }, async (client) => {
    const json = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      params,
    );
    if (OUT) {
      const text = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
      appendFileSync(
        OUT,
        `\n=== ${label} ===\n${text.rows.map((r) => r["QUERY PLAN"]).join("\n")}\n`,
      );
    }
    return walk(json.rows[0]!["QUERY PLAN"][0]!.Plan);
  });
}

function expectIndexOnly(nodes: PlanNode[], indexes: readonly string[]): void {
  const seq = nodes.filter((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "erpnext_posting_status");
  expect(seq).toEqual([]);
  const used = new Set(nodes.map((n) => n["Index Name"]).filter((n): n is string => !!n));
  for (const index of indexes) expect(used).toContain(index);
}

async function facts(stores: readonly string[] | null) {
  return runWithTenantContext(env!.app, { tenantId: TENANT, isPlatformAdmin: false }, (client) =>
    readPostingFreshness(client, stores),
  );
}

describe("RT-565 D7 — every scope is served by the freshness indexes (no Seq Scan)", () => {
  it("tenant-wide", async () => {
    if (skip()) return;
    expectIndexOnly(await explain(null, "tenant-wide (owner/tenant_admin, all stores)"), [
      IDX.postedTenant,
      IDX.pendingTenant,
      IDX.legacy,
    ]);
    const f = (await facts(null)).postingFreshness;
    expect(f.lastPosted.state).toBe("known");
    expect(f.pendingCount).toBe(BUSY_STORES * PENDING_PER_BUSY_STORE + 1);
  });

  it("one busy store (store_id filter)", async () => {
    if (skip()) return;
    expectIndexOnly(await explain([BUSY[0]!], "one busy store (store_id filter)"), [
      IDX.postedStore,
      IDX.pendingStore,
      IDX.legacy,
    ]);
    expect((await facts([BUSY[0]!])).postingFreshness.pendingCount).toBe(PENDING_PER_BUSY_STORE);
  });

  it("a quiet store inside a busy tenant", async () => {
    if (skip()) return;
    expectIndexOnly(await explain([QUIET], "quiet store in a busy tenant (store_id filter)"), [
      IDX.postedStore,
      IDX.pendingStore,
      IDX.legacy,
    ]);
    const f = (await facts([QUIET])).postingFreshness;
    expect(f.lastPosted.state).toBe("known");
    expect(Date.now() - Date.parse(f.lastPosted.at!)).toBeGreaterThan(89 * 86_400_000);
    expect(f.pendingCount).toBe(1);
  });

  it("a multi-store membership scope (RT-192), including the quiet store", async () => {
    if (skip()) return;
    const scope = [...BUSY.slice(0, 5), QUIET];
    expectIndexOnly(await explain(scope, "multi-store membership scope (5 busy + quiet)"), [
      IDX.postedStore,
      IDX.pendingStore,
      IDX.legacy,
    ]);
    expect((await facts(scope)).postingFreshness.pendingCount).toBe(5 * PENDING_PER_BUSY_STORE + 1);
  });

  it("an unknown scope (only pre-0042 posted rows) uses the legacy probe", async () => {
    if (skip()) return;
    expectIndexOnly(await explain([LEGACY_ONLY], "unknown scope (legacy-only store)"), [
      IDX.postedStore,
      IDX.legacy,
    ]);
    expect((await facts([LEGACY_ONLY])).postingFreshness.lastPosted).toEqual({ state: "unknown", at: null });
  });

  it("a none scope (no posting rows)", async () => {
    if (skip()) return;
    expectIndexOnly(await explain([EMPTY], "none scope (empty store)"), [IDX.postedStore, IDX.legacy]);
    expect((await facts([EMPTY])).postingFreshness).toEqual({
      lastPosted: { state: "none", at: null },
      pendingCount: 0,
      oldestPendingAt: null,
      oldestPendingAgeSeconds: null,
    });
  });
});
