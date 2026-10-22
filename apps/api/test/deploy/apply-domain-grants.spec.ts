/**
 * RT-812 — deploy/apply-domain-grants.sh, the one command README step 2 runs.
 * It selects the routine `*-domain-grants.sql` scripts by their opt-in marker,
 * which is also what release-bundle.sh ships and what the grants fragments pair
 * with, so the three can never drift apart.
 *
 * The script is exercised with bash against the real repo (`--list`) and with
 * a stub `psql` on PATH (apply mode), so the deploy semantics are checked
 * without a database: refuse without DOMAIN_DB_ROLE, apply in name order with
 * the role variable, stop at the first failure. Skipped only when no working
 * bash exists locally; CI (Linux) always runs it.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { routineGrantScripts } from "../_helpers/domain-grant-scripts";

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
const SCRIPT = "deploy/apply-domain-grants.sh";

function bashWorks(): boolean {
  const probe = spawnSync("bash", ["-c", "printf ok"], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout === "ok";
}
const haveBash = bashWorks();
if (!haveBash && process.env["CI"]) throw new Error("bash is required in CI for the deploy grant selector spec");
const itBash = haveBash ? it : it.skip;

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [SCRIPT, ...args], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } });
}

const expected = (): string[] => routineGrantScripts().map((f) => `docs/operations/sql/${f}`);

describe("deploy/apply-domain-grants.sh", () => {
  it("keeps the safety properties of the old step 2", () => {
    const text = readFileSync(resolve(repoRoot, SCRIPT), "utf8");
    expect(text).toContain("set -euo pipefail");
    expect(text).toContain("export LC_ALL=C");
    expect(text).toContain("MARKER='-- deploy: every-release'");
    expect(text).toContain('psql -X -v domain_role="$DOMAIN_DB_ROLE" -f "$script"');
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
  });

  itBash("--list prints exactly the marked routine scripts, in name order", () => {
    const r = run(["--list"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(expected());
  });

  itBash("refuses an unknown argument", () => {
    const r = run(["--apply-all"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown argument/);
  });

  describe("apply mode (stub psql)", () => {
    let bin: string;
    let log: string;
    beforeEach(() => {
      bin = mkdtempSync(join(tmpdir(), "rt812-psql-"));
      log = join(bin, "calls.log");
      // Records each call; fails for the script named in FAIL_ON.
      writeFileSync(
        join(bin, "psql"),
        '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$PSQL_LOG"\n' +
          'case "$*" in *"${FAIL_ON:-<none>}"*) exit 3 ;; esac\n',
      );
      chmodSync(join(bin, "psql"), 0o755);
    });
    afterEach(() => rmSync(bin, { recursive: true, force: true }));

    const withStub = (env: NodeJS.ProcessEnv) =>
      run([], { PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`, PSQL_LOG: log, ...env });
    const calls = (): string[] => {
      try {
        return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    };

    itBash("refuses to run without DOMAIN_DB_ROLE and calls no psql", () => {
      const r = withStub({ DOMAIN_DB_ROLE: "" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/DOMAIN_DB_ROLE is not set/);
      expect(calls()).toEqual([]);
    });

    itBash("applies every routine script once, in order, with the domain role", () => {
      const r = withStub({ DOMAIN_DB_ROLE: "app_domain" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(calls()).toEqual(expected().map((f) => `-X -v domain_role=app_domain -f ${f}`));
    });

    itBash("stops at the first failing script", () => {
      const scripts = expected();
      const failing = scripts[2]!;
      const r = withStub({ DOMAIN_DB_ROLE: "app_domain", FAIL_ON: failing });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`failed: ${failing}`);
      expect(calls()).toHaveLength(3);
    });
  });
});
