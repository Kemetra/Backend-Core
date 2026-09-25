/**
 * Shared Testcontainers helper.
 *
 *   - Boots `postgres:16-alpine` via `@testcontainers/postgresql`
 *   - Exposes an `admin` pool (DB superuser) for setup, metadata queries, and
 *     migration apply/rollback
 *   - Exposes an `app` pool connected as a non-superuser role with the
 *     privileges a real backend would have. This is the role the RLS
 *     functional smoke test uses, because the superuser bypasses RLS even
 *     when `FORCE ROW LEVEL SECURITY` is set.
 *
 * The migration files live in `packages/db/drizzle/`. We read them from
 * disk so the test exercises the SAME bytes the production runner ships.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");

export const UP_SQL_PATH = resolve(DRIZZLE_DIR, "0000_initial.sql");
export const DOWN_SQL_PATH = resolve(DRIZZLE_DIR, "0000_initial.down.sql");

export const APP_ROLE_NAME = "app_test";
export const APP_ROLE_PASSWORD = "app_test";

export const RETENTION_WORKER_ROLE = "audit_retention_worker";
export const RETENTION_WORKER_PASSWORD = "retention_test";

export interface PgTestEnv {
  container: StartedPostgreSqlContainer;
  /** Pool connected as the database superuser (Testcontainers default). */
  admin: Pool;
  /** Pool connected as the non-superuser `app_test` role. */
  app: Pool;
  upSql: string;
  downSql: string;
  /** Connection URI for the superuser (suitable for child-process tests). */
  adminUri: string;
  /** Host exposed by the container (reused to build additional role URIs). */
  host: string;
  /** Mapped port exposed by the container. */
  port: number;
}

export async function startPgEnv(): Promise<PgTestEnv> {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("test")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();

  const adminUri = container.getConnectionUri();
  const admin = new Pool({ connectionString: adminUri });

  // App role is created lazily by `createAppRole` after the migration runs,
  // because GRANT ON ALL TABLES needs the tables to exist first.
  const upSql = readFileSync(UP_SQL_PATH, "utf8");
  const downSql = readFileSync(DOWN_SQL_PATH, "utf8");

  // Build app pool URI now (may be unused if the test never calls it).
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const appUri = `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${host}:${port}/test`;
  const app = new Pool({ connectionString: appUri });

  return { container, admin, app, upSql, downSql, adminUri, host, port };
}

/**
 * Apply the UP migration via the admin pool, then create the non-superuser
 * `app_test` role and grant it the privileges a real backend would have.
 *
 * Idempotent: if the migration is already applied (e.g., the test wants to
 * re-apply after a rollback), this throws on the second CREATE TABLE — the
 * caller is expected to wrap UP/DOWN cycles itself.
 */
export async function applyUpAndCreateAppRole(env: PgTestEnv): Promise<void> {
  await env.admin.query(env.upSql);
  await ensureAppRole(env);
}

/**
 * Create the app role and grant table-level privileges. Safe to call multiple
 * times — uses IF NOT EXISTS / re-grants idempotently.
 */
export async function ensureAppRole(env: PgTestEnv): Promise<void> {
  await env.admin.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE_NAME}') THEN
        CREATE ROLE ${APP_ROLE_NAME} LOGIN PASSWORD '${APP_ROLE_PASSWORD}';
      END IF;
    END
    $$;
  `);
  await env.admin.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE_NAME}`);
  await env.admin.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA public TO ${APP_ROLE_NAME}
  `);
  await env.admin.query(`
    GRANT USAGE, SELECT
    ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE_NAME}
  `);
  // Narrow audit_events back to INSERT + SELECT only.  The broad grant above
  // includes UPDATE and DELETE which would let the app_test role pass
  // privilege checks that the invariant test expects to fail.  This revoke
  // runs AFTER the broad grant so it is not clobbered by a later re-grant.
  await env.admin.query(`
    REVOKE UPDATE, DELETE ON audit_events FROM ${APP_ROLE_NAME}
  `);
}

/**
 * Promote the `audit_retention_worker` role (created by migration 0005) to
 * LOGIN with a known test password, then return a connected Pool.  The role
 * must already exist — call this after `applyAllUpAndCreateAppRole`.
 *
 * The returned pool is NOT part of PgTestEnv; tests that need it call this
 * helper explicitly, keeping it out of tests that don't care about it.
 */
export async function createRetentionWorkerPool(env: PgTestEnv): Promise<Pool> {
  await env.admin.query(
    `ALTER ROLE ${RETENTION_WORKER_ROLE} WITH LOGIN PASSWORD '${RETENTION_WORKER_PASSWORD}'`,
  );
  const uri = `postgres://${RETENTION_WORKER_ROLE}:${RETENTION_WORKER_PASSWORD}@${env.host}:${env.port}/test`;
  return new Pool({ connectionString: uri });
}

/**
 * End a pool whose server is about to be stopped. pg-pool resolves end()
 * before closing clients finish their Terminate, so a container stop right
 * after can hand one of them FATAL 57P01, which the pool re-emits as 'error'.
 * Without a listener Node throws "Unhandled error." and fails the suite.
 */
export async function endPoolQuietly(pool: Pool): Promise<void> {
  pool.on("error", () => undefined);
  await pool.end().catch(() => undefined);
}

export async function stopPgEnv(env: PgTestEnv): Promise<void> {
  await endPoolQuietly(env.app);
  await endPoolQuietly(env.admin);
  await env.container.stop().catch(() => undefined);
}

/**
 * Apply every UP migration in lex order (matches the production runner's
 * file walk in `src/cli/migrate.ts`). Used by tests that need the *full*
 * schema across migrations — e.g., `migration_0001.spec.ts`. The
 * single-file `applyUpAndCreateAppRole` is preserved for the 0000-only
 * spec which exercises just the foundation slice.
 */
export async function applyAllUpAndCreateAppRole(env: PgTestEnv): Promise<void> {
  const upFiles = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .sort();
  for (const name of upFiles) {
    const sql = readFileSync(resolve(DRIZZLE_DIR, name), "utf8");
    await env.admin.query(sql);
  }
  await ensureAppRole(env);
}

/**
 * Apply every DOWN migration in reverse lex order. Mirrors the runner's
 * one-step `down`, but applied repeatedly to fully reverse the chain.
 */
export async function applyAllDown(env: PgTestEnv): Promise<void> {
  const downFiles = readdirSync(DRIZZLE_DIR)
    .filter((n) => n.endsWith(".down.sql"))
    .sort()
    .reverse();
  for (const name of downFiles) {
    const sql = readFileSync(resolve(DRIZZLE_DIR, name), "utf8");
    await env.admin.query(sql);
  }
}
