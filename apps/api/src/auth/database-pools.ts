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
  /** The login role. Differs from role_name after `options=-c role=…`. */
  session_role: string;
  is_superuser: boolean;
  bypass_rls: boolean;
}

async function readRole(pool: Pool): Promise<RoleRow> {
  const result = await pool.query<RoleRow>(
    `SELECT current_user AS role_name,
            session_user AS session_role,
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
    // RT-539 (0047): the receipt reprint record.
    "sale_reprints",
    // RT-418 (0051): payer responsibilities on the sale fact.
    "sale_responsibilities",
    // RT-577 (0054): credit-sale reversals, their refund tenders and the
    // shared approval-use ledger.
    "sale_credit_reversals",
    "sale_credit_reversal_tenders",
    "sale_approval_uses",
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
    // RT-387 (0050): the shift variance policy revisions and the persisted
    // approver verdict of a close.
    "cash_variance_policy_revisions",
    "shift_close_approver_checks",
    // RT-213: with BYPASSRLS any grant on tenants would expose every tenant
    // row. Device auth reads tenant status on the domain role instead.
    "tenants",
    "stock_movements",
    "stock_counts",
    // RT-425 (0042): the mutable per-effect inventory integration state.
    "inventory_effect_integration",
    // RT-432 (0044): stock locations (the inventory position grain).
    "stock_locations",
    // RT-448 (0045): tracking identities and their ERPNext edge map.
    "tracking_identities",
    "erpnext_tracking_map",
    // RT-435 (0056): status-move / relocation event records and the tenant
    // inventory settings.
    "inventory_position_events",
    "tenant_inventory_settings",
    // RT-427 (0063): the Inventory Anchors taken at sale-effects activation.
    "inventory_anchors",
    "inventory_anchor_lines",
    // RT-742 (0070): a manager's not-counted force close of a shift.
    "shift_forced_closes",
    // RT-414 (0062): platform support sessions (platform-admin RLS only).
    "platform_support_sessions",
    "audit_events",
    "idempotency_keys",
    "outbox_events",
  ].map((table) => [table, ALL_TABLE_PRIVILEGES] as const),
  ["memberships", ALL_PRIVILEGES_EXCEPT_SELECT],
  ["store_access", ALL_PRIVILEGES_EXCEPT_SELECT],
  // RT-367: the lookup role reads a pairing code by hash at the anonymous
  // bootstrap (SELECT); every write (issue, cancel, burn) is the domain role's.
  ["pairing_codes", ALL_PRIVILEGES_EXCEPT_SELECT],
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
  // RT-343: sign-in reads the user's memberships, joined to roles and
  // tenants, on this role (as /context/me and TenantContextGuard do).
  // Without these grants every Console sign-in would return 500.
  ["memberships", "SELECT"],
  ["roles", "SELECT"],
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
  // RT-330 (0037): the worker freezes a posting intent's resolution and the
  // feed and repair read it. Append-only (no UPDATE / DELETE policy).
  ["erpnext_posting_resolution", "SELECT"],
  ["erpnext_posting_resolution", "INSERT"],
  // RT-425 (0042): every manual movement, transfer and count writes its
  // effect's integration record, and the movement list reads it. UPDATE:
  // the state moves (RT-426). No DELETE policy; never DELETE or TRUNCATE.
  ["inventory_effect_integration", "SELECT"],
  ["inventory_effect_integration", "INSERT"],
  ["inventory_effect_integration", "UPDATE"],
  // RT-432 (0044): every inventory write resolves its effect's stock location
  // and the movement list / on-hand / location list read it. INSERT: creating a
  // store creates its primary location in the same transaction (the
  // stores_create_primary_location trigger runs as this role). No UPDATE /
  // DELETE policy; never UPDATE, DELETE or TRUNCATE.
  ["stock_locations", "SELECT"],
  ["stock_locations", "INSERT"],
  // RT-448 (0045): the tracking-identity list reads identities. Read-only in
  // this release: nothing writes identities or the edge map yet (RT-453), so
  // neither INSERT nor any erpnext_tracking_map privilege is required. No
  // UPDATE / DELETE policy; never UPDATE, DELETE or TRUNCATE.
  ["tracking_identities", "SELECT"],
  // RT-435 (0056): a status move or relocation writes its event record, and a
  // replay reads it back. Append-only (no UPDATE / DELETE policy); never UPDATE,
  // DELETE or TRUNCATE. The return landing policy is read and upserted. No
  // DELETE policy; never DELETE or TRUNCATE.
  ["inventory_position_events", "SELECT"],
  ["inventory_position_events", "INSERT"],
  ["tenant_inventory_settings", "SELECT"],
  ["tenant_inventory_settings", "INSERT"],
  ["tenant_inventory_settings", "UPDATE"],
  // RT-427 (0063): sale-effects activation writes the Inventory Anchor of
  // every store and the comparison reads it (API and worker share this role).
  // Append-only (no UPDATE / DELETE policy); never UPDATE, DELETE or TRUNCATE.
  // Apply with docs/operations/sql/inventory-anchors-domain-grants.sql.
  ["inventory_anchors", "SELECT"],
  ["inventory_anchors", "INSERT"],
  ["inventory_anchor_lines", "SELECT"],
  ["inventory_anchor_lines", "INSERT"],
  // RT-742 (0070): forceCloseShift records a manager's not-counted force
  // close, and closeShift / the cash-up open re-delivery read whether a shift
  // was force-closed. Append-only (no UPDATE / DELETE policy); never UPDATE,
  // DELETE or TRUNCATE. Apply with
  // docs/operations/sql/shift-forced-closes-domain-grants.sql.
  ["shift_forced_closes", "SELECT"],
  ["shift_forced_closes", "INSERT"],
  // RT-539 (0047): every reprint authorized or recorded writes one row, and
  // the next server copy number reads them. Append-only (no UPDATE / DELETE
  // policy); never UPDATE, DELETE or TRUNCATE.
  ["sale_reprints", "SELECT"],
  ["sale_reprints", "INSERT"],
  // RT-418 (0051): a credit capture writes the sale's responsibilities, and
  // the sale read and the posting feed (API and worker share this role) read
  // them. Append-only (no UPDATE / DELETE policy); never UPDATE, DELETE or
  // TRUNCATE.
  ["sale_responsibilities", "SELECT"],
  ["sale_responsibilities", "INSERT"],
  // RT-418, RT-572: the Console payer-account routes read, create and update payers, and a
  // credit capture locks its payer row FOR SHARE (which needs UPDATE) so the
  // payer cannot be suspended between the check and the sale. No DELETE.
  ["payer_account", "SELECT"],
  ["payer_account", "INSERT"],
  ["payer_account", "UPDATE"],
  // RT-577 (0054): a credit reversal writes its row and refund tenders, and its
  // projection and replay read them back; a cash-paying credit return writes
  // its approval id to the shared single-use ledger and reads it to refuse a
  // reuse. All append-only (no UPDATE / DELETE policy); never UPDATE, DELETE
  // or TRUNCATE. (A void's ledger row is written by the SECURITY DEFINER
  // sale_voids trigger and needs no grant.)
  ["sale_credit_reversals", "SELECT"],
  ["sale_credit_reversals", "INSERT"],
  ["sale_credit_reversal_tenders", "SELECT"],
  ["sale_credit_reversal_tenders", "INSERT"],
  ["sale_approval_uses", "SELECT"],
  ["sale_approval_uses", "INSERT"],
  // RT-387 (0050): the Console publishes policy revisions and every resolution
  // (device read, Console reads, the open's accept-and-flag check) reads them;
  // a close's approver verdict is written once after the commit and read back
  // by the close replay and the admin shift-close reads. Both tables are
  // append-only (no UPDATE / DELETE policy, a trigger refuses both); never
  // UPDATE, DELETE or TRUNCATE.
  ["cash_variance_policy_revisions", "SELECT"],
  ["cash_variance_policy_revisions", "INSERT"],
  ["shift_close_approver_checks", "SELECT"],
  ["shift_close_approver_checks", "INSERT"],
  // RT-365: the Console device revoke locks the device row FOR UPDATE (which
  // needs UPDATE) and sets the revoke fields. No earlier domain path wrote
  // `devices` (pairing only INSERTs), so a deploy that skips the grant must
  // fail here at boot, not answer 500 on every revoke. Apply:
  //   GRANT UPDATE ON devices TO <DATABASE_URL role>;
  ["devices", "UPDATE"],
  // RT-367: the Console pairing codes. INSERT: the issue (until RT-367 only
  // the owner-run CLI inserted codes, as the table owner). SELECT: the list,
  // the cancel and the one-replacement check. UPDATE: the cancel, and the
  // redemption's attempt count and burn. A deploy that skips the grant must
  // fail here at boot, not answer 500 on every issue. Apply with
  // docs/operations/sql/device-lifecycle-domain-grants.sql. No DELETE (spent
  // codes are kept for audit).
  ["pairing_codes", "SELECT"],
  ["pairing_codes", "INSERT"],
  ["pairing_codes", "UPDATE"],
  // RT-414 (0062): every platform-admin request into a non-member tenant reads
  // its support session; open inserts one, renew and end update it (FOR
  // UPDATE). Never deleted (0062's trigger); never DELETE or TRUNCATE. Apply
  // with docs/operations/sql/platform-support-sessions-domain-grants.sql.
  ["platform_support_sessions", "SELECT"],
  ["platform_support_sessions", "INSERT"],
  ["platform_support_sessions", "UPDATE"],
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

/**
 * RT-357: a URL can log in as a privileged role and switch with
 * `options=-c role=…`. current_user then passes every posture and grant check
 * below, while RESET ROLE restores the login's own privileges (a superuser,
 * BYPASSRLS, the migration owner). The login itself must be the checked role.
 */
function assertLogsInAsItself(role: RoleRow, variable: string): void {
  if (role.session_role !== role.role_name) {
    throw new Error(
      `AuthModule: ${variable} role must log in as itself, not switch to it from another login`,
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

  assertLogsInAsItself(domainRole, "DATABASE_URL");
  assertLogsInAsItself(lookupRole, "AUTH_LOOKUP_DATABASE_URL");
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
