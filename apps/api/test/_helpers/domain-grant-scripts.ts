/**
 * RT-812 — the independent oracle for the boot-checked grant lists: the
 * routine deploy scripts in docs/operations/sql and the migrations' CREATE
 * TABLEs, read from disk. The lists themselves are assembled from fragments
 * (src/auth/grants/), so a test that compared them with themselves would not
 * notice a dropped entry; comparing them with what deploy actually grants does.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
export const SQL_DIR = resolve(repoRoot, "docs", "operations", "sql");
export const DRIZZLE_DIR = resolve(repoRoot, "packages", "db", "drizzle");

/** The opt-in line `deploy/apply-domain-grants.sh` selects routine scripts by. */
export const ROUTINE_MARKER = "-- deploy: every-release";

/** The last migration covered by the frozen grants baseline. */
export const GRANTS_BASELINE_HEAD = "0067_refund_executions";

const read = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** Every `*-domain-grants.sql` carrying the routine marker, by name. */
export function routineGrantScripts(dir = SQL_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith("-domain-grants.sql"))
    .filter((f) => read(resolve(dir, f)).split("\n").includes(ROUTINE_MARKER))
    .sort();
}

/**
 * "table:PRIVILEGE" for each privilege a script GRANTs to the domain role.
 * Fails closed: a GRANT statement in any other shape (lowercase, `ON TABLE`, a
 * schema prefix, another grantee) throws instead of being
 * skipped, so no grant deploy applies can escape the comparison.
 */
export function scriptGrants(script: string, dir = SQL_DIR): string[] {
  const sql = read(resolve(dir, script));
  const statements = sql.match(/^\s*GRANT\b[^;]*;?/gim) ?? [];
  const parsed = [...sql.matchAll(/^\s*GRANT\s+([A-Z, ]+?)\s+ON\s+([a-z0-9_, ]+?)\s+TO\s+:"domain_role"\s*;/gm)];
  if (statements.length !== parsed.length) {
    throw new Error(`${script}: ${statements.length - parsed.length} GRANT statement(s) the grant oracle cannot parse`);
  }
  const grants: string[] = [];
  for (const m of parsed) {
    for (const table of m[2]!.split(",").map((t) => t.trim())) {
      for (const privilege of m[1]!.split(",").map((p) => p.trim())) grants.push(`${table}:${privilege}`);
    }
  }
  return grants;
}

/** Tables created by the up migrations after `afterId` (lexical id order). */
export function tablesCreatedAfter(afterId: string, dir = DRIZZLE_DIR): string[] {
  const tables: string[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!/^\d{4}_.+\.sql$/.test(file) || file.endsWith(".down.sql")) continue;
    if (file.replace(/\.sql$/, "") <= afterId) continue;
    for (const m of read(resolve(dir, file)).matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi,
    )) {
      tables.push(m[1]!.toLowerCase());
    }
  }
  return tables;
}
