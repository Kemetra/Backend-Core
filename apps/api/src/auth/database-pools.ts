import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Pool } from "pg";

import { InstrumentedPool } from "../observability/instrumented-pool";

export const PG_POOL = "PG_POOL";
export const AUTH_LOOKUP_POOL = "AUTH_LOOKUP_POOL";

const ownedPools = new WeakSet<Pool>();

function createOwnedPool(connectionString: string): Pool {
  const pool = new InstrumentedPool({ connectionString });
  ownedPools.add(pool);
  return pool;
}

export function domainPoolFactory(): Pool {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("AuthModule: DATABASE_URL is not set; cannot create domain pg.Pool");
  }
  return createOwnedPool(url);
}

/**
 * Pre-tenant identity/token/device lookup pool.
 *
 * Production must provide a distinct credential. Tests and local development
 * may deliberately reuse an injected PG_POOL so hermetic module tests do not
 * need a second database user. That fallback is never available in production.
 */
export function authLookupPoolFactory(domainPool: Pool): Pool {
  const lookupUrl = process.env["AUTH_LOOKUP_DATABASE_URL"];
  if (!lookupUrl) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "AuthModule: AUTH_LOOKUP_DATABASE_URL is required in production; " +
          "pre-tenant lookups must not reuse the domain pool",
      );
    }
    return domainPool;
  }

  const domainUrl = process.env["DATABASE_URL"];
  if (process.env["NODE_ENV"] === "production" && lookupUrl === domainUrl) {
    throw new Error(
      "AuthModule: AUTH_LOOKUP_DATABASE_URL must use credentials distinct from DATABASE_URL",
    );
  }
  return createOwnedPool(lookupUrl);
}

interface RoleRow {
  role_name: string;
  is_superuser: boolean;
  bypass_rls: boolean;
}

async function readRole(pool: Pool): Promise<RoleRow> {
  const result = await pool.query<RoleRow>(
    `SELECT current_user AS role_name,
            r.rolsuper AS is_superuser,
            r.rolbypassrls AS bypass_rls
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  );
  const role = result.rows[0];
  if (!role) throw new Error("database pool role could not be resolved");
  return role;
}

/**
 * RT-143: the lookup role has BYPASSRLS, so its TABLE GRANTS are its whole
 * privilege boundary (docs/operations/database-roles.md). Each entry is one
 * privilege the auth boundary needs; boot fails if any is missing.
 */
export const AUTH_LOOKUP_REQUIRED_GRANTS: ReadonlyArray<readonly [string, string]> = [
  ["users", "SELECT"],
  ["users", "UPDATE"],
  ["sessions", "SELECT"],
  ["sessions", "INSERT"],
  ["sessions", "UPDATE"],
  ["auth_tokens", "SELECT"],
  ["auth_tokens", "INSERT"],
  ["auth_tokens", "UPDATE"],
  ["devices", "SELECT"],
  ["stores", "SELECT"],
  ["external_identity_links", "SELECT"],
  ["connector_registration", "SELECT"],
  ["pairing_codes", "SELECT"],
];

/**
 * RT-212: every PostgreSQL table privilege. The lookup role has BYPASSRLS,
 * and TRUNCATE is not subject to row security for any role, so a forbidden
 * table must be checked for all of them, not only SELECT/INSERT/UPDATE/DELETE.
 */
const ALL_TABLE_PRIVILEGES = "SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER";
/** Every table privilege except SELECT: membership reads are not forbidden. */
const ALL_PRIVILEGES_EXCEPT_SELECT = "INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER";

/**
 * Tables the lookup role must hold NO listed privilege on (sales,
 * receivables, cashier admissions, shift cash-up, tenants, inventory, audit,
 * idempotency, outbox, membership mutation).
 * Each entry is a table and the privileges that are forbidden on it.
 */
export const AUTH_LOOKUP_FORBIDDEN_GRANTS: ReadonlyArray<readonly [string, string]> = [
  ...[
    "sales",
    "sale_lines",
    "sale_tenders",
    "sale_voids",
    "sale_refunds",
    "sale_returns",
    "sale_return_lines",
    "sale_return_tenders",
    "sale_sync_deadletters",
    "receivable",
    "claim",
    "claim_receivables",
    "payment_application",
    "remittance",
    "payer_account",
    // RT-113 BC2: cashier admission state and its replay store.
    "cashier_admissions",
    "cashier_admission_requests",
    // RT-17 (0036): shift cash-up facts. `shifts` holds the cash-up opens.
    "shifts",
    "shift_closes",
    "shift_cash_movements",
    "shift_refund_claims",
    // RT-213: with BYPASSRLS any grant on tenants would expose every tenant
    // row. Device auth reads tenant status on the domain role instead.
    "tenants",
    "stock_movements",
    "stock_counts",
    "audit_events",
    "idempotency_keys",
    "outbox_events",
  ].map((table) => [table, ALL_TABLE_PRIVILEGES] as const),
  ["memberships", ALL_PRIVILEGES_EXCEPT_SELECT],
  ["store_access", ALL_PRIVILEGES_EXCEPT_SELECT],
];

/**
 * RT-212: grants the domain (DATABASE_URL) role must hold. Runtime grants
 * are provisioned outside migrations, so a deploy that skips a grant step
 * would otherwise boot healthy while the affected routes return 500. Each
 * entry is one privilege; boot fails if any is missing.
 *
 * Starts with the tables whose grants are documented as a separate deploy
 * step (migrations 0035 and 0036, docs/operations/database-roles.md). Add a
 * table here when a migration adds one the domain role must use.
 */
export const DOMAIN_REQUIRED_GRANTS: ReadonlyArray<readonly [string, string]> = [
  // RT-113 BC2 (0035): admissions are ended, never deleted.
  ["cashier_admissions", "SELECT"],
  ["cashier_admissions", "INSERT"],
  ["cashier_admissions", "UPDATE"],
  // The replay store also purges expired entries.
  ["cashier_admission_requests", "SELECT"],
  ["cashier_admission_requests", "INSERT"],
  ["cashier_admission_requests", "UPDATE"],
  ["cashier_admission_requests", "DELETE"],
  // RT-213: every device-authenticated request reads the device's tenant
  // status on this role (DeviceRepository, inside the tenant's RLS context).
  // Without the grant every till would be refused at once, so boot fails.
  ["tenants", "SELECT"],
  // RT-17 (0036): the shift cash-up writes. `shifts` gains cash-up rows and
  // needs UPDATE: the close moves the shift to closed, and the 0036 triggers
  // lock the shift row FOR SHARE / FOR UPDATE, which requires UPDATE. The
  // three fact tables are append-only (no UPDATE, DELETE or TRUNCATE).
  ["shifts", "SELECT"],
  ["shifts", "INSERT"],
  ["shifts", "UPDATE"],
  ["shift_closes", "SELECT"],
  ["shift_closes", "INSERT"],
  ["shift_cash_movements", "SELECT"],
  ["shift_cash_movements", "INSERT"],
  ["shift_refund_claims", "SELECT"],
  ["shift_refund_claims", "INSERT"],
];

interface GrantRow {
  table_name: string;
  privilege: string;
  granted: boolean;
}

/**
 * `has_table_privilege` for each (table, privilege-list) pair; a list is
 * true when ANY listed privilege is held. Tables that do not exist yet are
 * reported as not granted (a required one then fails, a forbidden one passes).
 */
async function readGrants(
  pool: Pool,
  checks: ReadonlyArray<readonly [string, string]>,
): Promise<GrantRow[]> {
  const result = await pool.query<GrantRow>(
    `SELECT t.table_name, t.privilege,
            CASE WHEN to_regclass('public.' || t.table_name) IS NULL THEN false
                 ELSE has_table_privilege(current_user,
                        to_regclass('public.' || t.table_name), t.privilege)
            END AS granted
       FROM unnest($1::text[], $2::text[]) AS t(table_name, privilege)`,
    [checks.map(([table]) => table), checks.map(([, privilege]) => privilege)],
  );
  return result.rows;
}

function formatGrants(grants: ReadonlyArray<GrantRow>): string {
  return grants.map((g) => `${g.privilege} ON ${g.table_name}`).join(", ");
}

async function assertDomainGrants(domainPool: Pool): Promise<void> {
  const required = await readGrants(domainPool, DOMAIN_REQUIRED_GRANTS);
  const missing = required.filter((g) => !g.granted);
  if (missing.length > 0) {
    throw new Error(
      "AuthModule: DATABASE_URL role is missing required grants: " +
        formatGrants(missing) +
        " (see docs/operations/database-roles.md)",
    );
  }
}

async function assertLookupGrants(lookupPool: Pool): Promise<void> {
  const [required, forbidden] = await Promise.all([
    readGrants(lookupPool, AUTH_LOOKUP_REQUIRED_GRANTS),
    readGrants(lookupPool, AUTH_LOOKUP_FORBIDDEN_GRANTS),
  ]);
  const missing = required.filter((g) => !g.granted);
  if (missing.length > 0) {
    throw new Error(
      "AuthModule: AUTH_LOOKUP_DATABASE_URL role is missing required grants: " +
        formatGrants(missing) +
        " (see docs/operations/database-roles.md)",
    );
  }
  const excess = forbidden.filter((g) => g.granted);
  if (excess.length > 0) {
    throw new Error(
      "AuthModule: AUTH_LOOKUP_DATABASE_URL role holds forbidden grants on: " +
        excess.map((g) => g.table_name).join(", ") +
        " (see docs/operations/database-roles.md)",
    );
  }
}

/** Exported for Testcontainers proof of the production role boundary. */
export async function verifyDatabasePoolBoundary(
  domainPool: Pool,
  lookupPool: Pool,
): Promise<void> {
  const [domainRole, lookupRole] = await Promise.all([
    readRole(domainPool),
    readRole(lookupPool),
  ]);

  assertDomainRole(domainRole);
  assertLookupRole(lookupRole, domainRole.role_name);
  await assertDomainGrants(domainPool);
  await assertLookupGrants(lookupPool);
}

function assertDomainRole(domainRole: RoleRow): void {
  if (domainRole.is_superuser || domainRole.bypass_rls) {
    throw new Error(
      "AuthModule: DATABASE_URL role must be non-superuser and must not have BYPASSRLS",
    );
  }
}

function assertLookupRole(lookupRole: RoleRow, domainRoleName: string): void {
  if (lookupRole.is_superuser) {
    throw new Error("AuthModule: AUTH_LOOKUP_DATABASE_URL role must not be a superuser");
  }
  if (!lookupRole.bypass_rls) {
    throw new Error(
      "AuthModule: AUTH_LOOKUP_DATABASE_URL role must have BYPASSRLS for pre-tenant lookups",
    );
  }
  if (domainRoleName === lookupRole.role_name) {
    throw new Error(
      "AuthModule: domain and pre-tenant lookup pools must use distinct database roles",
    );
  }
}

@Injectable()
export class DatabasePoolBoundaryVerifier implements OnModuleInit {
  constructor(
    @Inject(PG_POOL) private readonly domainPool: Pool,
    @Inject(AUTH_LOOKUP_POOL) private readonly lookupPool: Pool,
  ) {}

  async onModuleInit(): Promise<void> {
    if (
      process.env["NODE_ENV"] === "production" ||
      process.env["VERIFY_DATABASE_POOL_BOUNDARY"] === "1"
    ) {
      await verifyDatabasePoolBoundary(this.domainPool, this.lookupPool);
    }
  }
}

/** Close only pools created by this module; never close test-supplied pools. */
@Injectable()
export class DatabasePoolLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(PG_POOL) private readonly domainPool: Pool,
    @Inject(AUTH_LOOKUP_POOL) private readonly lookupPool: Pool,
  ) {}

  async onModuleDestroy(): Promise<void> {
    const pools = new Set([this.domainPool, this.lookupPool]);
    await Promise.all(
      [...pools]
        .filter((pool) => ownedPools.has(pool))
        .map((pool) => pool.end()),
    );
  }
}
