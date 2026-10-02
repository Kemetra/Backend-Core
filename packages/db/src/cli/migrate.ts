#!/usr/bin/env node
/**
 * Backend-Core migration runner.
 *
 * Walks `packages/db/drizzle/*.sql` in lexical order. Tracks applied
 * migrations in a `_drizzle_migrations` ledger table. Holds a Postgres
 * advisory lock during work so concurrent runners serialize cleanly.
 *
 * Usage:
 *   data-pulse-migrate up       Apply all pending UP migrations.
 *   data-pulse-migrate down     Roll back the most recently applied migration.
 *   data-pulse-migrate status   Print pending and applied counts.
 *
 * Reads the database connection string from `DATABASE_URL`.
 *
 * Exit codes:
 *    0  success
 *    1  SQL or runtime error
 *    2  DATABASE_URL missing
 *    3  unknown subcommand
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "pg";

const ADVISORY_LOCK_NAMESPACE = "data-pulse-2:migrate";

interface MigrationFile {
  /** e.g. "0000_initial" */
  id: string;
  upPath: string;
  downPath: string | null;
}

async function listMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const upFiles = entries
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .sort();
  return upFiles.map((upName) => {
    const id = upName.replace(/\.sql$/, "");
    const downName = `${id}.down.sql`;
    const downExists = entries.includes(downName);
    return {
      id,
      upPath: join(dir, upName),
      downPath: downExists ? join(dir, downName) : null,
    };
  });
}

async function ensureLedger(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _drizzle_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedIds(client: Client): Promise<Set<string>> {
  const r = await client.query<{ id: string }>(
    "SELECT id FROM _drizzle_migrations ORDER BY id ASC",
  );
  return new Set(r.rows.map((row) => row.id));
}

async function takeLock(client: Client): Promise<void> {
  // hashtext returns a deterministic 32-bit int from any text.
  await client.query(
    "SELECT pg_advisory_lock(hashtext($1))",
    [ADVISORY_LOCK_NAMESPACE],
  );
}

async function releaseLock(client: Client): Promise<void> {
  await client.query(
    "SELECT pg_advisory_unlock(hashtext($1))",
    [ADVISORY_LOCK_NAMESPACE],
  );
}

async function runUp(client: Client, dir: string): Promise<void> {
  const all = await listMigrations(dir);
  const applied = await appliedIds(client);
  const pending = all.filter((m) => !applied.has(m.id));

  if (pending.length === 0) {
    console.log("up: no pending migrations");
    return;
  }

  for (const m of pending) {
    console.log(`up: applying ${m.id}`);
    const sql = readFileSync(m.upPath, "utf8");
    await client.query(sql);
    await client.query("INSERT INTO _drizzle_migrations (id) VALUES ($1)", [
      m.id,
    ]);
    console.log(`up: applied ${m.id}`);
  }
  console.log(`up: ${pending.length} migration(s) applied`);
}

async function runDown(client: Client, dir: string): Promise<void> {
  const r = await client.query<{ id: string }>(
    "SELECT id FROM _drizzle_migrations ORDER BY id DESC LIMIT 1",
  );
  if (r.rowCount === 0) {
    console.log("down: nothing to roll back");
    return;
  }
  const lastId = r.rows[0]!.id;
  const all = await listMigrations(dir);
  const target = all.find((m) => m.id === lastId);
  if (!target) {
    throw new Error(
      `down: applied migration ${lastId} has no source file in ${dir}`,
    );
  }
  if (!target.downPath) {
    throw new Error(`down: ${lastId} has no .down.sql file`);
  }
  console.log(`down: rolling back ${lastId}`);
  const sql = readFileSync(target.downPath, "utf8");
  await client.query(sql);
  await client.query("DELETE FROM _drizzle_migrations WHERE id = $1", [lastId]);
  console.log(`down: rolled back ${lastId}`);
}

async function runStatus(client: Client, dir: string): Promise<void> {
  const all = await listMigrations(dir);
  const applied = await appliedIds(client);
  const pending = all.filter((m) => !applied.has(m.id));
  console.log(`status: ${applied.size} applied, ${pending.length} pending`);
  for (const m of all) {
    const tag = applied.has(m.id) ? "applied" : "pending";
    console.log(`  ${tag}  ${m.id}`);
  }
}

function resolveMigrationsDir(): string {
  // The CLI lives at `packages/db/dist/cli/migrate.js` after build, so the
  // drizzle/ folder is two directories up.
  // __dirname is "<pkg>/dist/cli"; `../../drizzle` resolves to "<pkg>/drizzle".
  // Allow override via env for tests that copy migrations into a tmp dir.
  if (process.env["MIGRATIONS_DIR"]) {
    return resolve(process.env["MIGRATIONS_DIR"]);
  }
  // Use require.resolve-style path math via __dirname; the CLI is CJS
  // (package.json type=commonjs) so __dirname is defined directly.
  return resolve(__dirname, "..", "..", "drizzle");
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd) {
    console.error("usage: data-pulse-migrate <up|down|status>");
    process.exit(3);
  }
  if (cmd !== "up" && cmd !== "down" && cmd !== "status") {
    console.error(`unknown subcommand: ${cmd}`);
    process.exit(3);
  }

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }

  const dir = resolveMigrationsDir();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await ensureLedger(client);
    await takeLock(client);
    try {
      if (cmd === "up") await runUp(client, dir);
      else if (cmd === "down") await runDown(client, dir);
      else await runStatus(client, dir);
    } finally {
      await releaseLock(client);
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`migrate: ${message}`);
  process.exit(1);
});
