/**
 * RT-796 — provider-name fence (provider-neutral identity programme, 1/5).
 *
 * A provider name (`clerk`, `descope`) may appear only inside that provider's
 * adapter files and the one factory switch that selects an adapter. Services,
 * guards, DI tokens, SQL, DTOs, refusal codes and logs use neutral names, so
 * switching identity provider means adding one adapter and one switch case.
 *
 * The scan covers every `.ts` file under apps/<app>/src and packages/<pkg>/src
 * and counts case-insensitive `clerk|descope` matches per file. A file passes
 * only if it is allow-listed: adapter files unconditionally, leftover files up
 * to an exact cap. Each leftover names the ticket that removes it, so the
 * later phases shrink this list instead of growing it:
 *
 *   RT-797 — cutover CLI flips identity links only (retire clerk_user_id write)
 *   RT-798 — provider-neutral OpenAPI wording (published schema names)
 *   RT-799 — drop users.clerk_user_id (schema and seed)
 *
 * Negative self-tests prove the scanner fails on a new occurrence and on a
 * stale allow-list entry.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const PROVIDER_NAME = /clerk|descope/gi;

type Owner = "adapter" | "RT-797" | "RT-798" | "RT-799";

interface AllowEntry {
  readonly path: string;
  readonly owner: Owner;
  /** Maximum matches in the file. Omitted: the whole file is an adapter. */
  readonly max?: number;
}

/** A source file under scan. */
interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** Adapters (and the factory switch) name their provider by design. */
const ADAPTER_FILES: readonly AllowEntry[] = [
  "apps/api/src/auth/clerk-identity-provider.adapter.ts",
  "apps/api/src/auth/descope-identity-provider.adapter.ts",
  "apps/api/src/auth/identity-provider-kind.ts",
  "apps/api/src/auth/identity-provider.factory.ts",
  "apps/api/src/pos-operators/clerk-verifier.ts",
  "apps/api/src/pos-operators/descope-verifier.ts",
  "packages/auth/src/clerk-jwt.ts",
].map((path) => ({ path, owner: "adapter" as const }));

/** Known leftovers, each owned by a later phase of the programme. */
const LEFTOVERS: readonly AllowEntry[] = [
  // The package barrel re-exports the Clerk adapter primitive.
  { path: "packages/auth/src/index.ts", owner: "adapter", max: 1 },
  // The provider-migration CLI is provider-specific until it flips links only.
  { path: "packages/db/src/cli/descope-cutover.ts", owner: "RT-797", max: 190 },
  // Pilot seed writes the bridge column (and doc-comments it).
  { path: "packages/db/src/cli/bootstrap-pilot.ts", owner: "RT-799", max: 28 },
  // The bridge column itself.
  { path: "packages/db/src/schema/users.ts", owner: "RT-799", max: 3 },
  { path: "packages/db/src/schema/devices.ts", owner: "RT-799", max: 1 },
  // Rejected request-field names (`clerk_session_token`) and the payload denylist that
  // mirror the OpenAPI request bodies (the schema wording itself is RT-798).
  { path: "apps/api/src/pos-operators/dto.ts", owner: "RT-798", max: 2 },
  { path: "apps/api/src/pos-audit-events/dto.ts", owner: "RT-798", max: 2 },
];

const ALLOW_LIST: readonly AllowEntry[] = [...ADAPTER_FILES, ...LEFTOVERS];

const SKIPPED_DIRS = new Set(["node_modules", "dist"]);

function isTypescriptSource(fileName: string): boolean {
  return fileName.endsWith(".ts") && !fileName.endsWith(".d.ts");
}

/** Every non-declaration `.ts` file under `dir`, skipping dependency and build output. */
function typescriptFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : typescriptFilesUnder(full);
    return isTypescriptSource(entry.name) ? [full] : [];
  });
}

/** `apps/<app>/src` and `packages/<pkg>/src` directories that exist. */
function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ["apps", "packages"]) {
    for (const member of readdirSync(join(REPO_ROOT, group), { withFileTypes: true })) {
      const src = join(REPO_ROOT, group, member.name, "src");
      if (member.isDirectory() && existsSync(src)) roots.push(src);
    }
  }
  return roots;
}

function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

function readSources(): SourceFile[] {
  return sourceRoots()
    .flatMap(typescriptFilesUnder)
    .map((path) => ({ path: repoRelative(path), text: readFileSync(path, "utf8") }));
}

function countMatches(text: string): number {
  return text.match(PROVIDER_NAME)?.length ?? 0;
}

/** The violation for one scanned file, or null when it is allowed. */
function violationOf(path: string, count: number, entry: AllowEntry | undefined): string | null {
  if (count === 0) return null;
  if (!entry) return `${path}: ${count} provider-name occurrence(s) outside the allow-list`;
  if (entry.max !== undefined && count > entry.max) {
    return `${path}: ${count} occurrences exceed the ${entry.owner} cap of ${entry.max}`;
  }
  return null;
}

/** Violations of the fence: new occurrences, and allow-list entries gone stale. */
function findViolations(files: readonly SourceFile[], allow: readonly AllowEntry[]): string[] {
  const allowed = new Map(allow.map((entry) => [entry.path, entry]));
  const counts = new Map(files.map((file) => [file.path, countMatches(file.text)]));
  const found = [...counts].map(([path, count]) => violationOf(path, count, allowed.get(path)));
  const stale = allow
    .filter((entry) => (counts.get(entry.path) ?? 0) === 0)
    .map((entry) => `${entry.path}: stale allow-list entry (${entry.owner}); remove it`);
  return [...found.filter((v): v is string => v !== null), ...stale];
}

describe("RT-796 provider-name fence", () => {
  it("keeps provider names inside the allow-listed adapter and leftover files", () => {
    expect(findViolations(readSources(), ALLOW_LIST)).toEqual([]);
  });

  it("scans both apps and packages", () => {
    const paths = readSources().map((file) => file.path);
    expect(paths.some((p) => p.startsWith("apps/api/src/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("packages/auth/src/"))).toBe(true);
  });

  describe("scanner self-tests", () => {
    const allow: readonly AllowEntry[] = [
      { path: "apps/api/src/auth/a.adapter.ts", owner: "adapter" },
      { path: "packages/db/src/cli/x.ts", owner: "RT-797", max: 2 },
    ];

    it("fails on a provider name in a file that is not allow-listed", () => {
      const files: SourceFile[] = [
        { path: "apps/api/src/auth/a.adapter.ts", text: "clerk" },
        { path: "apps/api/src/pos-shifts/new.ts", text: "const x = 'Descope';" },
      ];
      expect(findViolations(files, allow)).toEqual([
        "apps/api/src/pos-shifts/new.ts: 1 provider-name occurrence(s) outside the allow-list",
        "packages/db/src/cli/x.ts: stale allow-list entry (RT-797); remove it",
      ]);
    });

    it("fails when a leftover grows past its cap, and passes at the cap", () => {
      const at = [{ path: "packages/db/src/cli/x.ts", text: "clerk descope" }];
      const over = [{ path: "packages/db/src/cli/x.ts", text: "clerk descope CLERK" }];
      const adapter = { path: "apps/api/src/auth/a.adapter.ts", text: "descope" };
      expect(findViolations([adapter, ...at], allow)).toEqual([]);
      expect(findViolations([adapter, ...over], allow)).toEqual([
        "packages/db/src/cli/x.ts: 3 occurrences exceed the RT-797 cap of 2",
      ]);
    });

    it("counts a provider name inside a larger identifier or an import path", () => {
      expect(countMatches("import x from '../pos-operators/clerk-verifier';")).toBe(1);
      expect(countMatches("const clerkSubject = ClerkVerifier;")).toBe(2);
      expect(countMatches("OperatorTokenVerifier")).toBe(0);
    });
  });
});
