/**
 * RT-719: `0073_device_build_identity` migration test.
 *
 * Validates `packages/db/drizzle/0073_device_build_identity.sql` (+ `.down.sql`):
 *   - four NULLABLE columns on `devices`, no default (unknown is never a
 *     default), and existing rows read NULL in all four;
 *   - every value is a bounded pattern (commit and pin 40 lower-case hex, the
 *     version a semantic version of at most 32 characters): 23514 otherwise;
 *   - the consistency CHECK: all NULL, or a commit with its server time; a
 *     version, a pin or a time alone is refused;
 *   - the existing tenant RLS on `devices` still isolates the new columns;
 *   - UP -> DOWN -> UP round-trips and the down drops ONLY the four columns
 *     and their constraints, leaving every other device column and row.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_PATH = resolve(DRIZZLE_DIR, "0073_device_build_identity.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0073_device_build_identity.down.sql");

const TENANT_A = "07300000-0000-7000-8000-00000000a001";
const TENANT_B = "07300000-0000-7000-8000-00000000b001";
const STORE_A = "07300000-0000-7000-8000-00000000a002";
const STORE_B = "07300000-0000-7000-8000-00000000b002";
const DEV_OLD = "07300000-0000-7000-8000-00000000a0d0";
const DEV_A = "07300000-0000-7000-8000-00000000a0d1";
const DEV_B = "07300000-0000-7000-8000-00000000b0d1";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PIN = "fedcba9876543210fedcba9876543210fedcba98";
const COLUMNS = ["build_reported_at", "reported_app_version", "reported_build_commit", "reported_contract_pin"];
const CONSTRAINTS = [
  "devices_build_identity_consistent",
  "devices_reported_app_version_shape",
  "devices_reported_build_commit_shape",
  "devices_reported_contract_pin_shape",
];

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

/** Apply every migration with a basename lexically < 0073. */
async function applyPreMigrations(pgEnv: PgTestEnv): Promise<void> {
  const guardBasename = basename(UP_PATH);
  const upFiles = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(guardBasename) < 0)
    .sort();
  for (const name of upFiles) await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  await ensureAppRole(pgEnv);
}

const INSERT_DEVICE = `INSERT INTO devices (id, tenant_id, store_id, token_hash) VALUES ($1::uuid, $2, $3, decode(md5($1::text), 'hex'))`;

async function seedParents(pgEnv: PgTestEnv): Promise<void> {
  const a = pgEnv.admin;
  await a.query(`INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'bi-a', 'Build A', 'USD'), ($2, 'bi-b', 'Build B', 'USD')`, [
    TENANT_A,
    TENANT_B,
  ]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'A', 'A'), ($2, $4, 'B', 'B')`, [STORE_A, STORE_B, TENANT_A, TENANT_B]);
  // A device that exists BEFORE 0073: it must read NULL in every new column.
  await a.query(INSERT_DEVICE, [DEV_OLD, TENANT_A, STORE_A]);
}

async function seedDevices(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(INSERT_DEVICE, [DEV_A, TENANT_A, STORE_A]);
  await pgEnv.admin.query(INSERT_DEVICE, [DEV_B, TENANT_B, STORE_B]);
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyPreMigrations(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0073-device-build-identity.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await seedParents(env);
  await env.admin.query(upSql);
  await ensureAppRole(env);
  await seedDevices(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

interface Identity {
  readonly commit?: string;
  readonly version?: string;
  readonly pin?: string;
  readonly stamped?: boolean;
}

async function setIdentity(id: string, identity: Identity): Promise<unknown> {
  return guard().admin.query(
    `UPDATE devices SET reported_build_commit = $2, reported_app_version = $3, reported_contract_pin = $4,
            build_reported_at = CASE WHEN $5::boolean THEN now() ELSE NULL END
      WHERE id = $1`,
    [id, identity.commit ?? null, identity.version ?? null, identity.pin ?? null, identity.stamped === true],
  );
}

describe("0073: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0073: the columns", () => {
  it("adds four nullable columns with no default, and a pre-existing device reads NULL in all of them", async () => {
    if (skip()) return;
    const cols = await guard().admin.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'devices' AND column_name = ANY($1) ORDER BY column_name`,
      [COLUMNS],
    );
    expect(cols.rows).toEqual(COLUMNS.map((column_name) => ({ column_name, is_nullable: "YES", column_default: null })));
    const old = await guard().admin.query(`SELECT ${COLUMNS.join(", ")} FROM devices WHERE id = $1`, [DEV_OLD]);
    expect(Object.values(old.rows[0] as Record<string, unknown>)).toEqual([null, null, null, null]);
  });

  it("declares the four CHECK constraints", async () => {
    if (skip()) return;
    const c = await guard().admin.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'devices'::regclass AND conname = ANY($1) ORDER BY conname`,
      [CONSTRAINTS],
    );
    expect(c.rows.map((r) => r.conname)).toEqual(CONSTRAINTS);
  });
});

describe("0073: bounded values and consistency", () => {
  beforeEach(async () => {
    if (skip()) return;
    await setIdentity(DEV_A, {});
  });

  it("stores a full identity, a commit alone, and the unknown (all NULL) state", async () => {
    if (skip()) return;
    await expect(setIdentity(DEV_A, { commit: COMMIT, version: "1.4.0-rc.1", pin: PIN, stamped: true })).resolves.toBeDefined();
    await expect(setIdentity(DEV_A, { commit: COMMIT, stamped: true })).resolves.toBeDefined();
    await expect(setIdentity(DEV_A, {})).resolves.toBeDefined();
  });

  it.each<[string, Identity]>([
    ["commit too short", { commit: COMMIT.slice(1), stamped: true }],
    ["commit upper case", { commit: COMMIT.toUpperCase(), stamped: true }],
    ["commit not hex", { commit: `${COMMIT.slice(1)}g`, stamped: true }],
    ["pin too long", { commit: COMMIT, pin: `${PIN}0`, stamped: true }],
    ["pin upper case", { commit: COMMIT, pin: PIN.toUpperCase(), stamped: true }],
    ["version without a patch", { commit: COMMIT, version: "1.4", stamped: true }],
    ["version with build metadata", { commit: COMMIT, version: "1.4.0+b.1", stamped: true }],
    ["version of 33 characters", { commit: COMMIT, version: `1.0.0-${"a".repeat(27)}`, stamped: true }],
  ])("refuses %s (23514)", async (_why, identity) => {
    if (skip()) return;
    await expect(setIdentity(DEV_A, identity)).rejects.toMatchObject({ code: "23514" });
  });

  it.each<[string, Identity]>([
    ["a version alone", { version: "1.4.0" }],
    ["a pin alone", { pin: PIN }],
    ["a time alone", { stamped: true }],
    ["a commit without its server time", { commit: COMMIT }],
    ["a version with no commit", { version: "1.4.0", stamped: true }],
  ])("refuses %s (23514)", async (_why, identity) => {
    if (skip()) return;
    await expect(setIdentity(DEV_A, identity)).rejects.toMatchObject({ code: "23514" });
  });
});

describe("0073: tenant isolation (the existing RLS on devices)", () => {
  it("shows a tenant its own identity only, and refuses a write to another tenant's device", async () => {
    if (skip()) return;
    await setIdentity(DEV_A, { commit: COMMIT, stamped: true });
    const client = await guard().app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [TENANT_B]);
      const seen = await client.query(`SELECT id, reported_build_commit FROM devices WHERE id = ANY($1)`, [[DEV_A, DEV_B]]);
      expect(seen.rows).toEqual([{ id: DEV_B, reported_build_commit: null }]);
      const write = await client.query(`UPDATE devices SET reported_build_commit = $1, build_reported_at = now() WHERE id = $2`, [COMMIT, DEV_A]);
      expect(write.rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const stored = await guard().admin.query(`SELECT reported_build_commit FROM devices WHERE id = $1`, [DEV_A]);
    expect(stored.rows).toEqual([{ reported_build_commit: COMMIT }]);
  });
});

describe("0073: UP -> DOWN -> UP", () => {
  it("drops ONLY the four columns and their constraints, keeps every device, and comes back", async () => {
    if (skip()) return;
    const e = guard();
    const columnNames = async (): Promise<string[]> =>
      (await e.admin.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'devices' ORDER BY column_name`)).rows.map(
        (r) => r.column_name,
      );
    const before = await columnNames();
    const rowsBefore = (await e.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM devices`)).rows[0]?.n;
    await e.admin.query(downSql);
    const after = await columnNames();
    expect(before.filter((c) => !after.includes(c))).toEqual(COLUMNS);
    expect(after).toHaveLength(before.length - COLUMNS.length);
    const left = await e.admin.query(`SELECT 1 FROM pg_constraint WHERE conrelid = 'devices'::regclass AND conname = ANY($1)`, [CONSTRAINTS]);
    expect(left.rowCount).toBe(0);
    expect((await e.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM devices`)).rows[0]?.n).toBe(rowsBefore);
    // The down is rerunnable, and the up brings every column back as unknown.
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    const back = await e.admin.query(`SELECT ${COLUMNS.join(", ")} FROM devices WHERE id = $1`, [DEV_A]);
    expect(Object.values(back.rows[0] as Record<string, unknown>)).toEqual([null, null, null, null]);
  });
});
