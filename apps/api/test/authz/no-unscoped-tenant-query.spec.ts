/**
 * T208 — no-unscoped-tenant-query guard.
 *
 * Guarantee: every file under apps/api/src/**\/*.ts that
 *   1. calls drizzle(…), AND
 *   2. references at least one tenant-scoped table name
 * must EITHER:
 *   a) import / reference PoolClient or runWithTenantContext  (RLS-scoped
 *      call site), OR
 *   b) be in the hard-coded ALLOWLIST (deliberately unscoped with a
 *      documented reason).
 *
 * Files that trigger BOTH conditions but satisfy NEITHER a) nor b) are
 * a failing test case naming the offending file and the matched table.
 *
 * Rule: the ALLOWLIST is the ONLY opt-out mechanism for the primary CI
 * guard. File-level /* no-rls-scope: … *\/ comments are reserved for
 * the ESLint rule (tools/eslint-rules/no-unscoped-tenant-query.js) and
 * have no effect here.
 *
 * Style: hand-rolled, Docker-free, no NestJS test module — mirrors
 * apps/api/test/authz/default-deny.spec.ts.
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Canonical tenant-scoped table names drawn from
 * packages/db/src/helpers/with-tenant.ts TENANT_SCOPED_TABLES plus their
 * camelCase Drizzle aliases. Sessions and users are intentionally absent —
 * they are not tenant-scoped tables in the foundation schema.
 */
const TENANT_SCOPED_TABLES: ReadonlyArray<string> = [
  "tenants",
  "stores",
  "memberships",
  "store_access",
  "storeAccess",
  "roles",
  "auth_tokens",
  "authTokens",
  "invitations",
  "audit_events",
  "auditEvents",
  "idempotency_keys",
  "idempotencyKeys",
];

/**
 * Files that legitimately perform Drizzle queries on a plain Pool (no RLS
 * context) against tenant-scoped tables. Each entry must have a documented
 * reason explaining the deliberate exception.
 *
 * IMPORTANT: paths are POSIX-style (forward slashes), relative to the repo
 * root. Windows backslashes are normalised before comparison.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "apps/api/src/auth/session.repository.ts",
    reason:
      "sessions table is not RLS tenant-scoped (data-model.md §9)",
  },
  {
    file: "apps/api/src/auth/auth-token.repository.ts",
    reason:
      "admin pool / pre-context lookup; optional PoolClient parameter for tenant-scoped callers",
  },
  {
    file: "apps/api/src/context/membership.repository.ts",
    reason:
      "guard-stack pre-context membership lookup; runs before TenantContextGuard resolves the tenant",
  },
  {
    file: "apps/api/src/tenants/tenants.repository.ts",
    reason:
      "platform-admin and membership-cross-tenant list paths; per-tenant paths use PoolClient",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect all .ts files under `dir`. */
function collectTs(dir: string): string[] {
  const result: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectTs(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      result.push(fullPath);
    }
  }
  return result;
}

/** Normalise an absolute path to a POSIX-style path relative to repoRoot. */
function toPosixRelative(absPath: string, repoRoot: string): string {
  return path.relative(repoRoot, absPath).replace(/\\/g, "/");
}

/**
 * Return the set of names imported from `@data-pulse-2/db/schema` in the
 * given source file. Only the schema package can export Drizzle table
 * objects; a file that does NOT import a table from the schema cannot
 * be issuing Drizzle queries against that table.
 *
 * Parses import declarations of the form:
 *   import { foo, bar, type Baz } from "@data-pulse-2/db/schema";
 *   import { foo, bar } from "@data-pulse-2/db/schema";
 */
function schemaImports(source: string): Set<string> {
  const result = new Set<string>();
  // Match every `import { ... } from "@data-pulse-2/db/schema"` block.
  const importRe =
    /import\s*\{([^}]+)\}\s*from\s*["']@data-pulse-2\/db\/schema["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    const names = m[1]!.split(",").map((n) =>
      // Strip leading "type " keyword and trim whitespace.
      n.replace(/^\s*type\s+/, "").trim(),
    );
    for (const name of names) {
      if (name) result.add(name);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

interface Violation {
  relPath: string;
  matchedTable: string;
}

function scanSourceFiles(): Violation[] {
  // Repo root is two levels above apps/api/test/authz/ (i.e., data-pulse-t208).
  const testDir = path.resolve(__dirname);
  // __dirname = apps/api/test/authz
  const repoRoot = path.resolve(testDir, "..", "..", "..", "..");
  const srcDir = path.join(repoRoot, "apps", "api", "src");

  const allowlistSet = new Set(ALLOWLIST.map((e) => e.file));
  const tenantTableSet = new Set(TENANT_SCOPED_TABLES);

  const violations: Violation[] = [];

  for (const absPath of collectTs(srcDir)) {
    const relPath = toPosixRelative(absPath, repoRoot);
    const rawContent = fs.readFileSync(absPath, "utf8");

    // Gate 1: must call drizzle( somewhere in the file.
    if (!rawContent.includes("drizzle(")) continue;

    // Gate 2: must import at least one tenant-scoped table from the schema
    // package. This is the tightest proxy for "file issues Drizzle queries
    // against that table" — a bare identifier named `authTokens` or `stores`
    // that is NOT the schema table object does NOT import it from the schema.
    const imports = schemaImports(rawContent);
    const matchedTableName = [...imports].find((name) => tenantTableSet.has(name));
    if (!matchedTableName) continue;

    // Exemption a: file is in the hard-coded allowlist
    if (allowlistSet.has(relPath)) continue;

    // Exemption b: file references PoolClient or runWithTenantContext
    // (checked against raw content — these identifiers appear in import
    // declarations and function signatures, not typically in comments).
    if (
      rawContent.includes("PoolClient") ||
      rawContent.includes("runWithTenantContext")
    ) {
      continue;
    }

    violations.push({ relPath, matchedTable: matchedTableName });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T208 — no-unscoped-tenant-query: every drizzle call against a tenant-scoped table must be RLS-scoped", () => {
  let violations: Violation[];

  beforeAll(() => {
    violations = scanSourceFiles();
  });

  it("finds zero un-tenant-scoped Drizzle queries in apps/api/src/**/*.ts", () => {
    if (violations.length === 0) return;

    const detail = violations
      .map((v) => `  ${v.relPath}  [matched table: ${v.matchedTable}]`)
      .join("\n");

    throw new Error(
      `Un-tenant-scoped Drizzle queries detected (${violations.length} file(s)).\n` +
        "Each file below calls drizzle() AND references a tenant-scoped table\n" +
        "without either PoolClient typing or runWithTenantContext.\n" +
        "Add the file to ALLOWLIST with a documented reason, OR\n" +
        "refactor the file to use a PoolClient / runWithTenantContext call.\n\n" +
        detail,
    );
  });

  it("ALLOWLIST entries all exist on disk (no stale entries)", () => {
    const testDir = path.resolve(__dirname);
    const repoRoot = path.resolve(testDir, "..", "..", "..", "..");
    const stale: string[] = [];
    for (const entry of ALLOWLIST) {
      const abs = path.join(repoRoot, ...entry.file.split("/"));
      if (!fs.existsSync(abs)) {
        stale.push(entry.file);
      }
    }
    if (stale.length > 0) {
      throw new Error(
        "Stale ALLOWLIST entries (files no longer exist on disk):\n" +
          stale.map((f) => `  ${f}`).join("\n") +
          "\nRemove them from the ALLOWLIST in this file.",
      );
    }
  });
});
