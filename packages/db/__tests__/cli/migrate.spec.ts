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
import type { ProbeDb } from "./migration-probes";
import { probeMismatches, resolveMigrationRegistry } from "./migration-registry";

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

/** How many of 0034's audit_events append-only triggers exist (RT-133). */
function countAppendOnlyTriggers(): Promise<string> {
  return queryCount(
    `SELECT COUNT(*)::text AS count FROM pg_trigger
     WHERE tgname IN ('audit_events_append_only_row', 'audit_events_append_only_truncate')`,
  );
}

/** How many of 0036's shifts cash-up guard triggers exist (RT-17). */
function countShiftGuardTriggers(): Promise<string> {
  return queryCount(
    `SELECT COUNT(*)::text AS count FROM pg_trigger
     WHERE tgname IN ('shifts_cash_up_guard_row', 'shifts_cash_up_guard_truncate')`,
  );
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
   * RT-812: the expected ledger is the migration registry (./migrations/:
   * the frozen baseline plus one file per later migration), checked against
   * packages/db/drizzle/ when this suite loads: a stray, deleted or down-less
   * migration, or a head without a biting probe, fails before any test runs.
   * Order is the lex-sorted file names, the order the runner applies (and the
   * inverse it rolls back).
   */
  const REGISTRY = resolveMigrationRegistry();
  const EXPECTED_MIGRATIONS = REGISTRY.ids;
  const LATEST_MIGRATION = REGISTRY.head;
  const SECOND_LATEST_MIGRATION = EXPECTED_MIGRATIONS[EXPECTED_MIGRATIONS.length - 2]!;

  /** The two tables created by 0035_cashier_admissions (RT-113 BC2). */
  const ADMISSION_TABLES = ["cashier_admissions", "cashier_admission_requests"];

  /** The three append-only fact tables created by 0036_shift_cash_up (RT-17). */
  const SHIFT_CASH_UP_TABLES = ["shift_closes", "shift_cash_movements", "shift_refund_claims"];

  /** 0036 is fully applied: its fact tables, shifts cash-up column and guard triggers. */
  async function expectShiftCashUpApplied(): Promise<void> {
    expect(await countPublicTables(SHIFT_CASH_UP_TABLES)).toBe("3");
    expect(await countPublicColumn("shifts", "source")).toBe("1");
    expect(await countShiftGuardTriggers()).toBe("2");
  }

  /** The append-only resolution table created by 0037_erpnext_posting_resolution (RT-330). */
  const RESOLUTION_TABLES = ["erpnext_posting_resolution"];
  const countResolutionVersionColumn = (): Promise<string> =>
    countPublicColumn("erpnext_posting_status", "current_resolution_version");
  const countEvidenceColumn = (): Promise<string> =>
    countPublicColumn("erpnext_posting_status", "reconciliation_document_ref");

  /** 0040_device_lifecycle (RT-364): device expiry + pairing replacement link. */
  async function countDeviceLifecycleColumns(): Promise<[string, string]> {
    return [
      await countPublicColumn("devices", "expires_at"),
      await countPublicColumn("pairing_codes", "replaces_device_id"),
    ];
  }

  /** 0041_sale_tender_ref (RT-360): tender-line identity on sale_tenders. */
  async function countTenderRefColumns(): Promise<[string, string]> {
    return [
      await countPublicColumn("sale_tenders", "tender_ref"),
      await countPublicColumn("sale_tenders", "sequence"),
    ];
  }

  /** 0042_inventory_effects_journal (RT-425): the integration table + effect columns. */
  const EFFECT_INTEGRATION_TABLES = ["inventory_effect_integration"];
  async function expectInventoryEffectsApplied(): Promise<void> {
    expect(await countPublicTables(EFFECT_INTEGRATION_TABLES)).toBe("1");
    expect(await countPublicColumn("stock_movements", "origin")).toBe("1");
    expect(await countPublicColumn("stock_movements", "event_type")).toBe("1");
    expect(await countPublicColumn("erpnext_posting_status", "posted_at")).toBe("1");
  }

  /** 0044_stock_locations_position_grain (RT-432): the locations table + its store trigger. */
  const STOCK_LOCATION_TABLES = ["stock_locations"];
  async function countStockLocationTriggers(): Promise<string> {
    return queryCount(`SELECT COUNT(*)::text AS count FROM pg_trigger
      WHERE NOT tgisinternal AND tgname IN
        ('stores_create_primary_location', 'stock_locations_guard_identity')`);
  }

  /** 0045_tracking_foundation (RT-448): identities, edge map, profile + guard triggers. */
  const TRACKING_TABLES = ["tracking_identities", "erpnext_tracking_map"];
  async function countTrackingTriggers(): Promise<string> {
    return queryCount(`SELECT COUNT(*)::text AS count FROM pg_trigger
      WHERE NOT tgisinternal AND tgname IN
        ('tenant_products_guard_tracking_profile', 'tracking_identities_guard_identity')`);
  }
  async function expectTrackingFoundationApplied(): Promise<void> {
    expect(await countPublicTables(TRACKING_TABLES)).toBe("2");
    expect(await countTrackingTriggers()).toBe("2");
    expect(await countPublicColumn("tenant_products", "tracking_mode")).toBe("1");
    expect(await countPublicColumn("tenant_products", "expiry_required")).toBe("1");
    expect(await countPublicColumn("stock_movements", "tracking_identity_id")).toBe("1");
  }

  /** The admin connection as the probes see it. */
  const probeDb: ProbeDb = { count: queryCount };

  /** Every probe's current reading (./migrations/: 0046 on, plus each later migration's own). */
  async function readProbes(): Promise<Map<string, readonly string[]>> {
    const readings = new Map<string, readonly string[]>();
    for (const [id, probe] of REGISTRY.probes) readings.set(id, await probe.measure(probeDb));
    return readings;
  }

  /** The `rolledBack` migrations read rolled back; every other probed migration reads applied. */
  async function expectProbeState(rolledBack: ReadonlySet<string>): Promise<void> {
    expect(probeMismatches(REGISTRY.probes, await readProbes(), rolledBack)).toEqual([]);
  }

  /**
   * After one `down` from head: the head's own objects are gone (its probe
   * reads rolled back), every other probed migration's objects survive, and
   * everything below 0046 survives.
   */
  async function expectOnlyLatestRolledBack(): Promise<void> {
    await expectProbeState(new Set([LATEST_MIGRATION]));
    await expectBelow0046Applied();
  }

  /**
   * Everything below 0046 is applied: 0032's sale_voids.business_date, 0045's
   * tracking tables, the tenant_products Tracking Profile and
   * stock_movements.tracking_identity_id, 0044's stock_locations table, its
   * store trigger and the stock_movements position constraints, 0042's
   * integration table and effect columns (with 0043's backfill), 0041's tender
   * columns, 0040's device lifecycle columns, 0039's evidence column and
   * 0037/0038's resolution table.
   */
  async function expectBelow0046Applied(): Promise<void> {
    // 0032's void columns survive.
    expect(await countPublicColumn("sale_voids", "business_date")).toBe("1");
    await expectTrackingFoundationApplied();
    expect(await countPublicTables(STOCK_LOCATION_TABLES)).toBe("1");
    expect(await countStockLocationTriggers()).toBe("2");
    expect(
      await queryCount(`SELECT COUNT(*)::text AS count FROM pg_constraint
        WHERE conname = 'stock_movements_position_required'`),
    ).toBe("1");
    await expectInventoryEffectsApplied();
    expect(await countTenderRefColumns()).toEqual(["1", "1"]);
    expect(await countDeviceLifecycleColumns()).toEqual(["1", "1"]);
    expect(await countEvidenceColumn()).toBe("1");
    expect(await countPublicTables(RESOLUTION_TABLES)).toBe("1");
    expect(await countResolutionVersionColumn()).toBe("1");
  }

  /** Every migration from 0046 to the head is applied: every probe reads applied. */
  async function expectFrom0046Applied(): Promise<void> {
    await expectProbeState(new Set());
  }

  /** The three return tables created by 0032_sale_returns (RT-73). */
  const RETURN_TABLES = ["sale_returns", "sale_return_lines", "sale_return_tenders"];

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
    // 0031's outbox tenant FK and nil-tenant CHECK.
    expect(
      await queryCount(`
        SELECT COUNT(*)::text AS count FROM pg_constraint
        WHERE conname = 'outbox_events_tenant_id_fk'
      `),
    ).toBe("1");
    expect(
      await queryCount(`
        SELECT COUNT(*)::text AS count FROM pg_constraint
        WHERE conname = 'tenants_id_not_nil'
      `),
    ).toBe("1");
    // 0032's return tables, sale_voids.business_date and one-void index.
    expect(await countPublicTables(RETURN_TABLES)).toBe("3");
    expect(await countPublicColumn("sale_voids", "business_date")).toBe("1");
    expect(
      await queryCount(`SELECT COUNT(*)::text AS count FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'uq_sale_voids_one_per_sale'`),
    ).toBe("1");    // 0033's sale_tenders table and the two sales columns (RT-77).
    expect(await countPublicTables(["sale_tenders"])).toBe("1");
    expect(await countPublicColumn("sales", "device_id")).toBe("1");
    expect(await countPublicColumn("sales", "tender_count")).toBe("1");
    // 0034's audit_events append-only triggers (RT-133).
    expect(await countAppendOnlyTriggers()).toBe("2");
    // 0035's cashier admission tables and their 3 + 4 policies (RT-113 BC2).
    expect(await countPublicTables(ADMISSION_TABLES)).toBe("2");
    expect(await countPolicies(ADMISSION_TABLES)).toBe("7");
    // 0036's cash-up fact tables (SELECT + INSERT policies each), the shifts
    // cash-up columns and guard triggers (RT-17).
    await expectShiftCashUpApplied();
    expect(await countPolicies(SHIFT_CASH_UP_TABLES)).toBe("6");
    // 0037's resolution table (SELECT + INSERT policies) and the posting
    // status column the feed reads (RT-330).
    expect(await countPublicTables(RESOLUTION_TABLES)).toBe("1");
    expect(await countPolicies(RESOLUTION_TABLES)).toBe("2");
    expect(await countResolutionVersionColumn()).toBe("1");
    expect(await countEvidenceColumn()).toBe("1"); // 0039 (RT-332)
    expect(await countDeviceLifecycleColumns()).toEqual(["1", "1"]); // 0040 (RT-364)
    expect(await countTenderRefColumns()).toEqual(["1", "1"]); // 0041 (RT-360)
    // 0042's integration table (SELECT + INSERT + UPDATE policies) and effect
    // columns (RT-425).
    await expectInventoryEffectsApplied();
    expect(await countPolicies(EFFECT_INTEGRATION_TABLES)).toBe("3");
    // 0044's stock_locations (SELECT + INSERT policies) and its two triggers
    // (RT-432).
    expect(await countPublicTables(STOCK_LOCATION_TABLES)).toBe("1");
    expect(await countPolicies(STOCK_LOCATION_TABLES)).toBe("2");
    expect(await countStockLocationTriggers()).toBe("2");
    // 0045's tracking identities and edge map (SELECT + INSERT policies each),
    // the Tracking Profile columns and the two guard triggers (RT-448).
    await expectTrackingFoundationApplied();
    expect(await countPolicies(TRACKING_TABLES)).toBe("4");
    await expectFrom0046Applied();
  });

  it("up is idempotent on a second run", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await runCli(["up"], { DATABASE_URL: env.adminUri });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no pending migrations/);
    expect(await ledgerIds()).toHaveLength(EXPECTED_MIGRATIONS.length);
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

      await expectOnlyLatestRolledBack();

      // Sanity: everything older SURVIVES the head rollback (down reverses
      // only the latest migration) —
      // 0036's cash-up fact tables, shifts cash-up columns and guard triggers (RT-17);
      await expectShiftCashUpApplied();
      // 0035's cashier admission tables (RT-113 BC2);
      expect(await countPublicTables(ADMISSION_TABLES)).toBe("2");
      // 0034's audit_events append-only triggers (RT-133);
      expect(await countAppendOnlyTriggers()).toBe("2");
      // 0033's sale_tenders table and the two sales columns (RT-77);
      expect(await countPublicTables(["sale_tenders"])).toBe("1");
      expect(await countPublicColumn("sales", "device_id")).toBe("1");
      expect(await countPublicColumn("sales", "tender_count")).toBe("1");
      // 0032's return tables, sale_voids.business_date and one-void index;
      expect(await countPublicTables(RETURN_TABLES)).toBe("3");
      expect(await countPublicColumn("sale_voids", "business_date")).toBe("1");
      expect(
        await queryCount(`SELECT COUNT(*)::text AS count FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'uq_sale_voids_one_per_sale'`),
      ).toBe("1");
      // 0031's outbox tenant FK and nil-tenant CHECK;
      expect(
        await queryCount(`
          SELECT COUNT(*)::text AS count FROM pg_constraint
          WHERE conname = 'outbox_events_tenant_id_fk'
        `),
      ).toBe("1");
      expect(
        await queryCount(`
          SELECT COUNT(*)::text AS count FROM pg_constraint
          WHERE conname = 'tenants_id_not_nil'
        `),
      ).toBe("1");
      // 0030's membership trigger and function;
      expect(
        await queryCount(`
          SELECT COUNT(*)::text AS count FROM pg_trigger
          WHERE tgname = 'sessions_active_tenant_membership_check'
        `),
      ).toBe("1");
      expect(
        await queryCount(`
          SELECT COUNT(*)::text AS count FROM pg_proc
          WHERE proname = 'sessions_check_active_tenant_membership'
        `),
      ).toBe("1");
      // 0029's credential_hash column;
      expect(await countPublicColumn("sessions", "credential_hash")).toBe("1");
      // 0028's lease column and index, and the 0027 settlement tables;
      expect(await countPublicColumn("outbox_events", "claimed_at")).toBe("1");
      expect(
        await queryCount(`SELECT COUNT(*)::text AS count FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'outbox_events_stale_claim_idx'`),
      ).toBe("1");
      expect(await countPublicTables(SETTLEMENT_TABLES)).toBe("7");
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
    expect(
      await queryCount(`
        SELECT COUNT(*)::text AS count FROM pg_constraint
        WHERE conname = 'outbox_events_tenant_id_fk'
      `),
    ).toBe("1");
    expect(
      await queryCount(`
        SELECT COUNT(*)::text AS count FROM pg_constraint
        WHERE conname = 'tenants_id_not_nil'
      `),
    ).toBe("1");
    // Re-applying the latest migration leaves all seven catalog tables from
    // 0007 intact; the catalog set is unaffected by the latest migration.
    expect(await countPublicTables(CATALOG_TABLES)).toBe("7");
    expect(await countAppendOnlyTriggers()).toBe("2");
    expect(await countPublicTables(ADMISSION_TABLES)).toBe("2");
    await expectShiftCashUpApplied();
    expect(await countPublicTables(RESOLUTION_TABLES)).toBe("1");
    expect(await countDeviceLifecycleColumns()).toEqual(["1", "1"]);
    expect(await countTenderRefColumns()).toEqual(["1", "1"]);
    await expectInventoryEffectsApplied();
    expect(await countPublicTables(STOCK_LOCATION_TABLES)).toBe("1");
    await expectTrackingFoundationApplied();
    await expectFrom0046Applied();
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
      // RT-812: each probed migration's own objects are gone right after its own down.
      const probe = REGISTRY.probes.get(id);
      if (probe) expect({ id, reading: await probe.measure(probeDb) }).toEqual({ id, reading: probe.rolledBack });
    }

    const empty = await runCli(["down"], { DATABASE_URL: env.adminUri });
    expect(empty.code).toBe(0);
    expect(empty.stdout).toMatch(/down: nothing to roll back/);

    // SECOND_LATEST_MIGRATION is referenced so the symbol stays alive even if
    // a future test drops down to it explicitly; no-op assertion otherwise.
    expect(SECOND_LATEST_MIGRATION).toBeTruthy();
  });
});
