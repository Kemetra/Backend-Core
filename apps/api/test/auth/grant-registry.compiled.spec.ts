/**
 * RT-812 — the grants loader in the BUILT artifact, not only under ts-jest.
 *
 * The production image runs `node dist/main.js`, where the loader finds the
 * compiled `.grants.js` fragments beside their `.js.map`, `.d.ts` and
 * `.d.ts.map` sidecars. The db-integration CI job does not build apps/api, so
 * this spec compiles src/** with the real `tsconfig.build.json` options (as
 * `pnpm build` does) into a scratch directory, loads
 * the compiled module with plain Node `require`, and proves that:
 *   - the compiled registry holds every grant the routine deploy scripts give;
 *   - the compiled boot check passes with that full set and refuses, naming
 *     it, when one grant is missing;
 *   - a missing, empty or baseline-less fragment directory refuses to load
 *     instead of yielding an empty list.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import * as ts from "typescript";
import type { Pool } from "pg";
import { routineGrantScripts, scriptGrants } from "../_helpers/domain-grant-scripts";

const apiRoot = resolve(__dirname, "..", "..");
let outDir: string;
let compiled: {
  pools: typeof import("../../src/auth/database-pools");
  registry: typeof import("../../src/auth/grant-registry");
};

/** Compile with the build tsconfig into `outDir` (inside apps/api so Node resolves its node_modules). */
function compile(into: string): void {
  const configPath = join(apiRoot, "tsconfig.build.json");
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, apiRoot);
  const options: ts.CompilerOptions = { ...parsed.options, outDir: into, incremental: false, noEmit: false };
  delete options.tsBuildInfoFile;
  // Every file the real build compiles (all of src/**): the fragments are loaded
  // by directory, not imported, so compiling only the import graph would miss them.
  const program = ts.createProgram(parsed.fileNames, options);
  const result = program.emit();
  const errors = ts.getPreEmitDiagnostics(program).concat(result.diagnostics)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(ts.formatDiagnostics(errors, ts.createCompilerHost(options)));
}

/** A pg Pool double: the role row, and has_table_privilege over `grants` ("table:PRIV"). */
function fakePool(role: { name: string; bypassRls: boolean }, grants: ReadonlySet<string>): Pool {
  const query = async (sql: string, params?: [string[], string[]]) => {
    if (!sql.includes("has_table_privilege")) {
      return { rows: [{ role_name: role.name, session_role: role.name, is_superuser: false, bypass_rls: role.bypassRls }] };
    }
    const [tables, privileges] = params!;
    return {
      rows: tables.map((table_name, i) => ({
        table_name,
        privilege: privileges[i],
        granted: privileges[i]!.split(",").some((p) => grants.has(`${table_name}:${p.trim()}`)),
      })),
    };
  };
  return { query } as unknown as Pool;
}

const SCRIPT_GRANTS: ReadonlySet<string> = new Set(routineGrantScripts().flatMap((s) => scriptGrants(s)));

beforeAll(() => {
  outDir = mkdtempSync(join(apiRoot, ".rt812-compiled-"));
  compile(outDir);
  // Plain Node require (not Jest's module registry): exactly what `node dist/main.js` does.
  const nodeRequire = createRequire(join(outDir, "auth", "index.js"));
  compiled = {
    pools: nodeRequire("./database-pools.js"),
    registry: nodeRequire("./grant-registry.js"),
  };
}, 120_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("compiled grants registry (dist layout)", () => {
  it("emits each fragment with the sidecars the loader must tolerate", () => {
    expect(readdirSync(join(outDir, "auth", "grants")).sort()).toEqual(
      expect.arrayContaining([
        "baseline.grants.d.ts",
        "baseline.grants.d.ts.map",
        "baseline.grants.js",
        "baseline.grants.js.map",
      ]),
    );
  });

  it("loads every grant the routine deploy scripts give the domain role", () => {
    const required = new Set(compiled.pools.DOMAIN_REQUIRED_GRANTS.map(([t, p]) => `${t}:${p}`));
    expect([...required].sort()).toEqual([...SCRIPT_GRANTS].sort());
    expect(compiled.pools.AUTH_LOOKUP_FORBIDDEN_GRANTS.length).toBeGreaterThan(0);
  });

  it("boots with the full grant set and refuses, naming it, without one grant", async () => {
    const lookupGrants = new Set(compiled.pools.AUTH_LOOKUP_REQUIRED_GRANTS.map(([t, p]) => `${t}:${p}`));
    const lookup = fakePool({ name: "app_auth_lookup", bypassRls: true }, lookupGrants);
    await expect(
      compiled.pools.verifyDatabasePoolBoundary(fakePool({ name: "app_domain", bypassRls: false }, SCRIPT_GRANTS), lookup),
    ).resolves.toBeUndefined();

    const missing = new Set(SCRIPT_GRANTS);
    missing.delete("refund_executions:INSERT");
    await expect(
      compiled.pools.verifyDatabasePoolBoundary(fakePool({ name: "app_domain", bypassRls: false }, missing), lookup),
    ).rejects.toThrow(/missing required grants: INSERT ON refund_executions/);
  });

  describe("refuses instead of loading an empty registry", () => {
    const caller = (): string => join(outDir, "auth", "grant-registry.js");

    it("when the fragment directory is missing", () => {
      expect(() => compiled.registry.loadGrantRegistry({ dir: join(outDir, "nope"), callerFile: caller() })).toThrow(/is missing/);
    });

    it("when the fragment directory is empty", () => {
      const dir = join(outDir, "empty");
      mkdirSync(dir);
      expect(() => compiled.registry.loadGrantRegistry({ dir, callerFile: caller() })).toThrow(/no baseline\.grants\.js/);
    });

    it("when the baseline fragment is missing", () => {
      const dir = join(outDir, "no-baseline");
      mkdirSync(dir);
      writeFileSync(join(dir, "extra.grants.js"), "exports.GRANTS = {};\n");
      expect(() => compiled.registry.loadGrantRegistry({ dir, callerFile: caller() })).toThrow(/no baseline\.grants\.js/);
    });
  });
});
