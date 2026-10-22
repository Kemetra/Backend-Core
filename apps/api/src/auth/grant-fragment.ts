/**
 * RT-812 — the shape of one grants fragment (`./grants/<slug>.grants.ts`).
 *
 * Runtime grants are provisioned outside migrations (docs/operations/
 * database-roles.md). Each feature that needs a domain-role grant, or adds a
 * table the BYPASSRLS auth lookup role must not touch, ships one fragment
 * beside its deploy script instead of editing a shared list, so parallel PRs
 * never conflict. `grant-registry.ts` merges the fragments; the API boot check
 * (`database-pools.ts`) verifies the result. `baseline.grants.ts` holds
 * everything registered before RT-812 and is frozen.
 *
 * Fragments import only from this file, so they compile on their own.
 */

/** [table, privilege]: one privilege the domain (DATABASE_URL) role must hold. */
export type DomainGrant = readonly [table: string, privilege: string];

/** [table, comma-separated privileges]: none of them may be held by the lookup role. */
export type ForbiddenGrant = readonly [table: string, privileges: string];

export interface GrantFragment {
  /**
   * The routine `docs/operations/sql/<x>-domain-grants.sql` scripts this
   * fragment pairs with. Each must carry the `-- deploy: every-release`
   * marker, and their GRANTs must equal `domainRequired` exactly (a test).
   */
  readonly deployScripts: readonly string[];
  /** Privileges the domain role must hold; the API refuses to boot without them. */
  readonly domainRequired: readonly DomainGrant[];
  /** Tables the auth lookup role must hold none of the listed privileges on. */
  readonly lookupForbidden: readonly ForbiddenGrant[];
  /**
   * New tables the lookup role may be granted on, each with the reason. Every
   * table a post-baseline migration creates must be forbidden or allowed here.
   */
  readonly lookupAllowed: readonly { readonly table: string; readonly reason: string }[];
}

/**
 * RT-212: every PostgreSQL table privilege. The lookup role has BYPASSRLS,
 * and TRUNCATE is not subject to row security for any role, so a forbidden
 * table must be checked for all of them, not only SELECT/INSERT/UPDATE/DELETE.
 */
export const ALL_TABLE_PRIVILEGES = "SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER";
/** Every table privilege except SELECT: membership reads are not forbidden. */
export const ALL_PRIVILEGES_EXCEPT_SELECT = "INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER";
