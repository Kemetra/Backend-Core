/**
 * 0066 — pending-aware 017 reconciliation classes (Jira RT-428; owner
 * authorization RT-428 comment 13281, vocabulary owner-chosen 2026-10-21).
 *
 * Applies every migration before 0066 against a real Postgres, seeds a run
 * with a result of every 0020 class, applies 0066 exactly as the runner does
 * (one `query()` for the file), and proves:
 *   - every existing result survives unchanged, and the widened CHECK is
 *     validated;
 *   - the four new classes are accepted; an unknown class is still refused;
 *   - down refuses while a 0066-class result exists (results are evidence,
 *     never deleted to fit), then narrows the CHECK and round-trips with up.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0066_reconciliation_pending_aware_classes.sql";
const UP_SQL = (): string => readFileSync(resolve(DRIZZLE_DIR, UP_NAME), "utf8");
const DOWN_SQL = (): string =>
  readFileSync(resolve(DRIZZLE_DIR, "0066_reconciliation_pending_aware_classes.down.sql"), "utf8");

const TENANT = "0a000000-0000-7000-8000-000000042801";
const STORE = "0a000000-0000-7000-8000-000000042802";
const RUN = "0a000000-0000-7000-8000-000000042803";

const LEGACY_CLASSES = [
  "match",
  "quantity_divergence",
  "unmapped_store",
  "unmapped_item",
  "dp2_only",
  "erpnext_only",
  "negative_balance_flagged",
];
const NEW_CLASSES = ["expected_pending_erp", "expected_pending_retail", "erp_snapshot_stale", "uom_mismatch"];

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

async function insertResult(mismatchClass: string): Promise<void> {
  await pg().admin.query(
    `INSERT INTO erpnext_reconciliation_result (id, run_id, tenant_id, mismatch_class, result_state)
     VALUES (gen_random_uuid(), $1, $2, $3, 'open')`,
    [RUN, TENANT, mismatchClass],
  );
}

async function classes(): Promise<string[]> {
  const r = await pg().admin.query<{ mismatch_class: string }>(
    `SELECT mismatch_class FROM erpnext_reconciliation_result ORDER BY mismatch_class`,
  );
  return r.rows.map((row) => row.mismatch_class);
}

async function checkValidated(): Promise<boolean> {
  const r = await pg().admin.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint WHERE conname = 'erpnext_reconciliation_result_class_valid'`,
  );
  return r.rows[0]!.convalidated;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0066 spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) await env.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  await ensureAppRole(env);
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt428-mig', 'T')`, [TENANT]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S', 'S')`, [STORE, TENANT]);
  await a.query(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, finished_at)
     VALUES ($1, $2, $3, 'stock', 'on_demand', 'completed', now())`,
    [RUN, TENANT, STORE],
  );
  for (const c of LEGACY_CLASSES) await insertResult(c);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0066 up", () => {
  it("refuses the new classes before it is applied", async () => {
    if (skip()) return;
    await expect(insertResult("expected_pending_erp")).rejects.toThrow(/erpnext_reconciliation_result_class_valid/);
  });

  it("keeps every existing result and validates the widened CHECK", async () => {
    if (skip()) return;
    await pg().admin.query(UP_SQL());
    expect(await classes()).toEqual([...LEGACY_CLASSES].sort());
    expect(await checkValidated()).toBe(true);
  });

  it("accepts the four new classes and still refuses an unknown one", async () => {
    if (skip()) return;
    for (const c of NEW_CLASSES) await insertResult(c);
    await expect(insertResult("pending")).rejects.toThrow(/erpnext_reconciliation_result_class_valid/);
  });
});

describe("0066 down", () => {
  it("refuses while a result carries a 0066 class, and changes nothing", async () => {
    if (skip()) return;
    await expect(pg().admin.query(DOWN_SQL())).rejects.toThrow(/0066 down refused: 4/);
    await pg().admin.query("ROLLBACK").catch(() => undefined);
    expect(await classes()).toHaveLength(LEGACY_CLASSES.length + NEW_CLASSES.length);
  });

  it("narrows the CHECK once no 0066 class remains, and round-trips with up", async () => {
    if (skip()) return;
    await pg().admin.query(`DELETE FROM erpnext_reconciliation_result WHERE mismatch_class = ANY($1::text[])`, [NEW_CLASSES]);
    await pg().admin.query(DOWN_SQL());
    await expect(insertResult("uom_mismatch")).rejects.toThrow(/erpnext_reconciliation_result_class_valid/);
    expect(await classes()).toEqual([...LEGACY_CLASSES].sort());
    await pg().admin.query(UP_SQL());
    await insertResult("uom_mismatch");
    expect(await checkValidated()).toBe(true);
  });
});
