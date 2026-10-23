/**
 * RT-812 — the expected migration chain, assembled from one registry file per
 * migration (`./migrations/<id>.ts`) plus the frozen `./migrations/baseline.ts`,
 * so two PRs that each add a migration add different files.
 *
 * `resolveMigrations` keeps every guard the hand-written EXPECTED_MIGRATIONS
 * list gave: a stray or deleted migration file, a missing down file and a
 * duplicate id all fail, and the chain's head must carry a probe that bites
 * (its objects read differently before and after its own down).
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { MigrationEntry, MigrationProbe } from "./migration-probes";

export const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
export const REGISTRY_DIR = resolve(__dirname, "migrations");

export interface ResolvedMigrations {
  /** Every migration id, in the runner's (lexical) order. */
  readonly ids: readonly string[];
  readonly head: string;
  readonly probes: ReadonlyMap<string, MigrationProbe>;
}

const UP_FILE = /^(\d{4}_[a-z0-9_]+)\.sql$/;
const DOWN_FILE = /^(\d{4}_[a-z0-9_]+)\.down\.sql$/;

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function fail(problem: string, items: readonly string[]): never {
  throw new Error(`migration registry: ${problem}: ${items.join(", ")}`);
}

/** Split a drizzle directory listing into up and down migration ids. */
function migrationFiles(files: readonly string[]): { ups: Set<string>; downs: Set<string> } {
  const ups = new Set<string>();
  const downs = new Set<string>();
  for (const file of files) {
    const down = DOWN_FILE.exec(file)?.[1];
    if (down) downs.add(down);
    else if (UP_FILE.test(file)) ups.add(file.replace(/\.sql$/, ""));
    else if (/^\d{4}/.test(file)) fail("file name is not <NNNN>_<snake_case>[.down].sql", [file]);
  }
  return { ups, downs };
}

/** Throw `problem` naming every id in `ids`, when there is any. */
function failIfAny(problem: string, ids: readonly string[]): void {
  if (ids.length > 0) fail(problem, [...ids].sort());
}

/** The registry and the directory hold the same migrations, each with both files. */
function checkFiles(ids: readonly string[], ups: ReadonlySet<string>, downs: ReadonlySet<string>): void {
  failIfAny("registered twice", ids.filter((id, i) => ids.indexOf(id) !== i));
  const registered = new Set(ids);
  failIfAny("unregistered migration file (add ./migrations/<id>.ts)", [...ups].filter((id) => !registered.has(id)));
  failIfAny("registered but no up file", ids.filter((id) => !ups.has(id)));
  failIfAny("no .down.sql", [...ups].filter((id) => !downs.has(id)));
  failIfAny(".down.sql without an up file", [...downs].filter((id) => !ups.has(id)));
}

/**
 * The probes by id; every migration after the baseline needs one that bites.
 * "After the baseline" is any id above its head and, when the baseline's ids
 * are given, any id it does not hold (a new migration in a numbering gap).
 */
function collectProbes(
  entries: readonly MigrationEntry[],
  baselineHead: string,
  baselineIds?: ReadonlySet<string>,
): Map<string, MigrationProbe> {
  const isNew = (id: string): boolean => id > baselineHead || (baselineIds !== undefined && !baselineIds.has(id));
  failIfAny(
    "a migration after the baseline needs a probe",
    entries.filter((e) => !e.probe && isNew(e.id)).map((e) => e.id),
  );
  const probed = entries.filter((e): e is Required<MigrationEntry> => e.probe !== undefined);
  failIfAny(
    "probe reads the same applied and rolled back",
    probed.filter((e) => same(e.probe.applied, e.probe.rolledBack)).map((e) => e.id),
  );
  return new Map(probed.map((e) => [e.id, e.probe]));
}

/**
 * Check the drizzle file names against the registry and return the chain.
 * Pure: `files` is a directory listing, `entries` the registry, `baselineHead`
 * the last migration the frozen baseline covers and `baselineIds` every id it
 * holds.
 */
export function resolveMigrations(
  files: readonly string[],
  entries: readonly MigrationEntry[],
  baselineHead: string,
  baselineIds?: ReadonlySet<string>,
): ResolvedMigrations {
  const { ups, downs } = migrationFiles(files);
  const ids = entries.map((e) => e.id);
  checkFiles(ids, ups, downs);
  const probes = collectProbes(entries, baselineHead, baselineIds);
  const ordered = [...ids].sort();
  const head = ordered[ordered.length - 1];
  if (head === undefined) fail("no migrations", []);
  if (!probes.has(head)) fail("the head migration has no probe", [head]);
  return { ids: ordered, head, probes };
}

/** One probe reading that does not match what the chain state expects. */
export interface ProbeMismatch {
  readonly id: string;
  readonly expected: readonly string[];
  readonly actual: readonly string[];
}

/**
 * Compare readings with the expected state: `rolledBack` migrations must read
 * their `rolledBack` value, every other probed migration its `applied` one.
 */
export function probeMismatches(
  probes: ReadonlyMap<string, MigrationProbe>,
  readings: ReadonlyMap<string, readonly string[]>,
  rolledBack: ReadonlySet<string>,
): ProbeMismatch[] {
  const out: ProbeMismatch[] = [];
  for (const [id, probe] of probes) {
    const expected = rolledBack.has(id) ? probe.rolledBack : probe.applied;
    const actual = readings.get(id) ?? [];
    if (!same(expected, actual)) out.push({ id, expected, actual });
  }
  return out;
}

const FRAGMENT_FILE = /^(\d{4}_[a-z0-9_]+)\.ts$/;

/**
 * Load `./migrations/`: `baseline.ts` (BASELINE_MIGRATIONS) and one
 * `<id>.ts` per later migration (MIGRATION, whose id must equal the file
 * name). Any other file fails, so a misnamed fragment cannot be skipped.
 */
export function loadMigrationRegistry(dir = REGISTRY_DIR): MigrationEntry[] {
  const entries: MigrationEntry[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (file === "baseline.ts") continue;
    const match = FRAGMENT_FILE.exec(file);
    if (!match) fail("unexpected file in the registry directory", [file]);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const entry = (require(resolve(dir, file)) as { MIGRATION?: MigrationEntry }).MIGRATION;
    if (entry === undefined || entry.id !== match[1]) {
      fail("fragment must export MIGRATION with id equal to its file name", [file]);
    }
    entries.push(entry);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BASELINE_MIGRATIONS } = require(resolve(dir, "baseline.ts")) as { BASELINE_MIGRATIONS: MigrationEntry[] };
  return [...BASELINE_MIGRATIONS, ...entries];
}

/** The chain the runner will apply, checked against the drizzle directory. */
export function resolveMigrationRegistry(): ResolvedMigrations {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BASELINE_HEAD, BASELINE_MIGRATIONS } = require(resolve(REGISTRY_DIR, "baseline.ts")) as {
    BASELINE_HEAD: string;
    BASELINE_MIGRATIONS: MigrationEntry[];
  };
  const baselineIds = new Set(BASELINE_MIGRATIONS.map((e) => e.id));
  return resolveMigrations(readdirSync(DRIZZLE_DIR), loadMigrationRegistry(), BASELINE_HEAD, baselineIds);
}
