/**
 * 0046 — manager-approved sale void (RT-530; [GATED] approval: Jira RT-530
 * comment 11988).
 *
 * Applies every migration before 0046 against a real Postgres, seeds a pre-0046
 * void (the UPGRADE path), then proves:
 *   - the existing void keeps working: every approval column is NULL (no
 *     backfill) and `business_date` is untouched;
 *   - an approved void stores its evidence, and the six columns are all-or-none;
 *   - an approval id is single-use within a tenant (and only a legacy void may
 *     carry none, any number of times);
 *   - down drops only the new columns, keeps every void row, and round-trips
 *     with up.
 *
 * Fresh install (the whole chain from empty) is covered by the migrate CLI
 * spec's EXPECTED_MIGRATIONS ledger.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0046_sale_void_approval.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0046_sale_void_approval.down.sql");

const TENANT = "0a000000-0000-7000-8000-000000046001";
const TENANT_2 = "0a000000-0000-7000-8000-000000046002";
const STORE = "0a000000-0000-7000-8000-000000046003";
const STORE_2 = "0a000000-0000-7000-8000-000000046004";
const ACTOR = "0a000000-0000-7000-8000-000000046005";
const APPROVER = "0a000000-0000-7000-8000-000000046006";
const SALE_LEGACY = "0a000000-0000-7000-8000-000000046011";
const SALE_APPROVED = "0a000000-0000-7000-8000-000000046012";
const SALE_OTHER = "0a000000-0000-7000-8000-000000046013";
const SALE_T2 = "0a000000-0000-7000-8000-000000046014";
const APPROVAL = "0a000000-0000-7000-8000-0000000460a1";

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

async function applyBefore0046(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
  await ensureAppRole(pgEnv);
}

/** A sale row to seed: its identity and the tenant/store it belongs to. */
interface SaleSeed {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly externalId: string;
}

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

interface Approval {
  readonly approvalId: string | null;
  readonly approvedBy: string | null;
  readonly requestedBy: string | null;
  readonly policyVersion: string | null;
  readonly approvedAt: string | null;
  readonly voidBusinessDate: string | null;
}

const FULL: Approval = {
  approvalId: APPROVAL,
  approvedBy: APPROVER,
  requestedBy: ACTOR,
  policyVersion: "rt114-2026-10-07",
  approvedAt: "2026-10-01T10:05:00Z",
  voidBusinessDate: "2026-10-01",
};

/** A void row to seed against one of the seeded sales; no `approval` = a legacy void. */
interface VoidSeed {
  readonly id: string;
  readonly sale: SaleSeed;
  readonly externalId: string;
  readonly approval?: Approval;
}

async function insertVoid({ id, sale, externalId, approval }: VoidSeed): Promise<void> {
  const base = [id, sale.id, sale.tenantId, sale.storeId, externalId, "d".repeat(64), ACTOR];
  if (approval === undefined) {
    await pg().admin.query(
      `INSERT INTO sale_voids
         (id, sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, $4, '2026-10-01', 'pos-1', $5, $6, $7)`,
      base,
    );
    return;
  }
  await pg().admin.query(
    `INSERT INTO sale_voids
       (id, sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash, created_by,
        approval_id, approved_by_user_id, requested_by_user_id, approval_policy_version, approved_at, void_business_date)
     VALUES ($1, $2, $3, $4, '2026-10-01', 'pos-1', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      ...base,
      approval.approvalId,
      approval.approvedBy,
      approval.requestedBy,
      approval.policyVersion,
      approval.approvedAt,
      approval.voidBusinessDate,
    ],
  );
}

/** The seeded sales. */
const SALE = {
  legacy: { id: SALE_LEGACY, tenantId: TENANT, storeId: STORE, externalId: "rt530-legacy-sale" },
  legacy2: { id: "0a000000-0000-7000-8000-000000046015", tenantId: TENANT, storeId: STORE, externalId: "rt530-legacy-2-sale" },
  approved: { id: SALE_APPROVED, tenantId: TENANT, storeId: STORE, externalId: "rt530-approved-sale" },
  other: { id: SALE_OTHER, tenantId: TENANT, storeId: STORE, externalId: "rt530-other-sale" },
  tenant2: { id: SALE_T2, tenantId: TENANT_2, storeId: STORE_2, externalId: "rt530-t2-sale" },
} as const satisfies Record<string, SaleSeed>;

/** The void ids, by what each test inserts. */
const VOID_ID = {
  legacy: "0a000000-0000-7000-8000-000000046021",
  legacy2: "0a000000-0000-7000-8000-000000046022",
  approved: "0a000000-0000-7000-8000-000000046023",
  partial: "0a000000-0000-7000-8000-000000046031",
  reuse: "0a000000-0000-7000-8000-000000046032",
  tenant2: "0a000000-0000-7000-8000-000000046033",
} as const;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0046-sale-void-approval.spec] Docker NOT AVAILABLE - skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0046(env);
  await env.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'RT-530 tenant', 'rt530-tenant'), ($2, 'RT-530 tenant 2', 'rt530-tenant-2')`,
    [TENANT, TENANT_2],
  );
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'rt530', 'RT-530 store'), ($3, $4, 'rt530b', 'RT-530 store 2')`,
    [STORE, TENANT, STORE_2, TENANT_2],
  );
  // A pre-0046 void, written by the pre-RT-530 writer.
  await insertSale(SALE.legacy);
  await insertVoid({ id: VOID_ID.legacy, sale: SALE.legacy, externalId: "rt530-legacy-void" });
  await env.admin.query(readFileSync(UP_PATH, "utf8"));
  await insertSale(SALE.approved);
  await insertSale(SALE.other);
  await insertSale(SALE.tenant2);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => env === null;

describe("0046_sale_void_approval - upgrade over an existing void", () => {
  it("leaves the existing void with no approval and its business_date untouched (no backfill)", async () => {
    if (skip()) return;
    const r = await pg().admin.query(
      `SELECT approval_id, approved_by_user_id, requested_by_user_id, approval_policy_version,
              approved_at, void_business_date, business_date::text AS business_date
         FROM sale_voids WHERE sale_id = $1`,
      [SALE_LEGACY],
    );
    expect(r.rows).toEqual([
      {
        approval_id: null,
        approved_by_user_id: null,
        requested_by_user_id: null,
        approval_policy_version: null,
        approved_at: null,
        void_business_date: null,
        business_date: "2026-10-01",
      },
    ]);
  });

  it("still accepts a legacy void with no approval columns", async () => {
    if (skip()) return;
    await insertSale(SALE.legacy2);
    await expect(
      insertVoid({ id: VOID_ID.legacy2, sale: SALE.legacy2, externalId: "rt530-legacy-void-2" }),
    ).resolves.toBeUndefined();
  });
});

describe("0046_sale_void_approval - approval evidence", () => {
  it("stores a complete approval", async () => {
    if (skip()) return;
    await insertVoid({ id: VOID_ID.approved, sale: SALE.approved, externalId: "rt530-approved-void", approval: FULL });
    const r = await pg().admin.query(
      `SELECT approval_id::text, approved_by_user_id::text, requested_by_user_id::text,
              approval_policy_version, void_business_date::text
         FROM sale_voids WHERE sale_id = $1`,
      [SALE_APPROVED],
    );
    expect(r.rows).toEqual([
      {
        approval_id: APPROVAL,
        approved_by_user_id: APPROVER,
        requested_by_user_id: ACTOR,
        approval_policy_version: "rt114-2026-10-07",
        void_business_date: "2026-10-01",
      },
    ]);
  });

  it.each([
    ["approval_id", { ...FULL, approvalId: null }],
    ["approved_by_user_id", { ...FULL, approvedBy: null }],
    ["requested_by_user_id", { ...FULL, requestedBy: null }],
    ["approval_policy_version", { ...FULL, policyVersion: null }],
    ["approved_at", { ...FULL, approvedAt: null }],
    ["void_business_date", { ...FULL, voidBusinessDate: null }],
  ])("rejects an approval missing %s (all-or-none)", async (column, approval) => {
    if (skip()) return;
    await expect(
      insertVoid({ id: VOID_ID.partial, sale: SALE.other, externalId: `rt530-partial-${column}`, approval }),
    ).rejects.toThrow(/sale_voids_approval_all_or_none/);
  });

  it("makes an approval id single-use within a tenant", async () => {
    if (skip()) return;
    await expect(
      insertVoid({ id: VOID_ID.reuse, sale: SALE.other, externalId: "rt530-reuse-void", approval: FULL }),
    ).rejects.toThrow(/uq_sale_voids_tenant_approval/);
  });

  it("allows the same approval id in another tenant", async () => {
    if (skip()) return;
    await expect(
      insertVoid({ id: VOID_ID.tenant2, sale: SALE.tenant2, externalId: "rt530-t2-void", approval: FULL }),
    ).resolves.toBeUndefined();
  });

  it("keeps sale_voids append-only: the app role has no UPDATE or DELETE path", async () => {
    if (skip()) return;
    const policies = await pg().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = 'sale_voids' ORDER BY cmd`,
    );
    expect(policies.rows.map((p) => p.cmd)).toEqual(["INSERT", "SELECT"]);
  });
});

describe("0046_sale_void_approval - down -> up round-trip", () => {
  it("down drops only the new columns, keeps every void row, and up re-applies cleanly", async () => {
    if (skip()) return;
    const before = await pg().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM sale_voids`);
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    const cols = await pg().admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_name = 'sale_voids'
          AND column_name IN ('approval_id', 'approved_by_user_id', 'requested_by_user_id',
                              'approval_policy_version', 'approved_at', 'void_business_date')`,
    );
    expect(cols.rows[0]?.n).toBe("0");
    const after = await pg().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM sale_voids`);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);

    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    const again = await pg().admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_name = 'sale_voids' AND column_name = 'approval_id'`,
    );
    expect(again.rows[0]?.n).toBe("1");
  });
});
