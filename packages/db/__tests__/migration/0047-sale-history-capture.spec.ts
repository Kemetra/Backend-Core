/**
 * 0047 + 0048 — store-wide sale history storage (Jira RT-538, RT-534 S2;
 * [GATED] approval: Jira RT-538 comment 12079). Contract: RT-537
 * (pos-sales/sale-history.yaml 1.0.0-draft, sales.yaml 1.9.0-draft).
 *
 * Applies every migration before 0047 against a real Postgres, seeds a pre-0047
 * sale with a line (the UPGRADE path), applies 0047 and 0048 exactly as the
 * runner does (one `query()` per file), then proves:
 *   - the existing sale and line keep working: every new column is NULL (no
 *     backfill);
 *   - the receipt snapshot columns are typed per the contract, nullable, and
 *     all-or-none over the six header fields (the operator display name alone
 *     may be tombstoned on erasure);
 *   - sale_lines.line_seq is a nullable positive integer;
 *   - sale_reprints is tenant-isolated (FORCE RLS, SELECT + INSERT only),
 *     attaches only to a sale of the same tenant and store, and records a key
 *     at most once per client;
 *   - the store/business-date index is valid, has the contract's order and
 *     serves the history list's keyset query without a sort;
 *   - 0048 stays a single statement, so the runner never wraps the
 *     CONCURRENTLY build in a transaction block;
 *   - down drops only the new objects, keeps every sale and line, and
 *     round-trips with up.
 *
 * Fresh install (the whole chain from empty) through the real runner is covered
 * by the migrate CLI spec's EXPECTED_MIGRATIONS ledger.
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
import { sqlStatements, withTenant } from "../_helpers/migration-sql";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_0047_NAME = "0047_sale_history_capture.sql";
const UP_0047 = resolve(DRIZZLE_DIR, UP_0047_NAME);
const DOWN_0047 = resolve(DRIZZLE_DIR, "0047_sale_history_capture.down.sql");
const UP_0048 = resolve(DRIZZLE_DIR, "0048_sales_store_business_date_idx.sql");
const DOWN_0048 = resolve(DRIZZLE_DIR, "0048_sales_store_business_date_idx.down.sql");

const INDEX_NAME = "idx_sales_tenant_store_business_date";

const TENANT = "0a000000-0000-7000-8000-000000047001";
const TENANT_2 = "0a000000-0000-7000-8000-000000047002";
const STORE = "0a000000-0000-7000-8000-000000047003";
const STORE_B = "0a000000-0000-7000-8000-000000047004";
const STORE_T2 = "0a000000-0000-7000-8000-000000047005";
const ACTOR = "0a000000-0000-7000-8000-000000047006";
const ACTOR_2 = "0a000000-0000-7000-8000-000000047007";
const DEVICE = "0a000000-0000-7000-8000-000000047008";
const SALE_LEGACY = "0a000000-0000-7000-8000-000000047011";
const LINE_LEGACY = "0a000000-0000-7000-8000-000000047012";
const SALE_NEW = "0a000000-0000-7000-8000-000000047013";
const SALE_T2 = "0a000000-0000-7000-8000-000000047014";

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

const read = (path: string): string => readFileSync(path, "utf8");

async function applyBefore0047(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_0047_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(read(resolve(DRIZZLE_DIR, name)));
  }
  await ensureAppRole(pgEnv);
}

/** A sale row to seed. */
interface SaleSeed {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly externalId: string;
}

const SALE = {
  legacy: { id: SALE_LEGACY, tenantId: TENANT, storeId: STORE, externalId: "rt538-legacy" },
  fresh: { id: SALE_NEW, tenantId: TENANT, storeId: STORE, externalId: "rt538-new" },
  tenant2: { id: SALE_T2, tenantId: TENANT_2, storeId: STORE_T2, externalId: "rt538-t2" },
} as const satisfies Record<string, SaleSeed>;

async function insertSale({ id, tenantId, storeId, externalId }: SaleSeed): Promise<void> {
  await pg().admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', 10, '2026-10-01T10:00:00Z', '2026-10-01',
             'pos-1', $4, $5, $6)`,
    [id, tenantId, storeId, externalId, "c".repeat(64), ACTOR],
  );
}

/** The receipt snapshot a capture would persist (CaptureSaleReceipt). */
interface Receipt {
  readonly saleNumber: string | null;
  readonly receiptNumber: string | null;
  readonly terminalLabel: string | null;
  readonly operatorDisplayName: string | null;
  readonly settledAt: string | null;
  readonly branchName: string | null;
  readonly branchAddress: string | null;
  readonly taxRegistrationId: string | null;
  readonly changeGiven: string | null;
}

const NO_RECEIPT: Receipt = {
  saleNumber: null,
  receiptNumber: null,
  terminalLabel: null,
  operatorDisplayName: null,
  settledAt: null,
  branchName: null,
  branchAddress: null,
  taxRegistrationId: null,
  changeGiven: null,
};

const FULL_RECEIPT: Receipt = {
  saleNumber: "TILL-01-2026-10-01-000042",
  receiptNumber: null,
  terminalLabel: "TILL-01",
  operatorDisplayName: "Mona",
  settledAt: "2026-10-01T10:00:05Z",
  branchName: "Main branch",
  branchAddress: "1 Nile St, Cairo",
  taxRegistrationId: "123-456-789",
  changeGiven: null,
};

/** Writes a receipt snapshot onto a seeded sale (the capture INSERT's columns). */
async function setReceipt(saleId: string, r: Receipt): Promise<void> {
  await pg().admin.query(
    `UPDATE sales SET
       receipt_sale_number = $2, receipt_number = $3, receipt_terminal_label = $4,
       receipt_operator_display_name = $5, receipt_settled_at = $6,
       receipt_branch_name = $7, receipt_branch_address = $8,
       receipt_tax_registration_id = $9, receipt_change_given = $10
     WHERE id = $1`,
    [
      saleId,
      r.saleNumber,
      r.receiptNumber,
      r.terminalLabel,
      r.operatorDisplayName,
      r.settledAt,
      r.branchName,
      r.branchAddress,
      r.taxRegistrationId,
      r.changeGiven,
    ],
  );
}

/** A sale_reprints row to insert. */
interface ReprintSeed {
  readonly id: string;
  readonly sale: SaleSeed;
  readonly storeId?: string;
  readonly mode?: string;
  readonly kind?: string;
  readonly copyNumber?: number;
  readonly createdBy?: string;
  readonly idempotencyKey: string;
}

async function insertReprint(client: Pick<PoolClient, "query">, seed: ReprintSeed): Promise<void> {
  await client.query(
    `INSERT INTO sale_reprints
       (id, sale_id, tenant_id, store_id, mode, kind, marked_voided, marked_returned,
        copy_number, printed_at, created_by, device_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, false, false, $7, '2026-10-01T11:00:00Z', $8, $9, $10)`,
    [
      seed.id,
      seed.sale.id,
      seed.sale.tenantId,
      seed.storeId ?? seed.sale.storeId,
      seed.mode ?? "authorize",
      seed.kind ?? "duplicate",
      seed.copyNumber ?? 1,
      seed.createdBy ?? ACTOR,
      seed.sale.tenantId === TENANT ? DEVICE : null,
      seed.idempotencyKey,
    ],
  );
}

/** Runs `fn` as the non-superuser app role inside one tenant's context, then rolls back. */
function asTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(pg().app, tenantId, fn);
}

async function count(sql: string, params: unknown[] = []): Promise<string> {
  const r = await pg().admin.query<{ n: string }>(sql, params);
  return r.rows[0]?.n ?? "0";
}

const RECEIPT_COLUMNS = [
  "receipt_sale_number",
  "receipt_number",
  "receipt_terminal_label",
  "receipt_operator_display_name",
  "receipt_settled_at",
  "receipt_branch_name",
  "receipt_branch_address",
  "receipt_tax_registration_id",
  "receipt_change_given",
] as const;

async function countReceiptColumns(): Promise<string> {
  return count(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sales' AND column_name = ANY($1)`,
    [RECEIPT_COLUMNS],
  );
}

async function countLineSeq(): Promise<string> {
  return count(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sale_lines' AND column_name = 'line_seq'`,
  );
}

async function countReprintTable(): Promise<string> {
  return count(
    `SELECT count(*)::text AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'sale_reprints'`,
  );
}

async function countIndex(): Promise<string> {
  return count(
    `SELECT count(*)::text AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [INDEX_NAME],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0047-sale-history-capture.spec] Docker NOT AVAILABLE - skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0047(env);
  await env.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'RT-538 tenant', 'rt538-tenant'), ($2, 'RT-538 tenant 2', 'rt538-tenant-2')`,
    [TENANT, TENANT_2],
  );
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $2, 'rt538', 'RT-538 store'), ($3, $2, 'rt538b', 'RT-538 store B'), ($4, $5, 'rt538t2', 'RT-538 store T2')`,
    [STORE, TENANT, STORE_B, STORE_T2, TENANT_2],
  );
  await env.admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash) VALUES ($1, $2, $3, $4)`,
    [DEVICE, TENANT, STORE, "d".repeat(64)],
  );
  // A pre-0047 sale and line, written by the pre-RT-538 writer.
  await insertSale(SALE.legacy);
  await env.admin.query(
    `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price,
                             currency_code, quantity, line_amount, unit)
     VALUES ($1, $2, $3, $4, 'Tea', 10, 'EGP', 1, 10, 'pcs')`,
    [LINE_LEGACY, SALE_LEGACY, TENANT, STORE],
  );
  // One query() per file, exactly as the runner sends it.
  await env.admin.query(read(UP_0047));
  await env.admin.query(read(UP_0048));
  // Re-grant so the app role reaches the new table (test-only; production
  // grants are provisioned outside migrations, RT-539).
  await ensureAppRole(env);
  await insertSale(SALE.fresh);
  await insertSale(SALE.tenant2);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => env === null;

describe("0047_sale_history_capture - upgrade over an existing sale", () => {
  it("leaves the existing sale with no receipt snapshot and its line with no sequence (no backfill)", async () => {
    if (skip()) return;
    const sale = await pg().admin.query(
      `SELECT ${RECEIPT_COLUMNS.join(", ")} FROM sales WHERE id = $1`,
      [SALE_LEGACY],
    );
    expect(sale.rows).toEqual([Object.fromEntries(RECEIPT_COLUMNS.map((c) => [c, null]))]);
    const line = await pg().admin.query(`SELECT line_seq FROM sale_lines WHERE id = $1`, [LINE_LEGACY]);
    expect(line.rows).toEqual([{ line_seq: null }]);
  });

  it("types every new column per the RT-537 contract, all nullable", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ column_name: string; type: string; is_nullable: string }>(
      `SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type,
              CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable
         FROM pg_attribute a
        WHERE a.attrelid IN ('sales'::regclass, 'sale_lines'::regclass)
          AND (a.attname LIKE 'receipt\\_%' OR a.attname = 'line_seq')
          AND NOT a.attisdropped
        ORDER BY a.attname`,
    );
    expect(r.rows).toEqual([
      { column_name: "line_seq", type: "integer", is_nullable: "YES" },
      { column_name: "receipt_branch_address", type: "text", is_nullable: "YES" },
      { column_name: "receipt_branch_name", type: "text", is_nullable: "YES" },
      { column_name: "receipt_change_given", type: "numeric(19,4)", is_nullable: "YES" },
      { column_name: "receipt_number", type: "text", is_nullable: "YES" },
      { column_name: "receipt_operator_display_name", type: "text", is_nullable: "YES" },
      { column_name: "receipt_sale_number", type: "text", is_nullable: "YES" },
      { column_name: "receipt_settled_at", type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "receipt_tax_registration_id", type: "text", is_nullable: "YES" },
      { column_name: "receipt_terminal_label", type: "text", is_nullable: "YES" },
    ]);
  });

  it("adds no default to any new column (metadata-only ADD COLUMN, no table rewrite)", async () => {
    if (skip()) return;
    const n = await count(
      `SELECT count(*)::text AS n FROM pg_attrdef d
         JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE d.adrelid IN ('sales'::regclass, 'sale_lines'::regclass)
          AND (a.attname LIKE 'receipt\\_%' OR a.attname = 'line_seq')`,
    );
    expect(n).toBe("0");
  });
});

describe("0047_sale_history_capture - receipt snapshot", () => {
  afterEach(async () => {
    if (skip()) return;
    await setReceipt(SALE_NEW, NO_RECEIPT);
  });

  it("stores a complete snapshot, with and without the optional receipt number and change", async () => {
    if (skip()) return;
    await expect(setReceipt(SALE_NEW, FULL_RECEIPT)).resolves.toBeUndefined();
    await setReceipt(SALE_NEW, { ...FULL_RECEIPT, receiptNumber: "R-000042", changeGiven: "5.5000" });
    const r = await pg().admin.query(
      `SELECT receipt_number, receipt_change_given::text AS change FROM sales WHERE id = $1`,
      [SALE_NEW],
    );
    expect(r.rows).toEqual([{ receipt_number: "R-000042", change: "5.5000" }]);
  });

  it.each([
    ["receipt_sale_number", { saleNumber: null }],
    ["receipt_terminal_label", { terminalLabel: null }],
    ["receipt_settled_at", { settledAt: null }],
    ["receipt_branch_name", { branchName: null }],
    ["receipt_branch_address", { branchAddress: null }],
    ["receipt_tax_registration_id", { taxRegistrationId: null }],
  ])("rejects a snapshot missing %s (all-or-none)", async (_column, missing) => {
    if (skip()) return;
    await expect(setReceipt(SALE_NEW, { ...FULL_RECEIPT, ...missing })).rejects.toThrow(
      /sales_receipt_snapshot_all_or_none/,
    );
  });

  it("lets only the operator display name be tombstoned on an existing snapshot (user erasure)", async () => {
    if (skip()) return;
    await setReceipt(SALE_NEW, FULL_RECEIPT);
    await expect(
      pg().admin.query(`UPDATE sales SET receipt_operator_display_name = NULL WHERE id = $1`, [SALE_NEW]),
    ).resolves.toBeDefined();
    const r = await pg().admin.query(
      `SELECT receipt_sale_number, receipt_operator_display_name FROM sales WHERE id = $1`,
      [SALE_NEW],
    );
    expect(r.rows).toEqual([
      { receipt_sale_number: FULL_RECEIPT.saleNumber, receipt_operator_display_name: null },
    ]);
  });

  it.each([
    ["receipt_number", { receiptNumber: "R-1" }],
    ["receipt_change_given", { changeGiven: "1.0000" }],
    ["receipt_operator_display_name", { operatorDisplayName: "Mona" }],
  ])("rejects %s without a snapshot", async (_column, only) => {
    if (skip()) return;
    await expect(setReceipt(SALE_NEW, { ...NO_RECEIPT, ...only })).rejects.toThrow(
      /sales_receipt_snapshot_all_or_none/,
    );
  });

  it("rejects negative change", async () => {
    if (skip()) return;
    await expect(setReceipt(SALE_NEW, { ...FULL_RECEIPT, changeGiven: "-0.0100" })).rejects.toThrow(
      /sales_receipt_change_given_non_negative/,
    );
  });
});

describe("0047_sale_history_capture - sale_lines.line_seq", () => {
  async function insertLine(id: string, lineSeq: number | null): Promise<void> {
    await pg().admin.query(
      `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price,
                               currency_code, quantity, line_amount, unit, line_seq)
       VALUES ($1, $2, $3, $4, 'Coffee', 10, 'EGP', 1, 10, 'pcs', $5)`,
      [id, SALE_NEW, TENANT, STORE, lineSeq],
    );
  }

  it("accepts a positive sequence and no sequence", async () => {
    if (skip()) return;
    await expect(insertLine("0a000000-0000-7000-8000-000000047021", 1)).resolves.toBeUndefined();
    await expect(insertLine("0a000000-0000-7000-8000-000000047022", null)).resolves.toBeUndefined();
  });

  it.each([0, -1])("rejects sequence %d", async (seq) => {
    if (skip()) return;
    await expect(insertLine("0a000000-0000-7000-8000-000000047023", seq)).rejects.toThrow(
      /sale_lines_line_seq_positive/,
    );
  });
});

describe("0047_sale_history_capture - sale_reprints", () => {
  it("records a reprint of a sale with the server clock as recorded_at", async () => {
    if (skip()) return;
    await insertReprint(pg().admin, {
      id: "0a000000-0000-7000-8000-000000047031",
      sale: SALE.fresh,
      idempotencyKey: "rt538-reprint-key-0001",
    });
    const r = await pg().admin.query(
      `SELECT mode, kind, copy_number, device_id::text, recorded_at IS NOT NULL AS has_recorded_at
         FROM sale_reprints WHERE id = $1`,
      ["0a000000-0000-7000-8000-000000047031"],
    );
    expect(r.rows).toEqual([
      { mode: "authorize", kind: "duplicate", copy_number: 1, device_id: DEVICE, has_recorded_at: true },
    ]);
  });

  it("attaches only to a sale of the same tenant and store (composite FK)", async () => {
    if (skip()) return;
    await expect(
      insertReprint(pg().admin, {
        id: "0a000000-0000-7000-8000-000000047032",
        sale: SALE.fresh,
        storeId: STORE_B,
        idempotencyKey: "rt538-reprint-key-0002",
      }),
    ).rejects.toThrow(/fk_sale_reprints_sale_tenant_store/);
  });

  it.each([
    ["mode", { mode: "print" }, /sale_reprints_mode_valid/],
    ["kind", { kind: "copy" }, /sale_reprints_kind_valid/],
    ["copy_number", { copyNumber: 0 }, /sale_reprints_copy_number_positive/],
  ])("rejects an invalid %s", async (_column, bad, constraint) => {
    if (skip()) return;
    await expect(
      insertReprint(pg().admin, {
        id: "0a000000-0000-7000-8000-000000047033",
        sale: SALE.fresh,
        idempotencyKey: "rt538-reprint-key-0003",
        ...bad,
      }),
    ).rejects.toThrow(constraint);
  });

  it("records an idempotency key at most once per client per sale; another client or sale may reuse it", async () => {
    if (skip()) return;
    await insertReprint(pg().admin, {
      id: "0a000000-0000-7000-8000-000000047034",
      sale: SALE.fresh,
      idempotencyKey: "rt538-reprint-key-0004",
    });
    await expect(
      insertReprint(pg().admin, {
        id: "0a000000-0000-7000-8000-000000047035",
        sale: SALE.fresh,
        idempotencyKey: "rt538-reprint-key-0004",
      }),
    ).rejects.toThrow(/uq_sale_reprints_sale_actor_key/);
    await expect(
      insertReprint(pg().admin, {
        id: "0a000000-0000-7000-8000-000000047036",
        sale: SALE.fresh,
        createdBy: ACTOR_2,
        idempotencyKey: "rt538-reprint-key-0004",
      }),
    ).resolves.toBeUndefined();
    // The replay layer keys on the resolved saleRef, so the same client's key on
    // another sale is a new request and must record (never a 23505 / 500).
    await expect(
      insertReprint(pg().admin, {
        id: "0a000000-0000-7000-8000-000000047039",
        sale: SALE.legacy,
        idempotencyKey: "rt538-reprint-key-0004",
      }),
    ).resolves.toBeUndefined();
  });

  it("forces row-level security and is append-only: SELECT and INSERT policies only", async () => {
    if (skip()) return;
    const rls = await pg().admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'sale_reprints'`,
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await pg().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = 'sale_reprints' ORDER BY cmd`,
    );
    expect(policies.rows.map((p) => p.cmd)).toEqual(["INSERT", "SELECT"]);
  });

  it("isolates tenants for the app role: own rows only, no cross-tenant insert", async () => {
    if (skip()) return;
    await insertReprint(pg().admin, {
      id: "0a000000-0000-7000-8000-000000047037",
      sale: SALE.tenant2,
      idempotencyKey: "rt538-reprint-key-0007",
    });
    const tenants = await asTenant(TENANT, async (c) => {
      const r = await c.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id::text FROM sale_reprints`);
      return r.rows.map((row) => row.tenant_id);
    });
    expect(tenants).toEqual([TENANT]);
    await expect(
      asTenant(TENANT, (c) =>
        insertReprint(c, {
          id: "0a000000-0000-7000-8000-000000047038",
          sale: SALE.tenant2,
          idempotencyKey: "rt538-reprint-key-0008",
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("0048_sales_store_business_date_idx - the history list index", () => {
  it("is a single statement with no transaction control, so the runner never wraps CONCURRENTLY", () => {
    for (const path of [UP_0048, DOWN_0048]) {
      const statements = sqlStatements(path);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatch(/\bCONCURRENTLY\b/);
      expect(statements[0]).not.toMatch(/\b(BEGIN|COMMIT)\b/i);
    }
  });

  it("is valid and orders (tenant_id, store_id, business_date DESC, occurred_at DESC, id DESC)", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ valid: boolean; ready: boolean; def: string }>(
      `SELECT i.indisvalid AS valid, i.indisready AS ready, pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1`,
      [INDEX_NAME],
    );
    expect(r.rows).toEqual([
      {
        valid: true,
        ready: true,
        def: `CREATE INDEX ${INDEX_NAME} ON public.sales USING btree (tenant_id, store_id, business_date DESC, occurred_at DESC, id DESC)`,
      },
    ]);
  });

  it("serves the history list's keyset query under RLS with an index scan and no sort", async () => {
    if (skip()) return;
    const plan = await asTenant(TENANT, async (c) => {
      await c.query("SET LOCAL enable_seqscan = off");
      const r = await c.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT id FROM sales
          WHERE tenant_id = $1 AND store_id = $2
            AND business_date BETWEEN $3 AND $4
            AND (business_date, occurred_at, id) < ($4::date, $5::timestamptz, $6::uuid)
          ORDER BY business_date DESC, occurred_at DESC, id DESC
          LIMIT 51`,
        [TENANT, STORE, "2026-09-01", "2026-10-01", "2026-10-01T23:00:00Z", SALE_NEW],
      );
      return JSON.stringify(r.rows[0]?.["QUERY PLAN"]);
    });
    expect(plan).toContain(`"Index Name":"${INDEX_NAME}"`);
    expect(plan).not.toContain(`"Node Type":"Sort"`);
    expect(plan).not.toContain(`"Node Type":"Incremental Sort"`);
  });
});

describe("0047 + 0048 - down -> up round-trip", () => {
  it("each down drops only its own objects, keeps every sale and line, and up re-applies cleanly", async () => {
    if (skip()) return;
    const salesBefore = await count(`SELECT count(*)::text AS n FROM sales`);
    const linesBefore = await count(`SELECT count(*)::text AS n FROM sale_lines`);

    await pg().admin.query(read(DOWN_0048));
    expect(await countIndex()).toBe("0");
    expect(await countReceiptColumns()).toBe(String(RECEIPT_COLUMNS.length));
    expect(await countReprintTable()).toBe("1");

    await pg().admin.query(read(DOWN_0047));
    expect(await countReceiptColumns()).toBe("0");
    expect(await countLineSeq()).toBe("0");
    expect(await countReprintTable()).toBe("0");
    expect(await count(`SELECT count(*)::text AS n FROM sales`)).toBe(salesBefore);
    expect(await count(`SELECT count(*)::text AS n FROM sale_lines`)).toBe(linesBefore);

    await pg().admin.query(read(UP_0047));
    await pg().admin.query(read(UP_0048));
    expect(await countReceiptColumns()).toBe(String(RECEIPT_COLUMNS.length));
    expect(await countLineSeq()).toBe("1");
    expect(await countReprintTable()).toBe("1");
    expect(await countIndex()).toBe("1");
  });
});
