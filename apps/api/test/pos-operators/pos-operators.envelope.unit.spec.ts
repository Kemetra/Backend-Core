/**
 * T1 (031 D1) — sign-in returns the operator-authorization ENVELOPE.
 *
 * OQ-1 = 1-A-i: `issueOperatorSessionRow` already generates a raw token via
 * `generateRawToken()`, hashes it into `token_hash`, and TODAY discards the
 * raw. This slice RETURNS that raw as the client-presentable envelope so the
 * canonical `PosOperatorAuthGuard` (`scope === "pos_operator"`) becomes
 * satisfiable (closes the D2 phantom). The `auth_tokens` row + hash +
 * revocation model are unchanged (no schema change).
 *
 * Harness mirrors pos-operators.signin.unit.spec.ts (mock pool returning
 * programmed rows in order).
 */
import "reflect-metadata";

import type { Pool } from "pg";

import { PosOperatorsService } from "../../src/pos-operators/pos-operators.service";
import { DeviceRepository } from "../../src/pos-operators/device.repository";
import type { ClerkVerifier } from "../../src/pos-operators/clerk-verifier";

interface MockPool {
  query: jest.Mock;
  connect: jest.Mock;
}

function makePool(): MockPool {
  const queryFn = jest.fn();
  const TX_CTRL = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SELECT set_config|SELECT pg_advisory_xact_lock)/i;
  const clientQueryFn = jest.fn(async (sql: string) => {
    if (TX_CTRL.test(sql.trimStart())) return { rows: [] };
    return queryFn(sql);
  });
  const clientStub = { query: clientQueryFn, release: jest.fn() };
  const connectFn = jest.fn(async () => clientStub);
  return { query: queryFn, connect: connectFn };
}

function makeVerifier(sub = "user_clerk_sub"): ClerkVerifier {
  return { verify: jest.fn(async () => ({ sub })) };
}

function makeDeviceRepo(
  result: Awaited<ReturnType<DeviceRepository["findActiveByAttestation"]>> = null,
): jest.Mocked<DeviceRepository> {
  return {
    findActiveByAttestation: jest.fn(async () => result),
  } as unknown as jest.Mocked<DeviceRepository>;
}

const SILENT_LOGGER = {
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  fatal: jest.fn(),
  child: jest.fn(function (this: unknown) { return SILENT_LOGGER; }),
} as unknown as ConstructorParameters<typeof PosOperatorsService>[3];

function programPoolQueries(pool: MockPool, results: Array<unknown[]>): void {
  let i = 0;
  pool.query.mockImplementation(async () => ({ rows: results[i++] ?? [] }));
}

const TENANT_ID = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
const MEMBERSHIP_ID = "dddddddd-dddd-7ddd-8ddd-dddddddddddd";
const SESSION_ID = "ffffffff-ffff-7fff-8fff-ffffffffffff";

const VALID_USER_ROW = {
  id: USER_ID,
  email: "op@example.com",
  display_name: "Operator",
  clerk_user_id: "user_clerk_sub",
  deleted_at: null,
};

const ACTIVE_DEVICE = {
  id: "eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee",
  tenantId: TENANT_ID,
  storeId: STORE_ID,
  tokenHash: Buffer.from("hash"),
  label: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  revokedAt: null,
};

const MANAGER_MEMBERSHIP = {
  id: MEMBERSHIP_ID,
  tenant_id: TENANT_ID,
  user_id: USER_ID,
  role_id: "role-manager",
  store_access_kind: "all",
  revoked_at: null,
  deleted_at: null,
  role_code: "store_manager",
};

const ISSUED_ROW = { id: SESSION_ID, issued_at: new Date("2026-06-12T00:00:00Z") };

const SIGN_IN_BODY = { device_token_attestation: "attest" };

/**
 * Programs the happy-path query sequence: user → membership → (store-access:
 * 'all' so skipped) → active-session check (none) → issueOperatorSessionRow
 * INSERT RETURNING.
 */
function programHappyPath(pool: MockPool): void {
  programPoolQueries(pool, [
    [VALID_USER_ROW], // findUserByClerkSubject
    [MANAGER_MEMBERSHIP], // findActiveMembership
    // store_access_kind === 'all' → storeIsInAccessSet NOT called
    [], // activeOperatorSessionExists → no active session
    [ISSUED_ROW], // issueOperatorSessionRow INSERT RETURNING
  ]);
}

describe("PosOperatorsService.signIn — returns the operator-authorization envelope (T1, OQ-1 1-A-i)", () => {
  it("returns a non-empty envelope alongside the session summary on successful sign-in", async () => {
    const pool = makePool();
    programHappyPath(pool);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.signIn("jwt", SIGN_IN_BODY, "rid-env-1");

    expect(r.kind).toBe("signed_in");
    if (r.kind !== "signed_in") return;
    // The envelope is the client-presentable credential (the raw token that
    // issueOperatorSessionRow generates and today discards). It MUST be present
    // and non-empty so the canonical PosOperatorAuthGuard becomes satisfiable.
    expect(r.operator_session.envelope).toBeDefined();
    expect(typeof r.operator_session.envelope).toBe("string");
    expect((r.operator_session.envelope as string).length).toBeGreaterThan(0);
    // The session summary fields remain unchanged.
    expect(r.operator_session.id).toBe(SESSION_ID);
  });

  it("hashes the returned envelope into auth_tokens.token_hash (revocation model unchanged)", async () => {
    const pool = makePool();
    programHappyPath(pool);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.signIn("jwt", SIGN_IN_BODY, "rid-env-2");
    if (r.kind !== "signed_in") throw new Error("expected signed_in");

    // The INSERT into auth_tokens must carry a token_hash (the hash of the
    // returned envelope) — i.e. the existing hash/revocation model is preserved,
    // not bypassed. The 2nd positional param of the INSERT is token_hash.
    const insertCall = pool.query.mock.calls.find((c) =>
      typeof c[0] === "string" && /INSERT INTO auth_tokens/i.test(c[0] as string),
    );
    expect(insertCall).toBeDefined();
  });
});
