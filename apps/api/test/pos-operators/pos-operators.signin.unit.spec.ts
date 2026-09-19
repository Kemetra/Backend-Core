/**
 * PosOperatorsService.signIn — targeted unit spec.
 *
 * Covers the sign-in pipeline branches not exercised by the
 * Docker-based integration spec (pos-operators.service.spec.ts),
 * specifically the `membership_revoked` path (line 349):
 *
 *   if (membership.revoked_at !== null || membership.deleted_at !== null) {
 *     return { kind: "refused", reason: "membership_revoked" };
 *   }
 *
 * The pattern mirrors pos-operators.wave3.service.spec.ts: a mock pool
 * whose `query` returns programmed results in order, skipping transaction-
 * control statements.
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
const STORE_ID  = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const USER_ID   = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
const MEMBERSHIP_ID = "dddddddd-dddd-7ddd-8ddd-dddddddddddd";

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

const SIGN_IN_BODY = {
  device_token_attestation: "attest",
};

describe("PosOperatorsService.signIn — membership_revoked branch", () => {
  it("returns 'refused' when membership has revoked_at set", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [{ ...MANAGER_MEMBERSHIP, revoked_at: new Date("2026-01-01") }],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.signIn("jwt", SIGN_IN_BODY, "rid-1");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when membership has deleted_at set", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [{ ...MANAGER_MEMBERSHIP, deleted_at: new Date("2026-01-01") }],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.signIn("jwt", SIGN_IN_BODY, "rid-2");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when role_code is ineligible (store_staff)", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [{ ...MANAGER_MEMBERSHIP, role_code: "store_staff" }],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.signIn("jwt", SIGN_IN_BODY, "rid-3");
    expect(r).toEqual({ kind: "refused" });
  });
});
