/**
 * Shared checks for the CONCURRENTLY index migrations (0064-0065, RT-735).
 *
 * The runner sends each migration file as one query; a multi-statement file is
 * wrapped in a transaction block, which CREATE/DROP INDEX CONCURRENTLY refuses.
 * `expectSingleConcurrentStatement` pins a file to exactly one such statement.
 */
import { resolve } from "node:path";

import type { Pool } from "pg";

import { sqlStatements } from "./migration-sql";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");

export function migrationPath(id: string, direction: "up" | "down"): string {
  return resolve(DRIZZLE_DIR, direction === "up" ? `${id}.sql` : `${id}.down.sql`);
}

export function expectSingleConcurrentStatement(path: string): void {
  const statements = sqlStatements(path);
  expect(statements).toHaveLength(1);
  expect(statements[0]).toMatch(/\bCONCURRENTLY\b/);
  expect(statements[0]).not.toMatch(/\b(BEGIN|COMMIT)\b/i);
}

/** An index's validity and definition, or null when it does not exist. */
export async function indexState(
  admin: Pool,
  name: string,
): Promise<{ valid: boolean; def: string } | null> {
  const r = await admin.query<{ valid: boolean; def: string }>(
    `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1`,
    [name],
  );
  return r.rows[0] ?? null;
}
