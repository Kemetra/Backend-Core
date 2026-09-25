/**
 * T065 — Migration runner CLI spec.
 *
 * Spawns `node packages/db/dist/cli/migrate.js` as a real child process so
 * we test the script's actual exit codes, argv parsing, and effects on the
 * live database — not module-level stubs.
 *
 * Boots its own postgres:16-alpine container (separate from migration.spec.ts
 * because the CLI test must control ledger state precisely).
 */
import { spawn, type SpawnOptions } from "node:child_process";
import { resolve } from "node:path";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const CLI_PATH = resolve(__dirname, "..", "..", "dist", "cli", "migrate.js");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<CliResult> {
  return new Promise((resolveResult, rejectResult) => {
    const opts: SpawnOptions = {
      env: { ...process.env, ...envOverrides },
      stdio: ["ignore", "pipe", "pipe"],
    };
    const child = spawn(process.execPath, [CLI_PATH, ...args], opts);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", rejectResult);
    child.on("close", (code) =>
      resolveResult({ code: code ?? -1, stdout, stderr }),
    );
  });
}

let env: PgTestEnv | null = null;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[cli/migrate.spec] Docker NOT AVAILABLE — skipping. Reason: ${message}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${message}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

// --- schema-introspection helpers (shared by the up/down assertions) --------

async function queryCount(sql: string, params: unknown[] = []): Promise<string> {
  if (!env) throw new Error("env not initialized");
  const r = await env.admin.query<{ count: string }>(sql, params);
  return r.rows[0]?.count ?? "";
}

/** How many of the named public-schema tables currently exist. */
function countPublicTables(names: string[]): Promise<string> {
  return queryCount(
    `SELECT COUNT(*)::text AS count FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [names],
  );
}

/** "1" when the named column exists on the public-schema table, else "0". */
function countPublicColumn(table: string, column: string): Promise<string> {
  return queryCount(
    `SELECT COUNT(*)::text AS count FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
}

/** How many RLS policies exist on the named public-schema tables. */
function countPolicies(names: string[]): Promise<string> {
  return queryCount(
    `SELECT COUNT(*)::text AS count FROM pg_policies
     WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
    [names],
  );
}

/** The applied-migration ids from the ledger, lex-ascending. */
async function ledgerIds(): Promise<string[]> {
  if (!env) throw new Error("env not initialized");
  const r = await env.admin.query<{ id: string }>(
    "SELECT id FROM _drizzle_migrations ORDER BY id ASC",
  );
  return r.rows.map((row) => row.id);
}

describe("data-pulse-migrate CLI", () => {
  // --- argv / env validation paths (do not need a fresh DB) ----------------

  it("exits 3 when no subcommand is given", async () => {
    const r = await runCli([], { DATABASE_URL: env!.adminUri });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/usage: data-pulse-migrate/);
  });

  it("exits 3 on an unknown subcommand", async () => {
    const r = await runCli(["bogus"], { DATABASE_URL: env!.adminUri });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/unknown subcommand/);
  });

  it("exits 2 when DATABASE_URL is missing", async () => {
    // Build an env that explicitly removes DATABASE_URL.
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k !== "DATABASE_URL" && typeof v === "string") cleanEnv[k] = v;
    }
    const r = await new Promise<CliResult>((resolveResult) => {
      const child = spawn(process.execPath, [CLI_PATH, "up"], {
        env: cleanEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
      child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
      child.on("close", (code) =>
        resolveResult({ code: code ?? -1, stdout, stderr }),
      );
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/DATABASE_URL/);
  });

  // --- Live up / down / status (state shared with the rest of this block) -

  /**
   * Expected migration ledger. Update this list as new migrations land —
   * the rest of the suite derives every other assertion from it.
   *
   * Order matches lex-sorted filenames in `packages/db/drizzle/`, which is
   * the order the runner applies (and the inverse order it rolls back).
   */
  const EXPECTED_MIGRATIONS = [
    "0000_initial",
    "0001_pos_operator_identity",
    "0002_shifts",
    "0003_session_active_store_tenant_invariant",
    "0004_audit_retention_marker",
    "0005_audit_retention_privileges",
    "0006_outbox_events",
    "0007_catalog",
    "0008_catalog_store_read_isolation",
    "0009_catalog_store_empty_guc_fix",
    "0010_catalog_tenant_empty_guc_fix",
    "0011_catalog_store_carveout_sentinel",
    "0012_sales",
    "0013_store_timezone",
    "0014_inventory",
    "0015_pos_catalog_read_down",
    "0016_inventory_unit_guard",
    "0017_erpnext_item_map",
    "0018_erpnext_warehouse_map",
    "0019_erpnext_posting_status",
    "0020_erpnext_reconciliation",
    "0021_connector_registration",
    "0022_connector_health",
    "0023_erpnext_product_reconciliation",
    "0024_pairing_codes",
    "0025_external_identity_links",
    "0026_sale_sync_status",
    "0027_settlement_receivables",
    "0028_outbox_claim_recovery",
    "0029_session_credential_hash",
  ] as const;

  const LATEST_MIGRATION = EXPECTED_MIGRATIONS[EXPECTED_MIGRATIONS.length - 1]!;
  const SECOND_LATEST_MIGRATION = EXPECTED_MIGRATIONS[EXPECTED_MIGRATIONS.length - 2]!;

  /** The seven tables created by 0027_settlement_receivables. */
  const SETTLEMENT_TABLES = [
    "payer_account",
    "receivable",
    "payment_application",
    "claim",
    "claim_receivables",
    "remittance",
    "reconciliation_result",
  ];

  /** The seven catalog tables introduced by 0007_catalog. */
  const CATALOG_TABLES = [
    "global_products",
    "tenant_products",
    "tenant_product_categories",
    "store_product_overrides",
    "product_aliases",
    "price_history",
    "unknown_items",
  ];

  it("up applies all pending migrations and writes the ledger", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await runCli(["up"], { DATABASE_URL: env.adminUri });
    expect(r.code).toBe(0);
    for (const id of EXPECTED_MIGRATIONS) {
      expect(r.stdout).toMatch(new RegExp(`up: applying ${id}`));
      expect(r.stdout).toMatch(new RegExp(`up: applied ${id}`));
    }

    expect(await ledgerIds()).toEqual([...EXPECTED_MIGRATIONS]);
    expect(await countPublicTables(["tenants", "devices", "shifts"])).toBe("3");

    // 0026_sale_sync_status artifacts are present after up (CodeRabbit #6):
    // (a) the sales.sync_status column, (b) the idx_sales_needs_repair partial
    // index, (c) the sale_sync_deadletters table, (d) its three RLS policies
    // (tenant_select + tenant_insert + tenant_update; no DELETE — resolved
    // rows are retained for audit).
    expect(await countPublicColumn("sales", "sync_status")).toBe("1");
    expect(
      await queryCount(`
        SELECT COUNT(*)::text AS count FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_sales_needs_repair'
      `),
    ).toBe("1");
    expect(await countPublicTables(["sale_sync_deadletters"])).toBe("1");
    expect(await countPolicies(["sale_sync_deadletters"])).toBe("3");
    expect(await countPublicColumn("outbox_events", "claimed_at")).toBe("1");
    expect(
      await queryCount(`SELECT COUNT(*)::text AS count FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'outbox_events_stale_claim_idx'`),
    ).toBe("1");
  });

  it("up is idempotent on a second run", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await runCli(["up"], { DATABASE_URL: env.adminUri });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no pending migrations/);
    expect((await ledgerIds()).length).toBe(EXPECTED_MIGRATIONS.length);
  });

  it(`status reports applied=${EXPECTED_MIGRATIONS.length}, pending=0`, async () => {
    if (!env) throw new Error("env not initialized");
    const r = await runCli(["status"], { DATABASE_URL: env.adminUri });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      new RegExp(`status: ${EXPECTED_MIGRATIONS.length} applied, 0 pending`),
    );
    for (const id of EXPECTED_MIGRATIONS) {
      expect(r.stdout).toMatch(new RegExp(`applied  ${id}`));
    }
  });

  it(
    "down rolls back the most recent migration only and updates the ledger",
    async () => {
      if (!env) throw new Error("env not initialized");
      // Runner.down rolls back exactly one migration per call (the most
      // recent applied). With the full chain applied, the first down rolls
      // back LATEST_MIGRATION, leaving the rest in the ledger.
      const r = await runCli(["down"], { DATABASE_URL: env.adminUri });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`down: rolled back ${LATEST_MIGRATION}`));

      expect(await ledgerIds()).toEqual(EXPECTED_MIGRATIONS.slice(0, -1));

      // 0028 removes its lease column and index while retaining 0027 tables.
      expect(await countPublicColumn("outbox_events", "claimed_at")).toBe("0");
      expect(
        await queryCount(`SELECT COUNT(*)::text AS count FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'outbox_events_stale_claim_idx'`),
      ).toBe("0");
      expect(await countPublicTables(SETTLEMENT_TABLES)).toBe("7");

      // Sanity: everything older SURVIVES the 0028 rollback (down reverses
      // only the latest migration) —
      // 0026's sync_status column + sale_sync_deadletters table;
      expect(await countPublicColumn("sales", "sync_status")).toBe("1");
      expect(await countPublicTables(["sale_sync_deadletters"])).toBe("1");
      // the `sales` table itself;
      expect(await countPublicTables(["sales"])).toBe("1");
      // all seven catalog tables introduced by 0007;
      expect(await countPublicTables(CATALOG_TABLES)).toBe("7");
      // outbox_events from 0006;
      expect(await countPublicTables(["outbox_events"])).toBe("1");
      // 0004's retention_marked_at column;
      expect(await countPublicColumn("audit_events", "retention_marked_at")).toBe("1");
      // the 0003 trigger and the foundation tables.
      expect(
        await queryCount(`
          SELECT COUNT(*)::text AS count FROM pg_trigger
          WHERE tgname = 'sessions_active_store_tenant_check'
        `),
      ).toBe("1");
      expect(
        await countPublicTables(["tenants", "users", "devices", "shifts"]),
      ).toBe("4");
    },
  );

  it("up after down re-applies the rolled-back migration", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await runCli(["up"], { DATABASE_URL: env.adminUri });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`up: applying ${LATEST_MIGRATION}`));
    expect(await countPublicColumn("outbox_events", "claimed_at")).toBe("1");
    // Re-applying the latest migration leaves all seven catalog tables from
    // 0007 intact; the catalog set is unaffected by the latest migration.
    expect(await countPublicTables(CATALOG_TABLES)).toBe("7");
  });

  it(
    "concurrent up calls serialize via pg_advisory_lock",
    async () => {
      if (!env) throw new Error("env not initialized");

      // Nothing to do — both should succeed quickly with "no pending"
      // because we're already at head from the previous test. We're
      // checking that the lock doesn't deadlock or error, not that it
      // does meaningful work.
      const [a, b] = await Promise.all([
        runCli(["up"], { DATABASE_URL: env.adminUri }),
        runCli(["up"], { DATABASE_URL: env.adminUri }),
      ]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
    },
  );

  it("down repeatedly fully unwinds the chain", async () => {
    if (!env) throw new Error("env not initialized");
    // The previous `up after down` test left the full chain applied. Each
    // `down` rolls back the most recent migration; we iterate from the
    // tail of EXPECTED_MIGRATIONS down to 0000_initial, then assert one
    // extra `down` reports nothing left.
    for (const id of [...EXPECTED_MIGRATIONS].reverse()) {
      const r = await runCli(["down"], { DATABASE_URL: env.adminUri });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`down: rolled back ${id}`));
    }

    const empty = await runCli(["down"], { DATABASE_URL: env.adminUri });
    expect(empty.code).toBe(0);
    expect(empty.stdout).toMatch(/down: nothing to roll back/);

    // SECOND_LATEST_MIGRATION is referenced so the symbol stays alive even if
    // a future test drops down to it explicitly; no-op assertion otherwise.
    expect(SECOND_LATEST_MIGRATION).toBeTruthy();
  });
});
