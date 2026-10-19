/**
 * 0057-0061 — the posting-freshness indexes (Jira RT-565 D7; [GATED] approval:
 * Jira RT-565 comment 12969). Read by consoleGetSyncOpsSummary's
 * postingFreshness (console-sync-ops.yaml 1.2.0-draft).
 *
 * Applies every migration before 0057 against a real Postgres, seeds posting
 * rows of every state over two stores of one tenant plus a second tenant, then
 * applies 0057-0061 exactly as the runner does (one `query()` per file), and
 * proves:
 *   - each file is a single CONCURRENTLY statement with no transaction control,
 *     so the runner never wraps the build in a transaction block;
 *   - each index is valid with the D7 column list and partial predicate;
 *   - under tenant RLS, each freshness probe (tenant-wide and per store) is
 *     served by its index;
 *   - down drops only its own index, keeps every posting row, and round-trips
 *     with up.
 *
 * The runtime query plans (the exact read SQL, every scope, seeded volume) are
 * proved in apps/api (posting-freshness.explain.spec.ts). Fresh install through
 * the real runner is covered by the migrate CLI spec's EXPECTED_MIGRATIONS.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import {
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const FIRST_NAME = "0057_posting_status_posted_at_tenant_idx.sql";

/** The five D7 migrations, their index and its expected definition. */
const MIGRATIONS = [
  {
    id: "0057_posting_status_posted_at_tenant_idx",
    index: "idx_erpnext_posting_status_posted_at_tenant",
    def: "(tenant_id, posted_at DESC) WHERE (posted_at IS NOT NULL)",
  },
  {
    id: "0058_posting_status_posted_at_store_idx",
    index: "idx_erpnext_posting_status_posted_at_store",
    def: "(tenant_id, store_id, posted_at DESC) WHERE (posted_at IS NOT NULL)",
  },
  {
    id: "0059_posting_status_pending_created_tenant_idx",
    index: "idx_erpnext_posting_status_pending_created_tenant",
    def: "(tenant_id, created_at) WHERE (status = 'pending'::text)",
  },
  {
    id: "0060_posting_status_pending_created_store_idx",
    index: "idx_erpnext_posting_status_pending_created_store",
    def: "(tenant_id, store_id, created_at) WHERE (status = 'pending'::text)",
  },
  {
    id: "0061_posting_status_legacy_posted_idx",
    index: "idx_erpnext_posting_status_legacy_posted",
    def: "(tenant_id, store_id) WHERE ((status = 'posted'::text) AND (posted_at IS NULL))",
  },
] as const;

const up = (id: string): string => resolve(DRIZZLE_DIR, `${id}.sql`);
const down = (id: string): string => resolve(DRIZZLE_DIR, `${id}.down.sql`);

const TENANT = "0a000000-0000-7000-8000-000000057001";
const TENANT_2 = "0a000000-0000-7000-8000-000000057002";
const STORE_BUSY = "0a000000-0000-7000-8000-000000057003";
const STORE_QUIET = "0a000000-0000-7000-8000-000000057004";
const STORE_T2 = "0a000000-0000-7000-8000-000000057005";
const ACTOR = "0a000000-0000-7000-8000-000000057006";

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

const read = (path: string): string => readFileSync(path, "utf8");
const skip = (): boolean => env === null;

async function applyBefore0057(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(FIRST_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(read(resolve(DRIZZLE_DIR, name)));
  }
  await ensureAppRole(pgEnv);
}

/**
 * Seed `n` sales and one posting intent each for a tenant/store, with the
 * given status and posted_at mode ('now' = post-0042 posted, 'null' = none).
 */
async function seedPostings(
  tenantId: string,
  storeId: string,
  prefix: string,
  n: number,
  status: "pending" | "posted" | "permanently_rejected",
  postedAt: "now" | "null",
): Promise<void> {
  await pg().admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     SELECT gen_random_uuid(), $1, $2, 'EGP', 10, now(), current_date,
            'pos-0057', $3 || '-' || g, repeat('c', 64), $4
       FROM generate_series(1, $5) g`,
    [tenantId, storeId, prefix, ACTOR, n],
  );
  await pg().admin.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system,
        external_id, payload_hash, status, document_ref, posted_at, created_at)
     SELECT gen_random_uuid(), s.tenant_id, s.store_id, s.id, 'sale_post', s.id,
            'pos-0057', s.external_id, repeat('a', 64), $4,
            CASE WHEN $4 = 'posted' THEN 'SINV-' || s.external_id END,
            CASE WHEN $5 = 'now' THEN now() - (random() * interval '30 days') END,
            now() - (random() * interval '30 days')
       FROM sales s
      WHERE s.tenant_id = $1 AND s.store_id = $2 AND s.external_id LIKE $3 || '-%'`,
    [tenantId, storeId, prefix, status, postedAt],
  );
}

async function asTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pg().app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function planOf(sql: string, params: unknown[] = []): Promise<string> {
  return asTenant(TENANT, async (c) => {
    await c.query("SET LOCAL enable_seqscan = off");
    const r = await c.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    return JSON.stringify(r.rows[0]?.["QUERY PLAN"]);
  });
}

async function indexState(name: string): Promise<{ valid: boolean; def: string } | null> {
  const r = await pg().admin.query<{ valid: boolean; def: string }>(
    `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1`,
    [name],
  );
  return r.rows[0] ?? null;
}

async function countPostings(): Promise<string> {
  const r = await pg().admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM erpnext_posting_status`,
  );
  return r.rows[0]!.n;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0057-posting-freshness-indexes.spec] Docker NOT AVAILABLE - skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0057(env);
  await env.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES
       ($1, 'RT-565 tenant', 'rt565-tenant'), ($2, 'RT-565 tenant 2', 'rt565-tenant-2')`,
    [TENANT, TENANT_2],
  );
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $2, 'rt565busy', 'RT-565 busy'), ($3, $2, 'rt565quiet', 'RT-565 quiet'),
       ($4, $5, 'rt565t2', 'RT-565 T2')`,
    [STORE_BUSY, TENANT, STORE_QUIET, STORE_T2, TENANT_2],
  );
  // Rows existing BEFORE the build (the upgrade path): a busy store with every
  // state, a quiet store with a few, and another tenant.
  await seedPostings(TENANT, STORE_BUSY, "busy-posted", 2000, "posted", "now");
  await seedPostings(TENANT, STORE_BUSY, "busy-legacy", 20, "posted", "null");
  await seedPostings(TENANT, STORE_BUSY, "busy-pending", 300, "pending", "null");
  await seedPostings(TENANT, STORE_BUSY, "busy-dead", 50, "permanently_rejected", "null");
  await seedPostings(TENANT, STORE_QUIET, "quiet-posted", 3, "posted", "now");
  await seedPostings(TENANT, STORE_QUIET, "quiet-pending", 2, "pending", "null");
  await seedPostings(TENANT_2, STORE_T2, "t2-posted", 500, "posted", "now");
  // One query() per file, exactly as the runner sends it.
  for (const m of MIGRATIONS) await env.admin.query(read(up(m.id)));
  await env.admin.query("ANALYZE erpnext_posting_status");
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0057-0061 — single CONCURRENTLY statements", () => {
  it.each(MIGRATIONS.map((m) => [m.id]))(
    "%s up and down are one statement with no transaction control",
    (id) => {
      for (const path of [up(id), down(id)]) {
        const statements = read(path)
          .replace(/--[^\n]*/g, "")
          .split(";")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        expect(statements).toHaveLength(1);
        expect(statements[0]).toMatch(/\bCONCURRENTLY\b/);
        expect(statements[0]).not.toMatch(/\b(BEGIN|COMMIT)\b/i);
      }
    },
  );
});

describe("0057-0061 — the five D7 indexes", () => {
  it.each(MIGRATIONS.map((m) => [m.index, m.def]))(
    "%s is valid with its D7 definition",
    async (index, def) => {
      if (skip()) return;
      expect(await indexState(index)).toEqual({
        valid: true,
        def: `CREATE INDEX ${index} ON public.erpnext_posting_status USING btree ${def}`,
      });
    },
  );

  it("serves the tenant-wide last posting from 0057", async () => {
    if (skip()) return;
    const plan = await planOf(
      `SELECT posted_at FROM erpnext_posting_status
        WHERE posted_at IS NOT NULL ORDER BY posted_at DESC LIMIT 1`,
    );
    expect(plan).toContain(`"Index Name":"${MIGRATIONS[0].index}"`);
    expect(plan).not.toContain(`"Node Type":"Sort"`);
  });

  it("serves one store's last posting from 0058", async () => {
    if (skip()) return;
    const plan = await planOf(
      `SELECT posted_at FROM erpnext_posting_status
        WHERE store_id = $1 AND posted_at IS NOT NULL ORDER BY posted_at DESC LIMIT 1`,
      [STORE_QUIET],
    );
    expect(plan).toContain(`"Index Name":"${MIGRATIONS[1].index}"`);
    expect(plan).not.toContain(`"Node Type":"Sort"`);
  });

  it("serves the tenant-wide oldest pending from 0059", async () => {
    if (skip()) return;
    const plan = await planOf(
      `SELECT created_at FROM erpnext_posting_status
        WHERE status = 'pending' ORDER BY created_at LIMIT 1`,
    );
    expect(plan).toContain(`"Index Name":"${MIGRATIONS[2].index}"`);
    expect(plan).not.toContain(`"Node Type":"Sort"`);
  });

  it("serves one store's oldest pending from 0060", async () => {
    if (skip()) return;
    const plan = await planOf(
      `SELECT created_at FROM erpnext_posting_status
        WHERE store_id = $1 AND status = 'pending' ORDER BY created_at LIMIT 1`,
      [STORE_QUIET],
    );
    expect(plan).toContain(`"Index Name":"${MIGRATIONS[3].index}"`);
    expect(plan).not.toContain(`"Node Type":"Sort"`);
  });

  it("serves the unknown-vs-none probe from 0061, tenant-wide and per store", async () => {
    if (skip()) return;
    for (const [sql, params] of [
      [`SELECT 1 FROM erpnext_posting_status WHERE status = 'posted' AND posted_at IS NULL LIMIT 1`, []],
      [
        `SELECT 1 FROM erpnext_posting_status
          WHERE status = 'posted' AND posted_at IS NULL AND store_id = $1 LIMIT 1`,
        [STORE_QUIET],
      ],
    ] as const) {
      const plan = await planOf(sql, [...params]);
      expect(plan).toContain(`"Index Name":"${MIGRATIONS[4].index}"`);
    }
  });
});

describe("0057-0061 — down -> up round-trip", () => {
  it("each down drops only its own index, keeps every posting row, and up re-applies cleanly", async () => {
    if (skip()) return;
    const before = await countPostings();
    for (const [i, m] of [...MIGRATIONS].reverse().entries()) {
      await pg().admin.query(read(down(m.id)));
      expect(await indexState(m.index)).toBeNull();
      // The earlier indexes survive this down.
      for (const earlier of MIGRATIONS.slice(0, MIGRATIONS.length - 1 - i)) {
        expect((await indexState(earlier.index))?.valid).toBe(true);
      }
    }
    expect(await indexState("idx_erpnext_posting_status_pending")).not.toBeNull();
    expect(await countPostings()).toBe(before);
    for (const m of MIGRATIONS) await pg().admin.query(read(up(m.id)));
    for (const m of MIGRATIONS) expect((await indexState(m.index))?.valid).toBe(true);
  });
});
