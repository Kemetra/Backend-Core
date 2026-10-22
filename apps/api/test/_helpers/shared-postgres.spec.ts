/**
 * RT-815 — shared Postgres server + per-file template clone.
 *
 * Jest globalSetup starts ONE container and builds the migrated
 * `rt_template` database; `startPgEnv()` clones a fresh database from it per
 * spec file instead of booting a container per file. Verifies:
 *   - a clone carries the full schema and the `app_test` role
 *   - two clones are isolated from each other
 *   - `applyAllUpAndCreateAppRole` is a no-op on a clone
 *   - `uriFor` targets the clone, not the template
 *   - `stopPgEnv` drops the clone
 *   - concurrent clones from the same template all succeed
 *   - `{ isolated: true }` still gets a private container
 */
import { Client, Pool } from "pg";
import {
  APP_ROLE_NAME,
  APP_ROLE_PASSWORD,
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "./postgres-container";
import { readSharedServer } from "./pg-shared-server";

const opened: PgTestEnv[] = [];

async function open(): Promise<PgTestEnv> {
  const env = await startPgEnv();
  opened.push(env);
  return env;
}

async function databaseExists(env: PgTestEnv, name: string): Promise<boolean> {
  const probe = new Client({ connectionString: env.uriFor("postgres", "postgres").replace(/\/[^/]+$/, "/postgres") });
  await probe.connect();
  try {
    const { rowCount } = await probe.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    return rowCount === 1;
  } finally {
    await probe.end();
  }
}

afterAll(async () => {
  await Promise.all(opened.map((env) => stopPgEnv(env)));
}, 120_000);

const shared = readSharedServer();
const describeShared = shared ? describe : describe.skip;

describeShared("shared Postgres server (RT-815)", () => {
  it("clone has the full schema and the app role", async () => {
    const env = await open();
    expect(env.cloned).toBe(true);
    const { rows } = await env.admin.query<{ t: string | null }>(`SELECT to_regclass('public.devices')::text AS t`);
    expect(rows[0]?.t).toBe("devices");
    const who = await env.app.query<{ u: string }>("SELECT current_user AS u");
    expect(who.rows[0]?.u).toBe(APP_ROLE_NAME);
  }, 60_000);

  it("two clones are isolated", async () => {
    const [a, b] = await Promise.all([open(), open()]);
    expect(a.database).not.toBe(b.database);
    await a.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES ('0a000000-0000-7000-8000-0000000815a1', 'rt815-a', 'A')`,
    );
    const { rows } = await b.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenants WHERE slug = 'rt815-a'`);
    expect(rows[0]?.n).toBe(0);
  }, 60_000);

  it("applyAllUpAndCreateAppRole is a no-op on a clone", async () => {
    const env = await open();
    await expect(applyAllUpAndCreateAppRole(env)).resolves.toBeUndefined();
  }, 60_000);

  it("uriFor targets this database", async () => {
    const env = await open();
    const pool = new Pool({ connectionString: env.uriFor(APP_ROLE_NAME, APP_ROLE_PASSWORD) });
    try {
      const { rows } = await pool.query<{ d: string }>("SELECT current_database() AS d");
      expect(rows[0]?.d).toBe(env.database);
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("stop drops the database", async () => {
    const env = await startPgEnv();
    const name = env.database;
    expect(await databaseExists(env, name)).toBe(true);
    await stopPgEnv(env);
    expect(await databaseExists(env, name)).toBe(false);
  }, 60_000);

  it("parallel clones all succeed", async () => {
    const envs = await Promise.all([open(), open(), open(), open()]);
    expect(new Set(envs.map((e) => e.database)).size).toBe(4);
  }, 120_000);

  it("isolated env has its own container", async () => {
    const env = await startPgEnv({ isolated: true });
    try {
      expect(env.cloned).toBe(false);
      expect(env.container).toBeDefined();
      expect(env.port).not.toBe(shared?.port);
    } finally {
      await stopPgEnv(env);
    }
  }, 180_000);
});
