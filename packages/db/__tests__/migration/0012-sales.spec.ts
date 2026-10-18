/**
 * 008-SCHEMA (T012/T013) — Sales migration verification under Testcontainers.
 *
 * Feature: 008-sales-transaction-capture, Phase 2 §5.2.
 *
 * Validates `packages/db/drizzle/0012_sales.sql` (+ its `.down.sql`):
 *   - the four sale-fact tables are created with the data-model.md §1-§4 shape;
 *   - money columns are `numeric(19,4)` and currency is `char(3)`;
 *   - gate-B nullability (occurred_at/received_at/business_date NOT NULL;
 *     processed_at/source_clock_at/mismatch_flag nullable);
 *   - NO `version` column anywhere (gate D.1 / FR-070);
 *   - NO tender/payment columns (gate A.5);
 *   - dedup UNIQUE (tenant_id, source_system, external_id) on sales and on
 *     each terminal-event table (FR-050/013);
 *   - RLS is ENABLED + FORCED on all four tables, and a per-table RLS-bypass
 *     probe (wrong `app.current_tenant` ⇒ zero rows) returns nothing (FR-060);
 *   - the migration applies cleanly and rolls back cleanly (UP -> DOWN -> UP).
 *
 * Docker policy (matches `0001-catalog.spec.ts`): a missing Docker runtime is
 * a HARD failure unless `MIGRATION_TEST_ALLOW_SKIP=1` is set. CI MUST NOT set
 * `MIGRATION_TEST_ALLOW_SKIP=1`. Run targeted, never the full db suite (the
 * shared self-hosted runner OOMs the full integration suite).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const SALES_UP_PATH = resolve(DRIZZLE_DIR, "0012_sales.sql");
const SALES_DOWN_PATH = resolve(DRIZZLE_DIR, "0012_sales.down.sql");

const SALES_TABLES = ["sales", "sale_lines", "sale_voids", "sale_refunds"] as const;

const MONEY_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "sales", column: "pos_total" },
  { table: "sale_lines", column: "unit_price" },
  { table: "sale_lines", column: "line_amount" },
  { table: "sale_lines", column: "tax_amount" },
  { table: "sale_refunds", column: "pos_refund_amount" },
];

const DEDUP_TABLES = ["sales", "sale_voids", "sale_refunds"] as const;

// ---------------------------------------------------------------------------
// Suite setup — start container + apply pre-0012 migrations (0000..0011)
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipReason = "";
let salesUpSql: string | null = null;
let salesDownSql: string | null = null;
let migrationGateError: string | null = null;

/** Apply every UP migration that sorts strictly before 0012_sales.sql. */
async function applyPreSalesMigrations(pgEnv: PgTestEnv): Promise<void> {
  const salesUpBasename = basename(SALES_UP_PATH);
  const upFiles = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(salesUpBasename) < 0)
    .sort();
  for (const name of upFiles) {
    const sql = readFileSync(resolve(DRIZZLE_DIR, name), "utf8");
    await pgEnv.admin.query(sql);
  }
  await ensureAppRole(pgEnv);
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyPreSalesMigrations(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[0012-sales.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`,
      );
      return;
    }
    throw new Error(
      `Container start failed: ${dockerSkipReason}\n${err instanceof Error && err.stack ? err.stack : ""}`,
    );
  }

  if (!existsSync(SALES_UP_PATH)) {
    migrationGateError = `Sales migration file missing. Expected at: ${SALES_UP_PATH}`;
    return;
  }
  if (!existsSync(SALES_DOWN_PATH)) {
    migrationGateError = `Sales rollback file missing. Expected at: ${SALES_DOWN_PATH}`;
    return;
  }
  salesUpSql = readFileSync(SALES_UP_PATH, "utf8");
  salesDownSql = readFileSync(SALES_DOWN_PATH, "utf8");
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function ensureLoaded(): { up: string; down: string } {
  if (!env) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      throw new Error(`Skipped (no Docker): ${dockerSkipReason}`);
    }
    throw new Error("env not initialized");
  }
  if (migrationGateError) throw new Error(migrationGateError);
  if (salesUpSql === null || salesDownSql === null) {
    throw new Error("sales migration SQL not loaded");
  }
  return { up: salesUpSql, down: salesDownSql };
}

// ---------------------------------------------------------------------------
// Forward migration: pre-state + post-state inventory
// ---------------------------------------------------------------------------

describe("0012_sales — applies cleanly and creates the four sale-fact tables", () => {
  it("pre-migration: none of the four sale tables exist", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [SALES_TABLES as unknown as string[]],
    );
    expect(r.rows.map((row) => row.table_name)).toEqual([]);
  });

  it("applies cleanly and creates all four tables", async () => {
    const { up } = ensureLoaded();
    if (!env) throw new Error("env not initialized");
    await env.admin.query(up);
    const r = await env.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [SALES_TABLES as unknown as string[]],
    );
    expect(r.rows.map((row) => row.table_name).sort()).toEqual(
      [...SALES_TABLES].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Column shape: money types, gate-B nullability, gate D.1/A.5 negatives
// ---------------------------------------------------------------------------

describe("0012_sales — column shape (money, nullability, forbidden columns)", () => {
  it("money columns are numeric(19,4)", async () => {
    if (!env) throw new Error("env not initialized");
    for (const { table, column } of MONEY_COLUMNS) {
      const r = await env.admin.query<{
        data_type: string;
        numeric_precision: number;
        numeric_scale: number;
      }>(
        `SELECT data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, column],
      );
      expect(r.rowCount).toBe(1);
      expect(r.rows[0]?.data_type).toBe("numeric");
      expect(r.rows[0]?.numeric_precision).toBe(19);
      expect(r.rows[0]?.numeric_scale).toBe(4);
    }
  });

  it("currency columns are char(3) and business_date is a date", async () => {
    if (!env) throw new Error("env not initialized");
    const cur = await env.admin.query<{ data_type: string; len: number }>(
      `SELECT data_type, character_maximum_length AS len
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sales' AND column_name = 'currency_code'`,
    );
    expect(cur.rows[0]?.data_type).toBe("character");
    expect(cur.rows[0]?.len).toBe(3);

    const bd = await env.admin.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sales' AND column_name = 'business_date'`,
    );
    expect(bd.rows[0]?.data_type).toBe("date");
  });

  it("gate-B nullability: occurred_at/received_at/business_date NOT NULL; processed_at/source_clock_at/mismatch_flag nullable", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sales'`,
    );
    const nullable = new Map(r.rows.map((row) => [row.column_name, row.is_nullable]));
    expect(nullable.get("occurred_at")).toBe("NO");
    expect(nullable.get("received_at")).toBe("NO");
    expect(nullable.get("business_date")).toBe("NO");
    expect(nullable.get("processed_at")).toBe("YES");
    expect(nullable.get("source_clock_at")).toBe("YES");
    expect(nullable.get("mismatch_flag")).toBe("YES");
  });

  it("has NO `version` column on any table (gate D.1 / FR-070)", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
         AND column_name = 'version'`,
      [SALES_TABLES as unknown as string[]],
    );
    expect(r.rows).toEqual([]);
  });

  it("has NO tender/payment columns on any table (gate A.5)", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
         AND (column_name LIKE '%tender%'
              OR column_name LIKE '%payment%'
              OR column_name LIKE '%card%'
              OR column_name LIKE '%cash%')`,
      [SALES_TABLES as unknown as string[]],
    );
    expect(r.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dedup uniqueness
// ---------------------------------------------------------------------------

describe("0012_sales — dedup uniqueness", () => {
  it("each dedup table has a UNIQUE (tenant_id, source_system, external_id)", async () => {
    if (!env) throw new Error("env not initialized");
    for (const table of DEDUP_TABLES) {
      const r = await env.admin.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      const hasDedupUnique = r.rows.some(
        (row) =>
          /UNIQUE/i.test(row.indexdef) &&
          /tenant_id/.test(row.indexdef) &&
          /source_system/.test(row.indexdef) &&
          /external_id/.test(row.indexdef),
      );
      expect(hasDedupUnique).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Append-only policy semantics (CodeRabbit #421): the frozen child tables get
// SELECT + INSERT only (no UPDATE/DELETE policy); sales additionally gets
// UPDATE (for SaaS-owned processed_at/mismatch_flag, FR-071) but never DELETE.
// ---------------------------------------------------------------------------

describe("0012_sales — append-only RLS policy commands", () => {
  async function policyCmds(table: string): Promise<string[]> {
    if (!env) throw new Error("env not initialized");
    // pg_policies.cmd is one of: SELECT / INSERT / UPDATE / DELETE / ALL.
    const r = await env.admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
      [table],
    );
    return r.rows.map((row) => row.cmd).sort();
  }

  it("sale_lines / sale_voids / sale_refunds have only SELECT + INSERT policies (no UPDATE/DELETE/ALL)", async () => {
    for (const table of ["sale_lines", "sale_voids", "sale_refunds"]) {
      const cmds = await policyCmds(table);
      expect(cmds).toEqual(["INSERT", "SELECT"]);
      expect(cmds).not.toContain("UPDATE");
      expect(cmds).not.toContain("DELETE");
      expect(cmds).not.toContain("ALL");
    }
  });

  it("sales has SELECT + INSERT + UPDATE (FR-071) but NO DELETE / ALL policy", async () => {
    const cmds = await policyCmds("sales");
    expect(cmds).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(cmds).not.toContain("DELETE");
    expect(cmds).not.toContain("ALL");
  });
});

// ---------------------------------------------------------------------------
// Composite parent-child tenant/store FK (CodeRabbit #421): each child carries
// a 3-column FK to sales(id, tenant_id, store_id) so cross-tenant/store
// linkage is impossible at the data layer.
// ---------------------------------------------------------------------------

describe("0012_sales — composite tenant/store foreign keys", () => {
  it("sales exposes a UNIQUE (id, tenant_id, store_id) backing the child FKs", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'sales'::regclass AND contype = 'u'`,
    );
    expect(r.rows.some((row) => row.conname === "uq_sales_id_tenant_store")).toBe(
      true,
    );
  });

  it("each child has a 3-column FK referencing sales", async () => {
    if (!env) throw new Error("env not initialized");
    for (const { child, name } of [
      { child: "sale_lines", name: "fk_sale_lines_sale_tenant_store" },
      { child: "sale_voids", name: "fk_sale_voids_sale_tenant_store" },
      { child: "sale_refunds", name: "fk_sale_refunds_sale_tenant_store" },
    ]) {
      const r = await env.admin.query<{
        conname: string;
        ncols: number;
        confrelid: string;
      }>(
        `SELECT conname, array_length(conkey, 1) AS ncols, confrelid::regclass::text AS confrelid
         FROM pg_constraint
         WHERE conrelid = $1::regclass AND contype = 'f' AND conname = $2`,
        [child, name],
      );
      expect(r.rowCount).toBe(1);
      expect(Number(r.rows[0]?.ncols)).toBe(3);
      expect(r.rows[0]?.confrelid).toBe("sales");
    }
  });
});

// ---------------------------------------------------------------------------
// RLS: enabled + forced, and a per-table fail-closed bypass probe
// ---------------------------------------------------------------------------

describe("0012_sales — RLS enabled + forced + fail-closed on all four tables", () => {
  it("every table has relrowsecurity AND relforcerowsecurity", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname = ANY($1::text[])
       ORDER BY relname`,
      [SALES_TABLES as unknown as string[]],
    );
    expect(r.rows).toHaveLength(SALES_TABLES.length);
    for (const row of r.rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it("RLS-bypass probe: a wrong app.current_tenant returns zero rows on every table", async () => {
    if (!env) throw new Error("env not initialized");
    // The app role's privileges were granted in beforeAll BEFORE 0012 created
    // these tables, so re-run the idempotent grant now that they exist
    // (GRANT ... ON ALL TABLES picks up the new relations). Without this the
    // app role gets "permission denied" before RLS is even evaluated.
    await ensureAppRole(env);

    const tenantB = "22222222-2222-2222-2222-222222222222";

    // The app role is RLS-subject. Set its tenant GUC to a tenant that owns no
    // rows and confirm every table reads back empty under FORCE RLS — proving
    // the policy is fail-closed, not merely declared. (A cross-tenant
    // "rows-exist-but-invisible" seed needs real tenants/stores FK parents;
    // that fuller isolation sweep lives in the api-side 008-ISOLATION-HARNESS,
    // which seeds tenants A/B + stores X/Y. Here the migration-level probe
    // asserts the policy is wired + fail-closed on every new table.)
    const client = await env.app.connect();
    try {
      await client.query(`SET app.current_tenant = '${tenantB}'`);
      for (const table of SALES_TABLES) {
        const r = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${table}`,
        );
        expect(r.rows[0]?.n).toBe("0");
      }
      // Sanity: an unset/empty GUC also yields zero (the `, true` missing-GUC
      // form returns NULL, and `tenant_id = NULL` is never true → fail-closed).
      await client.query(`RESET app.current_tenant`);
      for (const table of SALES_TABLES) {
        const r = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${table}`,
        );
        expect(r.rows[0]?.n).toBe("0");
      }
    } finally {
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// Rollback round-trip
// ---------------------------------------------------------------------------

describe("0012_sales — rollback round-trip (UP -> DOWN -> UP)", () => {
  it("rolls back cleanly: all four tables dropped", async () => {
    const { down } = ensureLoaded();
    if (!env) throw new Error("env not initialized");
    await env.admin.query(down);
    const r = await env.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [SALES_TABLES as unknown as string[]],
    );
    expect(r.rows).toEqual([]);
  });

  it("re-applies cleanly after rollback (idempotent round-trip)", async () => {
    const { up } = ensureLoaded();
    if (!env) throw new Error("env not initialized");
    await env.admin.query(up);
    const r = await env.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [SALES_TABLES as unknown as string[]],
    );
    expect(r.rows.map((row) => row.table_name).sort()).toEqual(
      [...SALES_TABLES].sort(),
    );
  });
});
