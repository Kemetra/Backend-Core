/**
 * RT-327 — `0068_pos_device_health` migration test.
 *
 * Validates `packages/db/drizzle/0068_pos_device_health.sql` (+ `.down.sql`):
 *   - `device_health` and `pos_version_policy` exist with RLS enabled + FORCED;
 *     SELECT + INSERT + UPDATE policies and NO DELETE policy on both;
 *   - device_health: one row per device (23505), FK to devices (23503), and
 *     bounded self-reported fields (version pattern, channel and state enums,
 *     schema_head pattern: 23514); no PII / secret / free-text column;
 *   - pos_version_policy: channel enum, revision >= 1, version patterns (23514);
 *   - fail-closed tenant RLS on device_health: another tenant sees nothing, an
 *     unset GUC sees nothing (no 22P02), and a tenant context can neither
 *     insert nor update a row for another tenant's device (even when it
 *     writes its own tenant id);
 *   - pos_version_policy: readable in any context, writable only with
 *     `app.is_platform_admin = 'true'`;
 *   - FORCE RLS binds the TABLE OWNER when it is not a superuser: a
 *     non-superuser owner sees nothing without a tenant and cannot write past
 *     the policies;
 *   - UP -> DOWN -> UP round-trips; the down drops ONLY the two new tables.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { Pool, type PoolClient } from "pg";

import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_PATH = resolve(DRIZZLE_DIR, "0068_pos_device_health.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0068_pos_device_health.down.sql");

const TENANT_A = "03680000-0000-7000-8000-00000000a001";
const TENANT_B = "03680000-0000-7000-8000-00000000b001";
const STORE_A = "03680000-0000-7000-8000-00000000a002";
const STORE_B = "03680000-0000-7000-8000-00000000b002";
const DEV_A1 = "03680000-0000-7000-8000-00000000a0d1";
const DEV_A2 = "03680000-0000-7000-8000-00000000a0d2";
const DEV_B1 = "03680000-0000-7000-8000-00000000b0d1";
const ADMIN_USER = "03680000-0000-7000-8000-00000000c001";

const OWNER_ROLE = "rt327_owner";
const OWNER_PASSWORD = "rt327_owner";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

/** Apply every migration with a basename lexically < 0068. */
async function applyPreMigrations(pgEnv: PgTestEnv): Promise<void> {
  const guardBasename = basename(UP_PATH);
  const upFiles = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(guardBasename) < 0)
    .sort();
  for (const name of upFiles) await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  await ensureAppRole(pgEnv);
}

async function seedParents(pgEnv: PgTestEnv): Promise<void> {
  const a = pgEnv.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES
       ($1, 'dh-a', 'Health A', 'USD'), ($2, 'dh-b', 'Health B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'dh@fixture.invalid', NULL)`, [ADMIN_USER]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'A', 'A'), ($2, $4, 'B', 'B')`, [STORE_A, STORE_B, TENANT_A, TENANT_B]);
  for (const [id, tenant, store] of [
    [DEV_A1, TENANT_A, STORE_A],
    [DEV_A2, TENANT_A, STORE_A],
    [DEV_B1, TENANT_B, STORE_B],
  ] as const) {
    await a.query(`INSERT INTO devices (id, tenant_id, store_id, token_hash) VALUES ($1::uuid, $2, $3, decode(md5($1::text), 'hex'))`, [id, tenant, store]);
  }
}

/** Run `work` in a transaction as `client`'s role with the tenant GUCs set; rolls back. */
async function asContext<T>(
  client: PoolClient,
  ctx: { tenant?: string; platformAdmin?: boolean },
  work: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    if (ctx.tenant !== undefined) await client.query("SELECT set_config('app.current_tenant', $1, true)", [ctx.tenant]);
    await client.query("SELECT set_config('app.is_platform_admin', $1, true)", [ctx.platformAdmin === true ? "true" : "false"]);
    return await work();
  } finally {
    await client.query("ROLLBACK");
  }
}

async function withApp<T>(ctx: { tenant?: string; platformAdmin?: boolean }, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await guard().app.connect();
  try {
    return await asContext(client, ctx, () => work(client));
  } finally {
    client.release();
  }
}

const insertHealthSql = `INSERT INTO device_health (device_id, tenant_id, last_seen_at) VALUES ($1, $2, now())`;

function insertHealth(
  pgEnv: PgTestEnv,
  opts: { device?: string; tenant?: string } & Partial<Record<"app_version" | "update_channel" | "update_state" | "pending_version" | "schema_head", string | null>> = {},
): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO device_health
       (device_id, tenant_id, last_seen_at, app_version, update_channel, update_state, pending_version, schema_head)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7)`,
    [
      opts.device ?? DEV_A1,
      opts.tenant ?? TENANT_A,
      opts.app_version ?? null,
      opts.update_channel ?? null,
      opts.update_state ?? null,
      opts.pending_version ?? null,
      opts.schema_head ?? null,
    ],
  );
}

function insertPolicy(pgEnv: PgTestEnv, over: Partial<Record<"channel" | "latest" | "recommended" | "min", string>> & { revision?: number } = {}): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO pos_version_policy
       (channel, latest_version, recommended_version, min_supported_version, min_supported_grace_until, revision, updated_by_user_id)
     VALUES ($1, $2, $3, $4, now(), $5, $6)`,
    [over.channel ?? "stable", over.latest ?? "1.5.0", over.recommended ?? "1.4.2", over.min ?? "1.4.0", over.revision ?? 1, ADMIN_USER],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyPreMigrations(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0068-pos-device-health.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  // Re-grant AFTER 0068: ensureAppRole's GRANT ON ALL TABLES only covers tables that exist at grant time.
  await ensureAppRole(env);
  await seedParents(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0068: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0068: tables, policies and columns", () => {
  it.each(["device_health", "pos_version_policy"])("%s has RLS enabled + forced", async (table) => {
    if (skip()) return;
    const t = await guard().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [table],
    );
    expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it.each(["device_health", "pos_version_policy"])("%s has SELECT + INSERT + UPDATE policies and NO DELETE policy", async (table) => {
    if (skip()) return;
    const pol = await guard().admin.query<{ cmd: string }>(`SELECT cmd FROM pg_policies WHERE tablename = $1`, [table]);
    expect(pol.rows.map((r) => r.cmd).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("device_health holds no PII, secret, money or free-text column", async () => {
    if (skip()) return;
    const cols = await guard().admin.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'device_health'`);
    const names = cols.rows.map((r) => r.column_name).sort();
    expect(names).toEqual(
      [
        "app_version",
        "created_at",
        "device_id",
        "last_seen_at",
        "pending_version",
        "schema_head",
        "source_clock_at",
        "tenant_id",
        "update_channel",
        "update_state",
        "updated_at",
      ].sort(),
    );
  });

  it("pos_version_policy has no tenant column and records the author as a user id", async () => {
    if (skip()) return;
    const cols = await guard().admin.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'pos_version_policy'`);
    const names = cols.rows.map((r) => r.column_name);
    expect(names).not.toContain("tenant_id");
    expect(names).toContain("updated_by_user_id");
    expect(names).not.toContain("email");
  });
});

describe("0068: device_health constraints", () => {
  beforeEach(async () => {
    if (skip()) return;
    await guard().admin.query(`DELETE FROM device_health`);
  });

  it("is one row per device (23505)", async () => {
    if (skip()) return;
    await expect(insertHealth(guard(), { device: DEV_A1 })).resolves.toBeDefined();
    await expect(insertHealth(guard(), { device: DEV_A1 })).rejects.toMatchObject({ code: "23505" });
    await expect(insertHealth(guard(), { device: DEV_A2 })).resolves.toBeDefined();
  });

  it("refuses a dangling device (23503) and a missing last_seen_at (23502)", async () => {
    if (skip()) return;
    await expect(insertHealth(guard(), { device: "03680000-0000-7000-8000-0000000000ff" })).rejects.toMatchObject({ code: "23503" });
    await expect(guard().admin.query(`INSERT INTO device_health (device_id, tenant_id) VALUES ($1, $2)`, [DEV_A1, TENANT_A])).rejects.toMatchObject({ code: "23502" });
  });

  it("RESTRICTs deleting a device that has a health row (23503)", async () => {
    if (skip()) return;
    await insertHealth(guard(), { device: DEV_A1 });
    await expect(guard().admin.query(`DELETE FROM devices WHERE id = $1`, [DEV_A1])).rejects.toMatchObject({ code: "23503" });
  });

  it.each([
    ["app_version", "1.4"],
    ["app_version", "1.4.0+build.5"],
    ["app_version", "01.4.0"],
    ["app_version", `1.4.0-${"a".repeat(30)}`],
    ["pending_version", "latest"],
    ["update_channel", "beta"],
    ["update_state", "sleeping"],
    ["schema_head", "../etc/passwd"],
    ["schema_head", ""],
    ["schema_head", "x".repeat(65)],
  ])("refuses %s = %j (23514)", async (column, value) => {
    if (skip()) return;
    await expect(insertHealth(guard(), { [column]: value })).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts every field null, and a full valid beat", async () => {
    if (skip()) return;
    await expect(insertHealth(guard(), { device: DEV_A1 })).resolves.toBeDefined();
    await expect(
      insertHealth(guard(), {
        device: DEV_A2,
        app_version: "1.4.0-rc.1",
        update_channel: "canary",
        update_state: "compat_blocked",
        pending_version: "1.4.1",
        schema_head: "0042_local_outbox",
      }),
    ).resolves.toBeDefined();
  });
});

describe("0068: pos_version_policy constraints", () => {
  beforeEach(async () => {
    if (skip()) return;
    await guard().admin.query(`DELETE FROM pos_version_policy`);
  });

  it("is one row per channel (23505) and refuses an unknown channel (23514)", async () => {
    if (skip()) return;
    await expect(insertPolicy(guard())).resolves.toBeDefined();
    await expect(insertPolicy(guard())).rejects.toMatchObject({ code: "23505" });
    await expect(insertPolicy(guard(), { channel: "beta" })).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a revision below 1, a malformed version and a dangling author", async () => {
    if (skip()) return;
    await expect(insertPolicy(guard(), { revision: 0 })).rejects.toMatchObject({ code: "23514" });
    await expect(insertPolicy(guard(), { latest: "1.5" })).rejects.toMatchObject({ code: "23514" });
    await expect(insertPolicy(guard(), { recommended: "1.4.2+b" })).rejects.toMatchObject({ code: "23514" });
    await expect(insertPolicy(guard(), { min: "x" })).rejects.toMatchObject({ code: "23514" });
    await expect(
      guard().admin.query(
        `INSERT INTO pos_version_policy (channel, latest_version, recommended_version, min_supported_version, min_supported_grace_until, updated_by_user_id)
         VALUES ('lab', '1.0.0', '1.0.0', '1.0.0', now(), '03680000-0000-7000-8000-0000000000ee')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("0068: device_health tenant RLS (app role, NOBYPASSRLS)", () => {
  beforeEach(async () => {
    if (skip()) return;
    await guard().admin.query(`DELETE FROM device_health`);
    await insertHealth(guard(), { device: DEV_A1, tenant: TENANT_A });
  });

  it("shows a row to its own tenant only, and to nobody without a tenant", async () => {
    if (skip()) return;
    expect((await withApp({ tenant: TENANT_A }, (c) => c.query(`SELECT device_id FROM device_health`))).rows).toEqual([{ device_id: DEV_A1 }]);
    expect((await withApp({ tenant: TENANT_B }, (c) => c.query(`SELECT device_id FROM device_health`))).rows).toEqual([]);
    expect((await withApp({}, (c) => c.query(`SELECT device_id FROM device_health`))).rows).toEqual([]);
  });

  it("lets a tenant write a row for its own device", async () => {
    if (skip()) return;
    await expect(withApp({ tenant: TENANT_A }, (c) => c.query(insertHealthSql, [DEV_A2, TENANT_A]))).resolves.toBeDefined();
  });

  it("refuses a row for another tenant's device, whichever tenant id it writes", async () => {
    if (skip()) return;
    // Its own tenant id on another tenant's device: the same-tenant device check fails.
    await expect(withApp({ tenant: TENANT_A }, (c) => c.query(insertHealthSql, [DEV_B1, TENANT_A]))).rejects.toMatchObject({ code: "42501" });
    // The other tenant's id: the tenant check fails.
    await expect(withApp({ tenant: TENANT_A }, (c) => c.query(insertHealthSql, [DEV_B1, TENANT_B]))).rejects.toMatchObject({ code: "42501" });
    await expect(withApp({ tenant: TENANT_B }, (c) => c.query(insertHealthSql, [DEV_A2, TENANT_B]))).rejects.toMatchObject({ code: "42501" });
    await expect(withApp({ tenant: TENANT_B }, (c) => c.query(insertHealthSql, [DEV_A2, TENANT_A]))).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses an upsert that would move a row to another tenant or device", async () => {
    if (skip()) return;
    const upsert = (tenant: string) =>
      withApp({ tenant }, (c) =>
        c.query(
          `INSERT INTO device_health (device_id, tenant_id, last_seen_at) VALUES ($1, $2, now())
           ON CONFLICT (device_id) DO UPDATE SET last_seen_at = now(), app_version = '9.9.9'`,
          [DEV_A1, tenant],
        ),
      );
    // Tenant B cannot reach tenant A's row: its own insert is refused outright.
    await expect(upsert(TENANT_B)).rejects.toMatchObject({ code: "42501" });
    const stored = await guard().admin.query(`SELECT app_version FROM device_health WHERE device_id = $1`, [DEV_A1]);
    expect(stored.rows).toEqual([{ app_version: null }]);
  });

  it("updates nothing of another tenant, and cannot repoint a row at another tenant", async () => {
    if (skip()) return;
    const asB = await withApp({ tenant: TENANT_B }, (c) => c.query(`UPDATE device_health SET app_version = '6.6.6'`));
    expect(asB.rowCount).toBe(0);
    await expect(withApp({ tenant: TENANT_A }, (c) => c.query(`UPDATE device_health SET tenant_id = $1`, [TENANT_B]))).rejects.toMatchObject({ code: "42501" });
    await expect(withApp({ tenant: TENANT_A }, (c) => c.query(`UPDATE device_health SET device_id = $1`, [DEV_B1]))).rejects.toMatchObject({ code: "42501" });
  });

  it("deletes nothing: there is no DELETE policy", async () => {
    if (skip()) return;
    const del = await withApp({ tenant: TENANT_A }, (c) => c.query(`DELETE FROM device_health`));
    expect(del.rowCount).toBe(0);
  });
});

describe("0068: pos_version_policy RLS (app role, NOBYPASSRLS)", () => {
  beforeEach(async () => {
    if (skip()) return;
    await guard().admin.query(`DELETE FROM pos_version_policy`);
    await insertPolicy(guard());
  });

  const policyInsert = `INSERT INTO pos_version_policy
    (channel, latest_version, recommended_version, min_supported_version, min_supported_grace_until, revision, updated_by_user_id)
    VALUES ('lab', '1.0.0', '1.0.0', '1.0.0', now(), 1, $1)`;

  it("is readable in a tenant context, with no tenant and as a platform admin", async () => {
    if (skip()) return;
    for (const ctx of [{ tenant: TENANT_A }, {}, { platformAdmin: true }]) {
      expect((await withApp(ctx, (c) => c.query(`SELECT channel FROM pos_version_policy`))).rows).toEqual([{ channel: "stable" }]);
    }
  });

  it("refuses a tenant context, and an empty context, an INSERT or an UPDATE", async () => {
    if (skip()) return;
    for (const ctx of [{ tenant: TENANT_A }, {}]) {
      await expect(withApp(ctx, (c) => c.query(policyInsert, [ADMIN_USER]))).rejects.toMatchObject({ code: "42501" });
      const update = await withApp(ctx, (c) => c.query(`UPDATE pos_version_policy SET min_supported_version = '0.0.1'`));
      expect(update.rowCount).toBe(0);
    }
    const stored = await guard().admin.query(`SELECT min_supported_version FROM pos_version_policy`);
    expect(stored.rows).toEqual([{ min_supported_version: "1.4.0" }]);
  });

  it("lets the platform-admin context insert and update", async () => {
    if (skip()) return;
    await expect(withApp({ platformAdmin: true }, (c) => c.query(policyInsert, [ADMIN_USER]))).resolves.toBeDefined();
    const update = await withApp({ platformAdmin: true }, (c) => c.query(`UPDATE pos_version_policy SET revision = revision + 1 WHERE channel = 'stable'`));
    expect(update.rowCount).toBe(1);
  });

  it("deletes nothing in any context: there is no DELETE policy", async () => {
    if (skip()) return;
    for (const ctx of [{ tenant: TENANT_A }, { platformAdmin: true }]) {
      const del = await withApp(ctx, (c) => c.query(`DELETE FROM pos_version_policy`));
      expect(del.rowCount).toBe(0);
    }
  });
});

describe("0068: FORCE RLS binds a non-superuser table owner", () => {
  let ownerPool: Pool | null = null;

  beforeAll(async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`CREATE ROLE ${OWNER_ROLE} LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await e.admin.query(`GRANT USAGE ON SCHEMA public TO ${OWNER_ROLE}`);
    await e.admin.query(`GRANT SELECT ON devices, tenants, users TO ${OWNER_ROLE}`);
    await e.admin.query(`ALTER TABLE device_health OWNER TO ${OWNER_ROLE}`);
    await e.admin.query(`ALTER TABLE pos_version_policy OWNER TO ${OWNER_ROLE}`);
    const url = new URL(e.adminUri);
    url.username = OWNER_ROLE;
    url.password = OWNER_PASSWORD;
    ownerPool = new Pool({ connectionString: url.toString() });
    ownerPool.on("error", () => undefined);
  });

  afterAll(async () => {
    await ownerPool?.end();
    if (!env || skip()) return;
    // Hand the tables back so the round-trip below runs as the migration owner.
    await env.admin.query(`ALTER TABLE device_health OWNER TO CURRENT_USER`);
    await env.admin.query(`ALTER TABLE pos_version_policy OWNER TO CURRENT_USER`);
  });

  async function asOwner<T>(ctx: { tenant?: string; platformAdmin?: boolean }, work: (c: PoolClient) => Promise<T>): Promise<T> {
    if (!ownerPool) throw new Error("owner pool not ready");
    const client = await ownerPool.connect();
    try {
      return await asContext(client, ctx, () => work(client));
    } finally {
      client.release();
    }
  }

  it("is the owner, not a superuser, and the policies still apply to it", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`DELETE FROM device_health`);
    await insertHealth(e, { device: DEV_A1, tenant: TENANT_A });
    const who = await asOwner({}, (c) => c.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    ));
    expect(who.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owner = await e.admin.query<{ owner: string }>(`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'device_health'`);
    expect(owner.rows[0]?.owner).toBe(OWNER_ROLE);
    // The owner sees nothing without a tenant, and only its tenant's row with one.
    expect((await asOwner({}, (c) => c.query(`SELECT 1 FROM device_health`))).rowCount).toBe(0);
    expect((await asOwner({ tenant: TENANT_B }, (c) => c.query(`SELECT 1 FROM device_health`))).rowCount).toBe(0);
    expect((await asOwner({ tenant: TENANT_A }, (c) => c.query(`SELECT 1 FROM device_health`))).rowCount).toBe(1);
    // ... and cannot write past the policies.
    await expect(asOwner({ tenant: TENANT_A }, (c) => c.query(insertHealthSql, [DEV_B1, TENANT_A]))).rejects.toMatchObject({ code: "42501" });
    await expect(asOwner({ tenant: TENANT_A }, (c) => c.query(policyInsertSql(), [ADMIN_USER]))).rejects.toMatchObject({ code: "42501" });
    expect((await asOwner({ tenant: TENANT_A }, (c) => c.query(`DELETE FROM device_health`))).rowCount).toBe(0);
  });
});

function policyInsertSql(): string {
  return `INSERT INTO pos_version_policy
    (channel, latest_version, recommended_version, min_supported_version, min_supported_grace_until, revision, updated_by_user_id)
    VALUES ('lab', '1.0.0', '1.0.0', '1.0.0', now(), 1, $1)`;
}

describe("0068: UP -> DOWN -> UP", () => {
  const TABLES = ["device_health", "pos_version_policy"];

  async function exists(table: string): Promise<boolean> {
    const r = await guard().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_class WHERE relname = $1 AND relkind = 'r'`, [table]);
    return r.rows[0]?.n === "1";
  }

  it("drops ONLY the two new tables, and comes back", async () => {
    if (skip()) return;
    const e = guard();
    const before = await e.admin.query<{ relname: string }>(`SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY 1`);
    await e.admin.query(downSql);
    const after = await e.admin.query<{ relname: string }>(`SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY 1`);
    for (const t of TABLES) expect(await exists(t)).toBe(false);
    expect(before.rows.map((r) => r.relname).filter((n) => !after.rows.some((a) => a.relname === n))).toEqual([...TABLES].sort());
    expect(after.rows.some((r) => r.relname === "devices")).toBe(true);
    // The down is rerunnable.
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    for (const t of TABLES) expect(await exists(t)).toBe(true);
    const pol = await e.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_policies WHERE tablename = ANY($1)`, [TABLES]);
    expect(pol.rows[0]?.n).toBe("6");
  });
});
