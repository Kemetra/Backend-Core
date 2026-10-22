/**
 * Shared helpers for the per-migration specs.
 *
 *   - `withTenant`: run `fn` as the non-superuser app role inside one tenant's
 *     RLS context (`app.current_tenant`, not a platform admin), then roll back.
 *   - `sqlStatements`: a migration file's statements, comments stripped, so a
 *     spec can pin a CONCURRENTLY file to exactly one statement (the runner
 *     wraps a multi-statement file in a transaction block; 0048, 0057-0061).
 */
import { readFileSync } from "node:fs";

import type { Pool, PoolClient } from "pg";

export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

export function sqlStatements(path: string): string[] {
  return readFileSync(path, "utf8")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
