/**
 * 0064-0065 - the stock movement history indexes (Jira RT-735; [GATED]
 * approval: Jira RT-735 comments 13234 and 13280). Read by listStockMovements
 * (RT-731): a store's movements newest first in keyset order
 * (occurred_at DESC, id DESC), every movement (scope=all) or one product's.
 *
 * Applies every migration before 0064 against a real Postgres, seeds a ledger
 * of three products-worth of movements over two stores of one tenant plus a
 * second tenant, then applies 0064-0065 exactly as the runner does (one
 * `query()` per file), and proves:
 *   - each file is a single CONCURRENTLY statement with no transaction control,
 *     so the runner never wraps the build in a transaction block;
 *   - each index is valid with the RT-735 column list and order;
 *   - before the build the list queries need a Sort; after it each is served
 *     by its index with no Sort, for the first page and a keyset page, under
 *     tenant RLS, and the pages returned are identical;
 *   - down drops only its own index, keeps every movement row, and round-trips
 *     with up.
 *
 * The seeded volume here is small; the large-ledger EXPLAIN (ANALYZE, BUFFERS)
 * numbers are in the RT-735 PR. Fresh install through the real runner is
 * covered by the migrate CLI spec's EXPECTED_MIGRATIONS.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import { sqlStatements, withTenant } from "../_helpers/migration-sql";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const FIRST_NAME = "0064_stock_movements_store_occurred_idx.sql";

/** The two RT-735 migrations, their index and its expected definition. */
const MIGRATIONS = [
  {
    id: "0064_stock_movements_store_occurred_idx",
    index: "idx_stock_movements_tenant_store_occurred",
    def: "(tenant_id, store_id, occurred_at DESC, id DESC)",
  },
  {
    id: "0065_stock_movements_store_product_occurred_idx",
    index: "idx_stock_movements_tenant_store_product_occurred",
    def: "(tenant_id, store_id, tenant_product_ref, occurred_at DESC, id DESC)",
  },
] as const;

const up = (id: string): string => resolve(DRIZZLE_DIR, `${id}.sql`);
const down = (id: string): string => resolve(DRIZZLE_DIR, `${id}.down.sql`);

const TENANT = "0a000000-0000-7000-8000-000000735001";
const TENANT_2 = "0a000000-0000-7000-8000-000000735002";
const STORE_BUSY = "0a000000-0000-7000-8000-000000735003";
const STORE_QUIET = "0a000000-0000-7000-8000-000000735004";
const STORE_T2 = "0a000000-0000-7000-8000-000000735005";
const ACTOR = "0a000000-0000-7000-8000-000000735006";
const PRODUCT_A = "0a000000-0000-7000-8000-000000735007";
const PRODUCT_B = "0a000000-0000-7000-8000-000000735008";
const PRODUCT_T2 = "0a000000-0000-7000-8000-000000735009";

const PAGE = 51;

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

const read = (path: string): string => readFileSync(path, "utf8");
const skip = (): boolean => env === null;

async function applyBefore0064(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(FIRST_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(read(resolve(DRIZZLE_DIR, name)));
  }
  await ensureAppRole(pgEnv);
}

/** `n` movements for a tenant/store/product (null = ad-hoc), spread over 90 days. */
async function seedMovements(
  tenantId: string,
  storeId: string,
  productId: string | null,
  n: number,
): Promise<void> {
  await pg().admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
        tenant_product_ref, occurred_at, created_by, stock_location_id, inventory_status)
     SELECT gen_random_uuid(), $1, $2, 'inbound', 1, 'ea', $3::uuid,
            now() - (random() * interval '90 days'), $4, l.id, 'sellable'
       FROM generate_series(1, $5) g
       JOIN stock_locations l ON l.store_id = $2 AND l.kind = 'primary'`,
    [tenantId, storeId, productId, ACTOR, n],
  );
}

type Query = { readonly sql: string; readonly params: readonly unknown[] };

/** The listStockMovements read (RT-731), without the display joins, per scope. */
function listQuery(
  scope: "all" | "adhoc" | "product",
  storeId: string,
  after: { readonly at: string; readonly id: string } | null,
): Query {
  const predicate =
    scope === "product"
      ? "m.tenant_product_ref = $2::uuid"
      : scope === "adhoc"
        ? "($2::uuid IS NULL AND m.tenant_product_ref IS NULL)"
        : "($2::uuid IS NULL)";
  return {
    sql: `SELECT m.id, m.occurred_at FROM stock_movements m
           WHERE m.store_id = $1 AND ${predicate}
             AND ($3::timestamptz IS NULL OR (m.occurred_at, m.id) < ($3::timestamptz, $4::uuid))
           ORDER BY m.occurred_at DESC, m.id DESC
           LIMIT ${PAGE}`,
    params: [storeId, scope === "product" ? PRODUCT_A : null, after?.at ?? null, after?.id ?? null],
  };
}

async function planOf(q: Query): Promise<string> {
  return withTenant(pg().app, TENANT, async (c) => {
    const r = await c.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (FORMAT JSON) ${q.sql}`, [
      ...q.params,
    ]);
    return JSON.stringify(r.rows[0]?.["QUERY PLAN"]);
  });
}

async function pageOf(q: Query): Promise<string[]> {
  return withTenant(pg().app, TENANT, async (c) => {
    const r = await c.query<{ id: string }>(q.sql, [...q.params]);
    return r.rows.map((row) => row.id);
  });
}

/** The keyset position of the 20th row of the first page of a scope. */
async function keysetAfter(
  scope: "all" | "adhoc" | "product",
): Promise<{ at: string; id: string }> {
  return withTenant(pg().app, TENANT, async (c) => {
    const q = listQuery(scope, STORE_BUSY, null);
    const r = await c.query<{ id: string; at: string }>(
      `SELECT id, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
         FROM (${q.sql}) p OFFSET 19 LIMIT 1`,
      [...q.params],
    );
    return r.rows[0]!;
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

async function countMovements(): Promise<string> {
  const r = await pg().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM stock_movements`);
  return r.rows[0]!.n;
}

/**
 * The scope and the index(es) allowed to serve it. scope=adhoc is an equality on
 * the NULL product: 0065 serves it, or 0064 filtering the NULL rows; the planner
 * picks by cost, so either is correct as long as there is no Sort.
 */
const SCOPES = [
  { scope: "all", migration: MIGRATIONS[0], served: [MIGRATIONS[0].index] },
  { scope: "product", migration: MIGRATIONS[1], served: [MIGRATIONS[1].index] },
  { scope: "adhoc", migration: MIGRATIONS[1], served: [MIGRATIONS[0].index, MIGRATIONS[1].index] },
] as const;

/** Pages (first and keyset) read BEFORE the build, to compare with after. */
const pagesBefore = new Map<string, string[]>();
const plansBefore = new Map<string, string>();
const keysets = new Map<string, { at: string; id: string }>();

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0064-stock-movement-history-indexes.spec] Docker NOT AVAILABLE - skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0064(env);
  await env.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES
       ($1, 'RT-735 tenant', 'rt735-tenant'), ($2, 'RT-735 tenant 2', 'rt735-tenant-2')`,
    [TENANT, TENANT_2],
  );
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $2, 'rt735busy', 'RT-735 busy'), ($3, $2, 'rt735quiet', 'RT-735 quiet'),
       ($4, $5, 'rt735t2', 'RT-735 T2')`,
    [STORE_BUSY, TENANT, STORE_QUIET, STORE_T2, TENANT_2],
  );
  await env.admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $2, 'RT-735 A', 'standard', $5, $5), ($3, $2, 'RT-735 B', 'standard', $5, $5),
            ($4, $6, 'RT-735 T2', 'standard', $5, $5)`,
    [PRODUCT_A, TENANT, PRODUCT_B, PRODUCT_T2, ACTOR, TENANT_2],
  );
  // Rows existing BEFORE the build (the upgrade path).
  await seedMovements(TENANT, STORE_BUSY, PRODUCT_A, 20_000);
  await seedMovements(TENANT, STORE_BUSY, PRODUCT_B, 20_000);
  await seedMovements(TENANT, STORE_BUSY, null, 20_000);
  await seedMovements(TENANT, STORE_QUIET, PRODUCT_A, 5);
  await seedMovements(TENANT_2, STORE_T2, PRODUCT_T2, 20_000);
  await env.admin.query("ANALYZE stock_movements");

  for (const { scope } of SCOPES) {
    keysets.set(scope, await keysetAfter(scope));
    const first = listQuery(scope, STORE_BUSY, null);
    const deeper = listQuery(scope, STORE_BUSY, keysets.get(scope)!);
    plansBefore.set(scope, await planOf(first));
    pagesBefore.set(`${scope}:first`, await pageOf(first));
    pagesBefore.set(`${scope}:keyset`, await pageOf(deeper));
  }
  // One query() per file, exactly as the runner sends it.
  for (const m of MIGRATIONS) await env.admin.query(read(up(m.id)));
  await env.admin.query("ANALYZE stock_movements");
}, 300_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0064-0065 - single CONCURRENTLY statements", () => {
  it.each(MIGRATIONS.map((m) => [m.id]))(
    "%s up and down are one statement with no transaction control",
    (id) => {
      for (const path of [up(id), down(id)]) {
        const statements = sqlStatements(path);
        expect(statements).toHaveLength(1);
        expect(statements[0]).toMatch(/\bCONCURRENTLY\b/);
        expect(statements[0]).not.toMatch(/\b(BEGIN|COMMIT)\b/i);
      }
    },
  );
});

describe("0064-0065 - the two RT-735 indexes", () => {
  it.each(MIGRATIONS.map((m) => [m.index, m.def]))(
    "%s is valid with its RT-735 definition",
    async (index, def) => {
      if (skip()) return;
      expect(await indexState(index)).toEqual({
        valid: true,
        def: `CREATE INDEX ${index} ON public.stock_movements USING btree ${def}`,
      });
    },
  );

  it.each(SCOPES.map((s) => [s.scope, s.migration.index]))(
    "before the build the %s list needs a Sort and cannot use %s",
    (scope, index) => {
      if (skip()) return;
      const plan = plansBefore.get(scope)!;
      expect(plan).not.toContain(`"Index Name":"${index}"`);
      expect(plan).toContain(`"Node Type":"Sort"`);
    },
  );

  it.each(SCOPES.map((s) => [s.scope, s.served.join(" or ")]))(
    "after the build the %s list (first page and keyset page) is served by %s with no Sort",
    async (scope, served) => {
      if (skip()) return;
      const scopeKey = scope as "all" | "adhoc" | "product";
      for (const after of [null, keysets.get(scope)!]) {
        const plan = await planOf(listQuery(scopeKey, STORE_BUSY, after));
        expect(served.split(" or ").some((index) => plan.includes(`"Index Name":"${index}"`))).toBe(true);
        expect(plan).not.toContain(`"Node Type":"Sort"`);
      }
    },
  );

  it.each(SCOPES.map((s) => [s.scope]))(
    "the %s list returns the same pages after the build as before",
    async (scope) => {
      if (skip()) return;
      const scopeKey = scope as "all" | "adhoc" | "product";
      const first = await pageOf(listQuery(scopeKey, STORE_BUSY, null));
      const keyset = await pageOf(listQuery(scopeKey, STORE_BUSY, keysets.get(scope)!));
      expect(first).toHaveLength(PAGE);
      expect(first).toEqual(pagesBefore.get(`${scope}:first`));
      expect(keyset).toEqual(pagesBefore.get(`${scope}:keyset`));
    },
  );
});

describe("0064-0065 - down -> up round-trip", () => {
  it("each down drops only its own index, keeps every movement row, and up re-applies cleanly", async () => {
    if (skip()) return;
    const before = await countMovements();
    for (const [i, m] of [...MIGRATIONS].reverse().entries()) {
      await pg().admin.query(read(down(m.id)));
      expect(await indexState(m.index)).toBeNull();
      for (const earlier of MIGRATIONS.slice(0, MIGRATIONS.length - 1 - i)) {
        expect((await indexState(earlier.index))?.valid).toBe(true);
      }
    }
    // The 0014 on-hand index is untouched by either down.
    expect(await indexState("idx_stock_movements_tenant_store_product")).not.toBeNull();
    expect(await countMovements()).toBe(before);
    for (const m of MIGRATIONS) await pg().admin.query(read(up(m.id)));
    for (const m of MIGRATIONS) expect((await indexState(m.index))?.valid).toBe(true);
  });
});
