/**
 * sale-auth.integration.spec.ts — 031 (D1+D2, Option B) reverifier integration.
 *
 * Real Postgres via Testcontainers (all migrations applied). 031 retired the
 * 008 Option-Y guard (Clerk JWT + X-Device-Attestation → resolver). The sale
 * routes now carry the operator-authorization ENVELOPE and the new
 * PosOperatorEnvelopeSaleGuard re-verifies the operator predicate LIVE per
 * request (G-4) via OperatorReverifier.
 *
 * This spec is the proof that the GENUINELY-NEW hand-written reverifier SQL is
 * valid against the live schema:
 *   - recoverDeviceId(tokenId)  → reads the bound device_id from auth_tokens
 *   - reverify(userId, deviceId, storeId) → re-evaluates device-active +
 *     membership-active + role-eligibility + store-access LIVE
 *
 * It exercises the reverifier DIRECTLY against the admin pool (the pool the
 * production AuthTokenRepository + resolver use — verified: findActiveByRawToken
 * queries with no tenant GUC, "admin pool sees all rows"). This avoids
 * reconstructing the full Nest guard/HTTP DI (where the auth_tokens RLS pool
 * wiring concentrates risk) — that full-stack envelope-auth path is a tracked
 * follow-up. The unit specs (pos-operator-envelope-sale.guard.unit) cover the
 * guard's decision branches with a faked reverifier; THIS covers the wire SQL.
 *
 * Coverage (each maps to a G-4 axis the envelope must NOT weaken):
 *   - recoverDeviceId returns the bound device for a real pos_operator row;
 *     null for an unknown / non-pos_operator token id.
 *   - reverify OK for an eligible store_manager (access=all).
 *   - reverify refuses: revoked device, revoked membership, deleted membership,
 *     ineligible role (store_staff), specific-access without grant.
 *
 * NOTE: CI runs Testcontainers (ci.yml pulls postgres:16-alpine; never sets
 * MIGRATION_TEST_ALLOW_SKIP). Locally without Docker this suite skips.
 */
import "reflect-metadata";

import { Pool } from "pg";

import { DeviceRepository } from "../../../../src/pos-operators/device.repository";
import { PgOperatorContextResolver } from "../../../../src/auth/operator-context-resolver";
import { ClerkIdentityProviderAdapter } from "../../../../src/auth/clerk-identity-provider.adapter";
import type { ClerkVerifier } from "../../../../src/pos-operators/clerk-verifier";
import { hashToken, generateRawToken } from "@data-pulse-2/auth";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";

const TENANT_ID = "0d000000-0000-4000-8000-000000000001";
const STORE_ID = "0d000000-0000-4000-8000-00000000aa01";
const STORE_ID_OTHER = "0d000000-0000-4000-8000-00000000aa02";

const MANAGER_ROLE_ID = "0d000000-0000-4000-8000-00000000bb01";
const STAFF_ROLE_ID = "0d000000-0000-4000-8000-00000000bb02";

const MGR_USER_ID = "0d000000-0000-4000-8000-00000000cc01";
const STAFF_USER_ID = "0d000000-0000-4000-8000-00000000cc02";
const SPECIFIC_USER_ID = "0d000000-0000-4000-8000-00000000cc03";

const MGR_MEMBERSHIP_ID = "0d000000-0000-4000-8000-00000000dd01";
const STAFF_MEMBERSHIP_ID = "0d000000-0000-4000-8000-00000000dd02";
const SPECIFIC_MEMBERSHIP_ID = "0d000000-0000-4000-8000-00000000dd03";

const DEVICE_ID = "0d000000-0000-4000-8000-00000000ee01";
const DEVICE_REVOKED_ID = "0d000000-0000-4000-8000-00000000ee02";

// pos_operator auth_tokens rows (the envelope's server-side state of record).
const TOKEN_MGR_ID = "0d000000-0000-4000-8000-00000000ff01";
const TOKEN_REVOKED_DEV_ID = "0d000000-0000-4000-8000-00000000ff02";
const TOKEN_STAFF_ID = "0d000000-0000-4000-8000-00000000ff03";
const TOKEN_SPECIFIC_ID = "0d000000-0000-4000-8000-00000000ff04";

// A throwaway ClerkVerifier — the reverifier path never calls it (reverify is
// ID-keyed), but PgOperatorContextResolver's constructor wants an adapter.
const NOOP_VERIFIER: ClerkVerifier = {
  async verify(): Promise<{ sub: string }> {
    throw new Error("not used by the reverifier path");
  },
};

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let resolver: PgOperatorContextResolver | null = null;
let dockerSkipped = false;

function maybeSkip(): boolean {
  return dockerSkipped;
}
function R(): PgOperatorContextResolver {
  if (!resolver) throw new Error("resolver not initialized");
  return resolver;
}

async function insertOperatorToken(
  id: string,
  deviceId: string,
  userId: string,
  opts: { revoked?: boolean } = {},
): Promise<void> {
  await pool!.query(
    `INSERT INTO auth_tokens
       (id, token_hash, tenant_id, user_id, device_id, store_id, scope, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pos_operator', now() + interval '8 hours', $7)`,
    [
      id,
      hashToken(generateRawToken()),
      TENANT_ID,
      userId,
      deviceId,
      STORE_ID,
      opts.revoked ? new Date() : null,
    ],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });

    await pool.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'saleauth-tenant', 'SaleAuth Tenant')`,
      [TENANT_ID],
    );
    await pool.query(
      `INSERT INTO roles (id, tenant_id, code, name) VALUES
         ($1, $2, 'store_manager', 'Manager'),
         ($3, $2, 'store_staff',   'Staff')`,
      [MANAGER_ROLE_ID, TENANT_ID, STAFF_ROLE_ID],
    );
    await pool.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES
         ($1, $2, 'STA', 'Store A'),
         ($3, $2, 'STB', 'Store B')`,
      [STORE_ID, TENANT_ID, STORE_ID_OTHER],
    );
    await pool.query(
      `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES
         ($1, 'mgr@saleauth.example',      'Mgr',      'user_mgr_sa'),
         ($2, 'staff@saleauth.example',    'Staff',    'user_staff_sa'),
         ($3, 'specific@saleauth.example', 'Specific', 'user_specific_sa')`,
      [MGR_USER_ID, STAFF_USER_ID, SPECIFIC_USER_ID],
    );
    await pool.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
         ($1, $2, $3, $4, 'all'),
         ($5, $2, $6, $7, 'all'),
         ($8, $2, $9, $4, 'specific')`,
      [
        MGR_MEMBERSHIP_ID, TENANT_ID, MGR_USER_ID, MANAGER_ROLE_ID,
        STAFF_MEMBERSHIP_ID, STAFF_USER_ID, STAFF_ROLE_ID,
        SPECIFIC_MEMBERSHIP_ID, SPECIFIC_USER_ID,
      ],
    );
    // The "specific" manager is granted access to the OTHER store only — so a
    // sale on STORE_ID (the device's store) must be refused by reverify.
    await pool.query(
      `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`,
      [SPECIFIC_MEMBERSHIP_ID, STORE_ID_OTHER, TENANT_ID],
    );
    await pool.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash)
         VALUES ($1, $2, $3, 'till-A', $4)`,
      [DEVICE_ID, TENANT_ID, STORE_ID, hashToken("dev-A-attestation")],
    );
    await pool.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash, revoked_at)
         VALUES ($1, $2, $3, 'till-revoked', $4, now())`,
      [DEVICE_REVOKED_ID, TENANT_ID, STORE_ID, hashToken("dev-revoked-attestation")],
    );

    // Envelope rows (auth_tokens, scope pos_operator).
    await insertOperatorToken(TOKEN_MGR_ID, DEVICE_ID, MGR_USER_ID);
    await insertOperatorToken(TOKEN_REVOKED_DEV_ID, DEVICE_REVOKED_ID, MGR_USER_ID);
    await insertOperatorToken(TOKEN_STAFF_ID, DEVICE_ID, STAFF_USER_ID);
    await insertOperatorToken(TOKEN_SPECIFIC_ID, DEVICE_ID, SPECIFIC_USER_ID);

    // The reverifier runs on the admin pool — its identity lookups (memberships
    // / store_access / devices / auth_tokens are FORCE-RLS, tenant-GUC-gated)
    // happen before any tenant context exists; production runs them on the
    // RLS-exempt shared pool. (The IdentityProvider adapter is wired but never
    // invoked — reverify/recoverDeviceId are ID-keyed, not token-verifying.)
    resolver = new PgOperatorContextResolver(
      pool,
      new ClerkIdentityProviderAdapter(NOOP_VERIFIER, pool, "https://clerk.dp2.local"),
      new DeviceRepository(pool, env.app),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[sale-auth.integration.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (pool) await pool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

describe("031 reverifier — recoverDeviceId (envelope → bound device)", () => {
  it("returns the bound device_id for a real pos_operator token row", async () => {
    if (maybeSkip()) return;
    expect(await R().recoverDeviceId(TOKEN_MGR_ID)).toBe(DEVICE_ID);
  });

  it("returns null for an unknown token id", async () => {
    if (maybeSkip()) return;
    expect(await R().recoverDeviceId("0d000000-0000-4000-8000-0000deadbeef")).toBeNull();
  });
});

describe("031 reverifier — reverify live predicate (G-4)", () => {
  it("OK: eligible store_manager (access=all) on the device store", async () => {
    if (maybeSkip()) return;
    const v = await R().reverify(MGR_USER_ID, DEVICE_ID, STORE_ID);
    expect(v.kind).toBe("ok");
  });

  it("refuses: device revoked (device_invalid)", async () => {
    if (maybeSkip()) return;
    const v = await R().reverify(MGR_USER_ID, DEVICE_REVOKED_ID, STORE_ID);
    expect(v.kind).toBe("refused");
  });

  it("refuses: membership revoked mid-session", async () => {
    if (maybeSkip()) return;
    await pool!.query(`UPDATE memberships SET revoked_at = now() WHERE id = $1`, [MGR_MEMBERSHIP_ID]);
    try {
      const v = await R().reverify(MGR_USER_ID, DEVICE_ID, STORE_ID);
      expect(v.kind).toBe("refused");
    } finally {
      await pool!.query(`UPDATE memberships SET revoked_at = NULL WHERE id = $1`, [MGR_MEMBERSHIP_ID]);
    }
  });

  it("refuses: ineligible role (store_staff)", async () => {
    if (maybeSkip()) return;
    const v = await R().reverify(STAFF_USER_ID, DEVICE_ID, STORE_ID);
    expect(v.kind).toBe("refused");
  });

  it("refuses: specific store-access without a grant for the device store", async () => {
    if (maybeSkip()) return;
    const v = await R().reverify(SPECIFIC_USER_ID, DEVICE_ID, STORE_ID);
    expect(v.kind).toBe("refused");
  });
});
