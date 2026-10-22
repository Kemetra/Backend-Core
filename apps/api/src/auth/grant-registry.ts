/**
 * RT-812 — merge the grants fragments in `./grants/` into the lists the API
 * boot check verifies (`DOMAIN_REQUIRED_GRANTS`, `AUTH_LOOKUP_FORBIDDEN_GRANTS`
 * in database-pools.ts). See grant-fragment.ts for one fragment's shape.
 *
 * Loading happens once, at import, and fails closed: a missing directory or
 * baseline, a stray file, a malformed fragment or an entry declared twice
 * throws, so the API refuses to boot rather than check fewer grants.
 */
import { join } from "node:path";
import { loadFragmentDir, type LoadedFragment } from "@data-pulse-2/shared";
import type { DomainGrant, ForbiddenGrant, GrantFragment } from "./grant-fragment";

export interface GrantRegistry {
  readonly domainRequired: readonly DomainGrant[];
  readonly lookupForbidden: readonly ForbiddenGrant[];
  /** routine deploy script → the fragment that pairs with it. */
  readonly deployScripts: Readonly<Record<string, string>>;
  /** table → why the lookup role may be granted on it. */
  readonly lookupAllowed: Readonly<Record<string, string>>;
  /** The validated fragments in load order (baseline first). */
  readonly fragments: readonly { readonly name: string; readonly grants: GrantFragment }[];
}

const PRIVILEGES = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]);
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const ROUTINE_SCRIPT = /^[a-z0-9][a-z0-9-]*-domain-grants\.sql$/;

/** Checks one fragment's GRANTS export; every error names the fragment. */
class FragmentValidator {
  constructor(private readonly fragment: string) {}

  fail(problem: string): never {
    throw new Error(`grants fragment ${this.fragment}: ${problem}`);
  }

  list(grants: Record<string, unknown>, key: keyof GrantFragment): unknown[] {
    const value = grants[key];
    if (!Array.isArray(value)) this.fail(`${key} must be an array`);
    return value;
  }

  script(script: unknown): void {
    if (typeof script !== "string" || !ROUTINE_SCRIPT.test(script)) {
      this.fail(`deploy script ${String(script)} must be named <slug>-domain-grants.sql`);
    }
  }

  table(table: unknown): void {
    if (typeof table !== "string" || !IDENTIFIER.test(table)) this.fail(`"${String(table)}" is not a table name`);
  }

  /** A [table, privileges] pair whose privileges are all real table privileges. */
  pair(entry: unknown): void {
    const pair = Array.isArray(entry) && entry.length === 2 ? entry : [];
    const [table, privileges] = pair as unknown[];
    if (typeof table !== "string" || typeof privileges !== "string") {
      this.fail(`${JSON.stringify(entry)} is not a [table, privilege] pair`);
    }
    this.table(table);
    for (const privilege of privileges.split(",").map((p) => p.trim())) {
      if (!PRIVILEGES.has(privilege)) this.fail(`"${privilege}" is not a table privilege`);
    }
  }

  /** A lookupAllowed entry: a table and a non-blank written reason. */
  allowed(entry: unknown): void {
    const { table, reason } = (entry ?? {}) as { table?: unknown; reason?: unknown };
    const written = typeof reason === "string" ? reason.trim() : "";
    if (typeof table !== "string" || written === "") this.fail("lookupAllowed entries need a table and a written reason");
    this.table(table);
  }
}

/** Validate one fragment's `GRANTS` export and return it typed. */
function validateFragment({ name, exports }: LoadedFragment): GrantFragment {
  const check = new FragmentValidator(name);
  const grants = (exports as { GRANTS?: unknown } | null)?.GRANTS;
  if (typeof grants !== "object" || grants === null) check.fail("must export GRANTS");
  const raw = grants as Record<string, unknown>;
  check.list(raw, "deployScripts").forEach((script) => check.script(script));
  check.list(raw, "domainRequired").forEach((entry) => check.pair(entry));
  check.list(raw, "lookupForbidden").forEach((entry) => check.pair(entry));
  check.list(raw, "lookupAllowed").forEach((entry) => check.allowed(entry));
  return grants as GrantFragment;
}

/** Which fragment declared each key of one kind; a key declared by two fragments throws. */
class Claims {
  private readonly owners = new Map<string, string>();

  constructor(private readonly kind: string) {}

  claim(key: string, owner: string): void {
    const previous = this.owners.get(key);
    if (previous !== undefined) throw new Error(`${this.kind} ${key} is declared by both ${previous} and ${owner}`);
    this.owners.set(key, owner);
  }

  entries(): Record<string, string> {
    return Object.fromEntries(this.owners);
  }
}

interface RegistryClaims {
  readonly domain: Claims;
  readonly forbidden: Claims;
  readonly scripts: Claims;
  readonly allowed: Claims;
}

function claimFragment({ name, grants }: { name: string; grants: GrantFragment }, claims: RegistryClaims): void {
  for (const [table, privilege] of grants.domainRequired) claims.domain.claim(`${privilege} ON ${table}`, name);
  for (const [table] of grants.lookupForbidden) claims.forbidden.claim(table, name);
  for (const script of grants.deployScripts) claims.scripts.claim(script, name);
  for (const { table } of grants.lookupAllowed) claims.allowed.claim(table, name);
}

/** Merge loaded fragments. Exported for the registry tests. */
export function buildGrantRegistry(loaded: readonly LoadedFragment[]): GrantRegistry {
  const fragments = loaded.map((f) => ({ name: f.name, grants: validateFragment(f) }));
  const claims: RegistryClaims = {
    domain: new Claims("domain grant"),
    forbidden: new Claims("forbidden table"),
    scripts: new Claims("deploy script"),
    allowed: new Claims("allowed table"),
  };
  fragments.forEach((fragment) => claimFragment(fragment, claims));
  const allowed = fragments.flatMap(({ grants }) => grants.lookupAllowed);
  const forbidden = claims.forbidden.entries();
  const conflicting = allowed.find(({ table }) => Object.hasOwn(forbidden, table));
  if (conflicting) throw new Error(`lookup table ${conflicting.table} is both forbidden and allowed`);
  return {
    domainRequired: Object.freeze(fragments.flatMap(({ grants }) => grants.domainRequired)),
    lookupForbidden: Object.freeze(fragments.flatMap(({ grants }) => grants.lookupForbidden)),
    deployScripts: Object.freeze(claims.scripts.entries()),
    lookupAllowed: Object.freeze(Object.fromEntries(allowed.map(({ table, reason }) => [table, reason]))),
    fragments: Object.freeze(fragments),
  };
}

/** Where to load fragments from; the boot path uses the defaults (`./grants` beside this file). */
export interface GrantSource {
  readonly dir: string;
  /** Decides whether the `.ts` sources or the compiled `.js` siblings load. */
  readonly callerFile: string;
}

export function loadGrantRegistry(
  source: GrantSource = { dir: join(__dirname, "grants"), callerFile: __filename },
): GrantRegistry {
  return buildGrantRegistry(loadFragmentDir(source.dir, ".grants", source.callerFile));
}

export const GRANT_REGISTRY: GrantRegistry = loadGrantRegistry();
