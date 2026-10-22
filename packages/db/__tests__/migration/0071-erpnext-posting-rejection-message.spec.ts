/**
 * 0071 — the Connector's rejection message on a dead-lettered posting row
 * (Jira RT-410, AD-POSTING-001 D-1 to D-5; [GATED] migration).
 *
 * Applies every migration before 0071 against a real Postgres, seeds a pending,
 * a posted and a dead-lettered posting intent, applies 0071 exactly as the
 * runner does (one `query()` for the file), and proves:
 *   - every existing row survives with no message, and both CHECKs are
 *     validated;
 *   - a message is accepted only on a `permanently_rejected` row, 1..1000
 *     characters;
 *   - down drops the column and the CHECKs, and round-trips with up.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0071_erpnext_posting_rejection_message.sql";
const UP_SQL = (): string => readFileSync(resolve(DRIZZLE_DIR, UP_NAME), "utf8");
const DOWN_SQL = (): string =>
  readFileSync(resolve(DRIZZLE_DIR, "0071_erpnext_posting_rejection_message.down.sql"), "utf8");

const TENANT = "0a000000-0000-7000-8000-000000041001";
const STORE = "0a000000-0000-7000-8000-000000041002";
const ACTOR = "0a000000-0000-7000-8000-000000041003";
const CHECKS = [
  "erpnext_posting_status_rejection_message_length",
  "erpnext_posting_status_rejection_message_when_rejected",
];

let env: PgTestEnv | null = null;
const ids: Record<"pending" | "posted" | "permanently_rejected", string> = {
  pending: "",
  posted: "",
  permanently_rejected: "",
};

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

/** One sale and its posting intent with `status`; returns the intent id. */
async function seedPosting(status: keyof typeof ids): Promise<string> {
  const sale = await pg().admin.query<{ id: string }>(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by)
     VALUES (gen_random_uuid(), $1, $2, 'EGP', 10, now(), current_date, 'pos-0071', $3, repeat('c', 64), $4)
     RETURNING id`,
    [TENANT, STORE, `sale-${status}`, ACTOR],
  );
  const saleId = sale.rows[0]!.id;
  const intent = await pg().admin.query<{ id: string }>(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id,
        payload_hash, status, document_ref, rejection_category)
     VALUES (gen_random_uuid(), $1, $2, $3, 'sale_post', $3, 'pos-0071', $4, repeat('a', 64), $5,
             CASE WHEN $5 = 'posted' THEN 'SINV-0071' END,
             CASE WHEN $5 = 'permanently_rejected' THEN 'validation' END)
     RETURNING id`,
    [TENANT, STORE, saleId, `sale-${status}`, status],
  );
  return intent.rows[0]!.id;
}

/** The SQLSTATE `fn` fails with, or null. */
async function codeOf(sql: string, params: unknown[]): Promise<string | null> {
  try {
    await pg().admin.query(sql, params);
    return null;
  } catch (err: unknown) {
    return (err as { code?: string }).code ?? String(err);
  }
}

const setMessage = (id: string, message: string): Promise<string | null> =>
  codeOf(`UPDATE erpnext_posting_status SET rejection_message = $2 WHERE id = $1`, [id, message]);

async function validatedChecks(): Promise<string[]> {
  const r = await pg().admin.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[]) AND convalidated ORDER BY conname`,
    [CHECKS],
  );
  return r.rows.map((row) => row.conname);
}

async function hasColumn(): Promise<boolean> {
  const r = await pg().admin.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'erpnext_posting_status' AND column_name = 'rejection_message'`,
  );
  return r.rows.length === 1;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0071 spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
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
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt410-mig', 'T')`, [TENANT]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S', 'S')`, [STORE, TENANT]);
  await a.query(`INSERT INTO users (id, email) VALUES ($1, 'a@rt410.example')`, [ACTOR]);
  for (const status of Object.keys(ids) as Array<keyof typeof ids>) ids[status] = await seedPosting(status);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0071 up", () => {
  it("adds the nullable column; every existing row survives with no message; both CHECKs are validated", async () => {
    if (skip()) return;
    await pg().admin.query(UP_SQL());
    expect(await hasColumn()).toBe(true);
    const r = await pg().admin.query<{ status: string; message: string | null }>(
      `SELECT status, rejection_message AS message FROM erpnext_posting_status WHERE id = ANY($1::uuid[]) ORDER BY status`,
      [Object.values(ids)],
    );
    expect(r.rows).toEqual([
      { status: "pending", message: null },
      { status: "permanently_rejected", message: null },
      { status: "posted", message: null },
    ]);
    expect(await validatedChecks()).toEqual([...CHECKS].sort());
  });

  it("accepts a message on a dead-letter, up to 1000 characters", async () => {
    if (skip()) return;
    expect(await setMessage(ids.permanently_rejected, "NameError: name 'flt' is not defined")).toBeNull();
    expect(await setMessage(ids.permanently_rejected, "x".repeat(1000))).toBeNull();
  });

  it.each([
    ["a pending row", "pending", "x"],
    ["a posted row", "posted", "x"],
    ["an empty message", "permanently_rejected", ""],
    ["1001 characters", "permanently_rejected", "x".repeat(1001)],
  ] as const)("refuses %s (23514)", async (_label, status, message) => {
    if (skip()) return;
    expect(await setMessage(ids[status], message)).toBe("23514");
  });
});

describe("0071 down", () => {
  it("drops the column and both CHECKs, and round-trips with up", async () => {
    if (skip()) return;
    await pg().admin.query(DOWN_SQL());
    expect(await hasColumn()).toBe(false);
    expect(await validatedChecks()).toEqual([]);
    await pg().admin.query(UP_SQL());
    expect(await hasColumn()).toBe(true);
    expect(await validatedChecks()).toEqual([...CHECKS].sort());
  });
});
