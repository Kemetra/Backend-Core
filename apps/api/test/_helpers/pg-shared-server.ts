/**
 * RT-815 — one Postgres server per Jest run, one database per spec file.
 *
 * `jest-global-setup.ts` starts the container, builds the migrated
 * `rt_template` database and publishes its coordinates through the env vars
 * below; Jest workers inherit them. `postgres-container.ts#startPgEnv` then
 * clones a fresh database from the template per spec file (a file-level copy,
 * ~0.1–0.4 s) instead of booting a container per file (~5 s).
 *
 * Roles are cluster-wide, so they are NOT isolated by the per-file database.
 * `snapshotRoles` lets globalTeardown fail the run if any spec changed them;
 * specs that must change roles opt out with `startPgEnv({ isolated: true })`.
 */
import { randomBytes } from "node:crypto";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";

/** globalThis key holding the parent-process state shared by setup and teardown. */
export const RT_PG_STATE_KEY = "__RT_PG_SHARED__";

export interface SharedState {
  container: StartedPostgreSqlContainer;
  /** `snapshotRoles` right after the template build. */
  roles: string;
}

export const SUPERUSER = "postgres";
export const SUPERUSER_PASSWORD = "postgres";
export const TEMPLATE_DATABASE = "rt_template";

export const SHARED_ENV = {
  host: "RT_PG_SHARED_HOST",
  port: "RT_PG_SHARED_PORT",
  template: "RT_PG_SHARED_TEMPLATE",
} as const;

export interface SharedServer {
  host: string;
  port: number;
  template: string;
}

function parsePort(raw: string | undefined): number | null {
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** The shared server published by globalSetup, or null outside it. */
export function readSharedServer(): SharedServer | null {
  const host = process.env[SHARED_ENV.host];
  const template = process.env[SHARED_ENV.template];
  const port = parsePort(process.env[SHARED_ENV.port]);
  if (!host || !template) return null;
  if (port === null) return null;
  return { host, port, template };
}

export function uriFor(
  server: Pick<SharedServer, "host" | "port">,
  database: string,
  user: string,
  password: string,
): string {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${server.host}:${server.port}/${database}`;
}

async function withMaintenanceClient<T>(server: SharedServer, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: uriFor(server, "postgres", SUPERUSER, SUPERUSER_PASSWORD) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** 55006 object_in_use: the template had a connection when CREATE DATABASE ran. */
const OBJECT_IN_USE = "55006";
const CLONE_ATTEMPTS = 5;
const CLONE_RETRY_MS = 100;

/** Clone a fresh database from the template; returns its name. */
export async function cloneDatabase(server: SharedServer): Promise<string> {
  const worker = process.env["JEST_WORKER_ID"] ?? "0";
  const name = `rt_w${worker}_${randomBytes(4).toString("hex")}`;
  await withMaintenanceClient(server, async (client) => {
    for (let attempt = 1; ; attempt++) {
      try {
        await client.query(`CREATE DATABASE "${name}" TEMPLATE "${server.template}"`);
        return;
      } catch (err: unknown) {
        const code = (err as { code?: unknown }).code;
        if (code !== OBJECT_IN_USE || attempt >= CLONE_ATTEMPTS) throw err;
        await new Promise((r) => setTimeout(r, CLONE_RETRY_MS));
      }
    }
  });
  return name;
}

/** Drop a cloned database, terminating any connection still open on it. */
export async function dropDatabase(server: SharedServer, name: string): Promise<void> {
  await withMaintenanceClient(server, (client) => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
}

/**
 * Stable fingerprint of every cluster-wide role attribute a spec could change,
 * including password hashes (`pg_roles` masks `rolpassword`, so `pg_authid`),
 * memberships and per-role settings.
 */
export async function snapshotRoles(client: Client): Promise<string> {
  const roles = await client.query(
    `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
            rolreplication, rolbypassrls, rolconnlimit, rolpassword, rolvaliduntil::text AS rolvaliduntil
       FROM pg_authid ORDER BY rolname`,
  );
  const members = await client.query(
    `SELECT r.rolname AS role, m.rolname AS member, g.rolname AS grantor,
            am.admin_option, am.inherit_option, am.set_option
       FROM pg_auth_members am
       JOIN pg_authid r ON r.oid = am.roleid
       JOIN pg_authid m ON m.oid = am.member
       JOIN pg_authid g ON g.oid = am.grantor
      ORDER BY 1, 2, 3`,
  );
  // `ALTER ROLE … SET …` lives here, and would reach every clone's pools.
  const settings = await client.query(
    `SELECT setdatabase, setrole, setconfig FROM pg_db_role_setting ORDER BY 1, 2`,
  );
  return JSON.stringify({ roles: roles.rows, members: members.rows, settings: settings.rows });
}
