/**
 * Start a Testcontainers Postgres with every migration BEFORE `upName`
 * applied (in name order, each file as one query, as the runner does) and the
 * app role created: the starting point of a single-migration spec, which then
 * applies `upName` itself. Returns null, with a warning, when Docker is
 * unavailable and MIGRATION_TEST_ALLOW_SKIP=1; otherwise a failure is thrown.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ensureAppRole, startPgEnv, type PgTestEnv } from "./postgres-container";

export const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");

export async function startEnvBefore(upName: string, label: string): Promise<PgTestEnv | null> {
  let env: PgTestEnv;
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw err;
    // eslint-disable-next-line no-console
    console.warn(`\n[${label}] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
    return null;
  }
  const earlier = readdirSync(DRIZZLE_DIR)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && !name.endsWith(".down.sql"))
    .filter((name) => name.localeCompare(upName) < 0)
    .sort();
  for (const name of earlier) await env.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  await ensureAppRole(env);
  return env;
}
