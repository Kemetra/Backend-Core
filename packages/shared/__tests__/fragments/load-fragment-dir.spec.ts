/**
 * RT-812 — the fragment-directory loader behind the conflict-free registries
 * (grants, metric labels). It must load the compiled `.js` siblings in `dist`
 * and the `.ts` sources under ts-jest, never both, and refuse to return a
 * partial or empty registry.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFragmentDir } from "../../src/fragments/load-fragment-dir";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rt812-fragments-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fragment directory holding `files` (name -> content). */
function dirWith(files: Record<string, string>): string {
  const dir = join(root, "fragments");
  mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const js = (value: string): string => `module.exports = { VALUE: ${JSON.stringify(value)} };\n`;
const ts = (value: string): string => `export const VALUE = ${JSON.stringify(value)};\n`;
const CALLER_JS = "/srv/app/dist/auth/grant-registry.js";
const CALLER_TS = "/repo/apps/api/src/auth/grant-registry.ts";

describe("loadFragmentDir", () => {
  it("loads the compiled .js fragments, baseline first, then by file name", () => {
    const dir = dirWith({
      "zeta.grants.js": js("z"),
      "alpha.grants.js": js("a"),
      "baseline.grants.js": js("b"),
    });
    const loaded = loadFragmentDir(dir, ".grants", CALLER_JS);
    expect(loaded.map((f) => f.name)).toEqual(["baseline", "alpha", "zeta"]);
    expect(loaded.map((f) => (f.exports as { VALUE: string }).VALUE)).toEqual(["b", "a", "z"]);
  });

  it("accepts the tsc sidecars of a compiled fragment (.js.map, .d.ts, .d.ts.map)", () => {
    const dir = dirWith({
      "baseline.grants.js": js("b"),
      "baseline.grants.js.map": "{}",
      "baseline.grants.d.ts": "export {};\n",
      "baseline.grants.d.ts.map": "{}",
    });
    expect(loadFragmentDir(dir, ".grants", CALLER_JS).map((f) => f.name)).toEqual(["baseline"]);
  });

  it("loads the .ts sources when the caller is a .ts file (ts-jest)", () => {
    const dir = dirWith({ "baseline.labels.ts": ts("b"), "ai.labels.ts": ts("a") });
    const loaded = loadFragmentDir(dir, ".labels", CALLER_TS);
    expect(loaded.map((f) => f.name)).toEqual(["baseline", "ai"]);
  });

  it("refuses a missing directory instead of returning an empty registry", () => {
    expect(() => loadFragmentDir(join(root, "nope"), ".grants", CALLER_JS)).toThrow(
      /fragment directory .*nope.* is missing/,
    );
  });

  it("refuses an empty directory", () => {
    expect(() => loadFragmentDir(dirWith({}), ".grants", CALLER_JS)).toThrow(/no baseline\.grants\.js/);
  });

  it("refuses a directory without its baseline fragment", () => {
    const dir = dirWith({ "alpha.grants.js": js("a") });
    expect(() => loadFragmentDir(dir, ".grants", CALLER_JS)).toThrow(/no baseline\.grants\.js/);
  });

  it.each([
    ["a stray file", "notes.md"],
    ["a fragment with the wrong suffix", "alpha.labels.js"],
    ["a source file next to compiled ones", "alpha.grants.ts"],
    ["an upper-case name", "Alpha.grants.js"],
    ["a fragment-shaped name with no slug", ".grants.js"],
  ])("refuses %s in the directory", (_label, stray) => {
    const dir = dirWith({ "baseline.grants.js": js("b"), [stray]: js("x") });
    expect(() => loadFragmentDir(dir, ".grants", CALLER_JS)).toThrow(/unexpected file/);
  });

  it("refuses a compiled file when the caller runs from source", () => {
    const dir = dirWith({ "baseline.labels.ts": ts("b"), "alpha.labels.js": js("a") });
    expect(() => loadFragmentDir(dir, ".labels", CALLER_TS)).toThrow(/unexpected file .*alpha\.labels\.js/);
  });

  it("rejects a suffix that is not a lower-case .word", () => {
    expect(() => loadFragmentDir(root, "grants", CALLER_JS)).toThrow(/suffix/);
  });
});
