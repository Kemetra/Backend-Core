/**
 * RT-346 — when a migration fails, `migrate up` must report THAT failure.
 *
 * Each migration file runs its own `BEGIN ... COMMIT`, so a failing statement
 * leaves the connection in an aborted transaction. The CLI then released its
 * advisory lock on that same connection; the unlock failed with "current
 * transaction is aborted", and that secondary error replaced the real one in
 * the operator's output.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const CLI_PATH = resolve(__dirname, "..", "..", "dist", "cli", "migrate.js");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runUp(env: Record<string, string>): Promise<CliResult> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI_PATH, "up"], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", fail);
    child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
  });
}

let env: PgTestEnv | null = null;
let dir = "";

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[cli/migrate-failure.spec] Docker NOT AVAILABLE — skipping. Reason: ${message}\n`);
      return;
    }
    throw new Error(`Container start failed: ${message}`);
  }
  dir = mkdtempSync(join(tmpdir(), "rt346-"));
  writeFileSync(join(dir, "0001_ok.sql"), "BEGIN;\nCREATE TABLE rt346_ok (id int);\nCOMMIT;\n");
  writeFileSync(
    join(dir, "0002_boom.sql"),
    "BEGIN;\nCREATE TABLE rt346_boom (id int);\nSELECT 1 / 0;\nCOMMIT;\n",
  );
}, 180_000);

afterAll(async () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (env) await stopPgEnv(env);
}, 60_000);

async function count(sql: string): Promise<string> {
  const r = await env!.admin.query<{ count: string }>(sql);
  return r.rows[0]?.count ?? "";
}

describe("migrate up reports the failing migration's own error (RT-346)", () => {
  let result: CliResult;

  beforeAll(async () => {
    if (!env) return;
    result = await runUp({ DATABASE_URL: env.adminUri, MIGRATIONS_DIR: dir });
  });

  it("exits 1", () => {
    if (!env) return;
    expect(result.code).toBe(1);
  });

  it("names the migration, the database error and its SQLSTATE", () => {
    if (!env) return;
    expect(result.stderr).toContain("0002_boom");
    expect(result.stderr).toContain("division by zero");
    expect(result.stderr).toContain("22012");
  });

  it("does not report the secondary aborted-transaction error instead", () => {
    if (!env) return;
    expect(result.stderr).not.toContain("current transaction is aborted");
  });

  it("keeps the earlier migration and rolls the failed one back", async () => {
    if (!env) return;
    expect(await count("SELECT COUNT(*)::text AS count FROM _drizzle_migrations WHERE id = '0001_ok'")).toBe("1");
    expect(await count("SELECT COUNT(*)::text AS count FROM _drizzle_migrations WHERE id = '0002_boom'")).toBe("0");
    expect(
      await count("SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_name = 'rt346_boom'"),
    ).toBe("0");
  });

  it("resumes at the failed migration once it is fixed", async () => {
    if (!env) return;
    writeFileSync(join(dir, "0002_boom.sql"), "BEGIN;\nCREATE TABLE rt346_boom (id int);\nCOMMIT;\n");
    const rerun = await runUp({ DATABASE_URL: env.adminUri, MIGRATIONS_DIR: dir });
    expect(rerun.code).toBe(0);
    expect(rerun.stdout).toContain("up: applied 0002_boom");
  });
});
