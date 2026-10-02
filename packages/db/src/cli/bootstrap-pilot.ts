#!/usr/bin/env node
/**
 * Backend-Core P-0 preprod PILOT BOOTSTRAP seed.
 *
 * One-shot, idempotent seed that mints the minimal identity state the first
 * POS live-leg smoke needs in an EMPTY preprod database (tenants/users/stores
 * all zero after deploy — migrations create schema only, no data).
 *
 * WHAT THIS SEEDS (static DB rows; mirrors `TenantsService.createTenant` +
 * the operator-sign-in preconditions in `PosOperatorsService.signIn`):
 *   1. tenants                — the pilot tenant (the binding `tenant_id`).
 *   2. roles (× 4)            — default tenant-scoped roles
 *                               (owner / tenant_admin / store_manager / store_staff),
 *                               byte-identical to `seedDefaultRoles`.
 *   3. stores                 — the pilot store (the binding `store_id`).
 *   4. users                  — the OPERATOR's local user, linked to its Clerk
 *                               subject via `clerk_user_id` (operator sign-in
 *                               step 2: "resolve the local user by
 *                               users.clerk_user_id = sub").
 *   5. memberships            — the operator's membership in the pilot tenant,
 *                               role = `store_manager` (an ELIGIBLE internal role
 *                               that maps to POS role `manager`; `store_staff`
 *                               maps to null and is REJECTED at sign-in), with
 *                               `store_access_kind = 'all'` so no per-store
 *                               `store_access` row is required.
 *
 * WHAT THIS DOES **NOT** DO (intentionally — out of scope for a static seed):
 *   - Mint the Clerk identity. The operator's Clerk user must already exist in
 *     the preprod Clerk instance; its subject id is the one REQUIRED input here
 *     (CLERK_OPERATOR_SUBJECT). Owner/Clerk-dashboard work.
 *   - Pair a terminal / create a `device` row. Pairing is the unauthenticated
 *     runtime bootstrap (POS-010 read-down's device token) — not a seed row.
 *   - Issue the `pos_operator` `auth_tokens` session token. That is the OUTPUT
 *     of the operator sign-in exchange at runtime (`PosOperatorsService.signIn`
 *     step 7) — never a static row.
 *   - Seed the catalog. Catalog rows are the SEPARATE `seed-catalog.ts` slice
 *     (golden-catalog-seed decisions) and run under the same pilot tenant/store.
 *   - Create a platform admin. `createTenant`'s platform-admin gate is the HTTP
 *     API path, which this direct seed bypasses; neither POS smoke needs one.
 *     (If future Console manageability needs a platform admin, that is a
 *     separate, explicit decision — set BOOTSTRAP_PLATFORM_ADMIN=1 is NOT
 *     implemented here on purpose.)
 *
 * The minted UUIDs are the binding pilot IDs and MUST be reused verbatim by the
 * catalog seed and by the POS terminal's pairing target (else read-down returns
 * `{items:[]}` for that device principal).
 *
 * RLS: inserts run inside ONE transaction with the tenant-context GUCs set
 * (`app.current_tenant` = pilot tenant, `app.is_platform_admin` = 'true' for the
 * tenant row itself), mirroring `runWithTenantContext` — "bypasses the HTTP
 * guard" is NOT "bypasses RLS".
 *
 * Reads `DATABASE_URL` (same as migrate.ts). Idempotent: re-running is a no-op
 * once the rows exist (existence-guarded). Prints the minted IDs as JSON.
 *
 * Usage:
 *   CLERK_OPERATOR_SUBJECT=user_xxx \
 *   PILOT_TENANT_SLUG=pilot PILOT_TENANT_NAME="Pilot Tenant" \
 *   PILOT_STORE_CODE=main PILOT_STORE_NAME="Main Store" \
 *   PILOT_OPERATOR_EMAIL=operator@pilot.test \
 *   node dist/cli/bootstrap-pilot.js
 *
 * Exit codes: 0 success · 1 SQL/runtime error · 2 DATABASE_URL missing ·
 *             4 CLERK_OPERATOR_SUBJECT missing.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const NIL_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Default tenant roles — byte-identical to TenantsRepository.DEFAULT_TENANT_ROLES. */
const DEFAULT_TENANT_ROLES = [
  { code: 'owner', name: 'Owner' },
  { code: 'tenant_admin', name: 'Tenant Admin' },
  { code: 'store_manager', name: 'Store Manager' },
  { code: 'store_staff', name: 'Store Staff' },
] as const;

/**
 * The operator's membership role. MUST be an ELIGIBLE internal role
 * (`mapInternalRoleToPos` accepts owner/tenant_admin -> "admin",
 * store_manager -> "manager"; store_staff -> null => sign-in refuses
 * `role_not_eligible`). `store_manager` is the least-privileged eligible role.
 */
const OPERATOR_ROLE_CODE = 'store_manager';

interface PilotConfig {
  clerkOperatorSubject: string;
  tenantSlug: string;
  tenantName: string;
  storeCode: string;
  storeName: string;
  operatorEmail: string;
}

interface MintedIds {
  tenant_id: string;
  store_id: string;
  operator_user_id: string;
  operator_membership_id: string;
  operator_role_id: string;
  clerk_operator_subject: string;
}

function readConfig(): PilotConfig {
  const clerkOperatorSubject = process.env['CLERK_OPERATOR_SUBJECT'];
  if (!clerkOperatorSubject || clerkOperatorSubject.trim() === '') {
    console.error(
      'CLERK_OPERATOR_SUBJECT is required — the preprod Clerk subject id of the ' +
        'operator user (mint the Clerk identity first; this seed only links it).',
    );
    process.exit(4);
  }
  return {
    clerkOperatorSubject: clerkOperatorSubject.trim(),
    tenantSlug: process.env['PILOT_TENANT_SLUG'] ?? 'pilot',
    tenantName: process.env['PILOT_TENANT_NAME'] ?? 'Pilot Tenant',
    storeCode: process.env['PILOT_STORE_CODE'] ?? 'main',
    storeName: process.env['PILOT_STORE_NAME'] ?? 'Main Store',
    operatorEmail: process.env['PILOT_OPERATOR_EMAIL'] ?? 'operator@pilot.test',
  };
}

/** Set the tenant-context GUCs for this transaction (mirrors runWithTenantContext). */
async function setContext(
  client: Client,
  tenantId: string,
  isPlatformAdmin: boolean,
): Promise<void> {
  await client.query("SELECT set_config('app.current_tenant', $1, true)", [
    tenantId ?? NIL_TENANT_ID,
  ]);
  await client.query("SELECT set_config('app.is_platform_admin', $1, true)", [
    isPlatformAdmin ? 'true' : 'false',
  ]);
}

async function seed(client: Client, cfg: PilotConfig): Promise<MintedIds> {
  // Resolve-or-create the tenant first (idempotent on slug).
  const existingTenant = await client.query<{ id: string }>(
    'SELECT id FROM tenants WHERE slug = $1 AND deleted_at IS NULL',
    [cfg.tenantSlug],
  );
  const tenantId = existingTenant.rows[0]?.id ?? randomUUID();

  // GUCs: scope to the pilot tenant; is_platform_admin=true so the tenants
  // INSERT itself passes RLS (createTenant uses the same elevation).
  await setContext(client, tenantId, true);

  if (!existingTenant.rows[0]) {
    await client.query('INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)', [
      tenantId,
      cfg.tenantSlug,
      cfg.tenantName,
    ]);
  }

  // Default roles (idempotent on (tenant_id, code)).
  for (const r of DEFAULT_TENANT_ROLES) {
    await client.query(
      `INSERT INTO roles (id, tenant_id, code, name, is_built_in)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [randomUUID(), tenantId, r.code, r.name],
    );
  }
  const roleRow = await client.query<{ id: string }>(
    'SELECT id FROM roles WHERE tenant_id = $1 AND code = $2',
    [tenantId, OPERATOR_ROLE_CODE],
  );
  const operatorRoleId = roleRow.rows[0]?.id;
  if (!operatorRoleId) {
    throw new Error(`bootstrap: role '${OPERATOR_ROLE_CODE}' not found after seed`);
  }

  // Store (idempotent on (tenant_id, lower(code))).
  const existingStore = await client.query<{ id: string }>(
    'SELECT id FROM stores WHERE tenant_id = $1 AND lower(code) = lower($2) AND deleted_at IS NULL',
    [tenantId, cfg.storeCode],
  );
  const storeId = existingStore.rows[0]?.id ?? randomUUID();
  if (!existingStore.rows[0]) {
    await client.query('INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)', [
      storeId,
      tenantId,
      cfg.storeCode,
      cfg.storeName,
    ]);
  }

  // Operator user (idempotent on clerk_user_id partial-unique).
  const existingUser = await client.query<{ id: string }>(
    'SELECT id FROM users WHERE clerk_user_id = $1',
    [cfg.clerkOperatorSubject],
  );
  const operatorUserId = existingUser.rows[0]?.id ?? randomUUID();
  if (!existingUser.rows[0]) {
    await client.query(
      `INSERT INTO users (id, email, clerk_user_id, is_platform_admin)
       VALUES ($1, $2, $3, false)`,
      [operatorUserId, cfg.operatorEmail, cfg.clerkOperatorSubject],
    );
  }

  // Membership in the pilot tenant (idempotent on the active-membership uidx).
  const existingMembership = await client.query<{ id: string }>(
    'SELECT id FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [tenantId, operatorUserId],
  );
  const membershipId = existingMembership.rows[0]?.id ?? randomUUID();
  if (!existingMembership.rows[0]) {
    await client.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
       VALUES ($1, $2, $3, $4, 'all')`,
      [membershipId, tenantId, operatorUserId, operatorRoleId],
    );
  }

  return {
    tenant_id: tenantId,
    store_id: storeId,
    operator_user_id: operatorUserId,
    operator_membership_id: membershipId,
    operator_role_id: operatorRoleId,
    clerk_operator_subject: cfg.clerkOperatorSubject,
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const cfg = readConfig();

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      const ids = await seed(client, cfg);
      await client.query('COMMIT');
      console.log('bootstrap-pilot: seeded (idempotent). Minted/confirmed IDs:');
      console.log(JSON.stringify(ids, null, 2));
      console.log(
        '\nNEXT (runtime / separate): (1) pair a terminal to this tenant/store ' +
          '(device token); (2) operator signs in via the POS app to obtain the ' +
          'pos_operator session token; (3) run seed-catalog.ts under tenant_id ' +
          `${ids.tenant_id} / store_id ${ids.store_id}.`,
      );
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`bootstrap-pilot: ${message}`);
  process.exit(1);
});
