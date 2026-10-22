/**
 * RT-812 — the migration registry that replaced migrate.spec's hand-written
 * EXPECTED_MIGRATIONS list. Docker-free: these prove each guard the list gave
 * still bites (a planted stray migration, a deleted one, a missing down, a
 * head without a biting probe, a wrong head), and that the real registry
 * matches the drizzle directory.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MigrationEntry, MigrationProbe } from "./migration-probes";
import {
  loadMigrationRegistry,
  probeMismatches,
  resolveMigrationRegistry,
  resolveMigrations,
} from "./migration-registry";
import { BASELINE_HEAD, BASELINE_MIGRATIONS } from "./migrations/baseline";

const probe = (applied: string, rolledBack = "0"): MigrationProbe => ({
  measure: async () => [applied],
  applied: [applied],
  rolledBack: [rolledBack],
});
const files = (...ids: string[]): string[] => ids.flatMap((id) => [`${id}.sql`, `${id}.down.sql`]);
const BASE = "0001_b";
const entries: MigrationEntry[] = [{ id: "0000_a" }, { id: BASE, probe: probe("1") }, { id: "0002_c", probe: probe("1") }];

describe("resolveMigrations", () => {
  it("returns the ids in runner order, the head and the probes", () => {
    const r = resolveMigrations(files("0002_c", "0000_a", BASE), entries, BASE);
    expect(r.ids).toEqual(["0000_a", "0001_b", "0002_c"]);
    expect(r.head).toBe("0002_c");
    expect([...r.probes.keys()]).toEqual(["0001_b", "0002_c"]);
  });

  it("fails on a planted stray migration file", () => {
    expect(() => resolveMigrations([...files("0000_a", BASE, "0002_c"), ...files("0003_stray")], entries, BASE)).toThrow(
      /unregistered migration file.*0003_stray/,
    );
  });

  it("fails on a registered migration whose file was deleted", () => {
    expect(() => resolveMigrations(files("0000_a", BASE), entries, BASE)).toThrow(/registered but no up file.*0002_c/);
  });

  it("fails on a migration without a down file", () => {
    expect(() => resolveMigrations([...files("0000_a", BASE), "0002_c.sql"], entries, BASE)).toThrow(/no \.down\.sql.*0002_c/);
  });

  it("fails on a down file without its up file", () => {
    expect(() =>
      resolveMigrations([...files("0000_a", BASE, "0002_c"), "0009_gone.down.sql"], entries, BASE),
    ).toThrow(/without an up file.*0009_gone/);
  });

  it("fails on a misnamed migration file", () => {
    expect(() => resolveMigrations([...files("0000_a", BASE, "0002_c"), "0003-Bad.sql"], entries, BASE)).toThrow(
      /file name is not/,
    );
  });

  it("fails on an id registered twice", () => {
    expect(() => resolveMigrations(files("0000_a", BASE, "0002_c"), [...entries, { id: "0002_c" }], BASE)).toThrow(
      /registered twice.*0002_c/,
    );
  });

  it("fails on a migration after the baseline without a probe", () => {
    expect(() => resolveMigrations(files("0000_a", BASE, "0002_c"), [entries[0]!, entries[1]!, { id: "0002_c" }], BASE)).toThrow(
      /after the baseline needs a probe.*0002_c/,
    );
  });

  it("fails on a probe that cannot bite (same reading applied and rolled back)", () => {
    const flat = [entries[0]!, entries[1]!, { id: "0002_c", probe: probe("1", "1") }];
    expect(() => resolveMigrations(files("0000_a", BASE, "0002_c"), flat, BASE)).toThrow(/same applied and rolled back.*0002_c/);
  });

  it("fails when the head (even a baseline one) has no probe", () => {
    expect(() => resolveMigrations(files("0000_a"), [{ id: "0000_a" }], "0000_a")).toThrow(/head migration has no probe/);
  });
});

describe("probeMismatches (the head and down checks)", () => {
  const probes = new Map([
    ["0001_b", probe("1")],
    ["0002_c", probe("2")],
  ]);

  it("passes when only the rolled-back head reads rolled back", () => {
    const readings = new Map([
      ["0001_b", ["1"]],
      ["0002_c", ["0"]],
    ]);
    expect(probeMismatches(probes, readings, new Set(["0002_c"]))).toEqual([]);
  });

  it("bites on a wrong head: the expected head still reads applied", () => {
    const readings = new Map([
      ["0001_b", ["0"]],
      ["0002_c", ["2"]],
    ]);
    expect(probeMismatches(probes, readings, new Set(["0002_c"]))).toEqual([
      { id: "0001_b", expected: ["1"], actual: ["0"] },
      { id: "0002_c", expected: ["0"], actual: ["2"] },
    ]);
  });

  it("bites when a down also removed an older migration's objects", () => {
    const readings = new Map([
      ["0001_b", ["0"]],
      ["0002_c", ["0"]],
    ]);
    expect(probeMismatches(probes, readings, new Set(["0002_c"]))).toEqual([{ id: "0001_b", expected: ["1"], actual: ["0"] }]);
  });
});

describe("loadMigrationRegistry", () => {
  let dir: string;
  const baseline = `export const BASELINE_MIGRATIONS = [{ id: "0000_a" }];\nexport const BASELINE_HEAD = "0000_a";\n`;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rt812-migrations-"));
    writeFileSync(join(dir, "baseline.ts"), baseline);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads the baseline then each <id>.ts fragment", () => {
    writeFileSync(join(dir, "0001_b.ts"), `export const MIGRATION = { id: "0001_b" };\n`);
    expect(loadMigrationRegistry(dir).map((e) => e.id)).toEqual(["0000_a", "0001_b"]);
  });

  it("fails on a fragment whose id does not match its file name", () => {
    writeFileSync(join(dir, "0001_b.ts"), `export const MIGRATION = { id: "0001_other" };\n`);
    expect(() => loadMigrationRegistry(dir)).toThrow(/id equal to its file name.*0001_b\.ts/);
  });

  it("fails on any other file in the registry directory", () => {
    writeFileSync(join(dir, "notes.md"), "");
    expect(() => loadMigrationRegistry(dir)).toThrow(/unexpected file.*notes\.md/);
  });
});

describe("the real registry", () => {
  it("matches the drizzle directory, with a probed head", () => {
    const r = resolveMigrationRegistry();
    expect(r.ids.length).toBeGreaterThanOrEqual(BASELINE_MIGRATIONS.length);
    expect(r.probes.has(r.head)).toBe(true);
  });

  it("keeps the frozen baseline frozen (its head is 0067 and it has 65 entries: 0049, 0052 and 0053 never existed)", () => {
    expect(BASELINE_HEAD).toBe("0067_refund_executions");
    expect(BASELINE_MIGRATIONS).toHaveLength(65);
    expect(BASELINE_MIGRATIONS[BASELINE_MIGRATIONS.length - 1]!.id).toBe(BASELINE_HEAD);
    expect(BASELINE_MIGRATIONS.every((e) => e.id <= BASELINE_HEAD)).toBe(true);
  });
});
