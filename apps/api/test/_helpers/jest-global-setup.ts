/**
 * RT-815 — Jest globalSetup for apps/api: ONE Postgres server per run.
 *
 * Starts `postgres:16-alpine`, applies every UP migration + the `app_test`
 * role into `rt_template`, locks the template against connections, records a
 * role fingerprint for the teardown guard, and publishes the server through
 * `SHARED_ENV` (workers are spawned after this and inherit `process.env`).
 *
 * If Docker is unreachable it warns and publishes nothing: `startPgEnv()` then
 * falls back to a private container per spec file, which fails (or skips under
 * `MIGRATION_TEST_ALLOW_SKIP=1`) exactly as before. A migration failure fails
 * the whole run.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";

import {
  RT_PG_STATE_KEY,
  SHARED_ENV,
  SUPERUSER,
  SUPERUSER_PASSWORD,
  TEMPLATE_DATABASE,
  snapshotRoles,
  uriFor,
  type SharedState,
} from "./pg-shared-server";
import { applyAllMigrationsAndAppRole, endPoolQuietly, guardPool } from "./postgres-container";

const TEMPLATE_IDLE_TIMEOUT_MS = 5000;

async function buildTemplate(server: { host: string; port: number }): Promise<string> {
  const admin = guardPool(
    new Pool({ connectionString: uriFor(server, TEMPLATE_DATABASE, SUPERUSER, SUPERUSER_PASSWORD) }),
  );
  try {
    await applyAllMigrationsAndAppRole(admin);
  } finally {
    await endPoolQuietly(admin);
  }

  const maint = new Client({ connectionString: uriFor(server, "postgres", SUPERUSER, SUPERUSER_PASSWORD) });
  await maint.connect();
  try {
    // Pool.end() resolves before its sockets close; CREATE DATABASE … TEMPLATE
    // needs the template idle, so wait for the pool's backends to leave.
    const deadline = Date.now() + TEMPLATE_IDLE_TIMEOUT_MS;
    for (;;) {
      const { rows } = await maint.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`,
        [TEMPLATE_DATABASE],
      );
      if (rows[0]?.n === 0) break;
      if (Date.now() > deadline) {
        process.stderr.write(
          `\n[rt-815 globalSetup] ${rows[0]?.n} connection(s) still open on ${TEMPLATE_DATABASE} after ` +
            `${TEMPLATE_IDLE_TIMEOUT_MS} ms; clones may fail with 55006\n`,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    await maint.query(`ALTER DATABASE "${TEMPLATE_DATABASE}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
    return await snapshotRoles(maint);
  } finally {
    await maint.end().catch(() => undefined);
  }
}

export default async function globalSetup(): Promise<void> {
  let container: StartedPostgreSqlContainer;
  try {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase(TEMPLATE_DATABASE)
      .withUsername(SUPERUSER)
      .withPassword(SUPERUSER_PASSWORD)
      .start();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n[rt-815 globalSetup] shared Postgres not started (${msg}); specs fall back to per-file containers\n`);
    return;
  }

  const server = { host: container.getHost(), port: container.getMappedPort(5432) };
  let roles: string;
  try {
    roles = await buildTemplate(server);
  } catch (err) {
    await container.stop().catch(() => undefined);
    throw err;
  }

  const state: SharedState = { container, roles };
  (globalThis as Record<string, unknown>)[RT_PG_STATE_KEY] = state;
  process.env[SHARED_ENV.host] = server.host;
  process.env[SHARED_ENV.port] = String(server.port);
  process.env[SHARED_ENV.template] = TEMPLATE_DATABASE;
}
