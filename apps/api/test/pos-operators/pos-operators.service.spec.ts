/**
 * PosOperatorsService — unit spec (no Postgres, no Clerk network).
 *
 * Mocks every dependency: the pg.Pool (so each pipeline step's SQL can
 * be programmed), the ClerkVerifier seam, the DeviceRepository, and the
 * pino Logger. Goal is to cover the refusal taxonomy + happy paths
 * without standing up a container.
 *
 * The companion controller integration spec exercises the same paths
 * end-to-end through HTTP + real Postgres.
 */
import "reflect-metadata";

import type { Pool } from "pg";

import { PosOperatorsService } from "../../src/pos-operators/pos-operators.service";
import { DeviceRepository } from "../../src/pos-operators/device.repository";
import type { ClerkVerifier } from "../../src/pos-operators/clerk-verifier";

// -----------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------

interface MockPool {
  query: jest.Mock;
  connect: jest.Mock;
}

function makePool(): MockPool {
  const query = jest.fn();
  const transactionControl = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SELECT set_config|SELECT pg_advisory_xact_lock)/i;
  const client = {
    query: jest.fn(async (sql: string) => {
      if (transactionControl.test(sql.trimStart())) return { rows: [] };
      return query(sql);
    }),
    release: jest.fn(),
  };
  return { query, connect: jest.fn(async () => client) };
}

function makeVerifier(sub: string | Error = "user_test_sub"): ClerkVerifier {
  return {
    verify: jest.fn(async () => {
      if (sub instanceof Error) throw sub;
      return { sub };
    }),
  };
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
  child: jest.fn(() => SILENT_LOGGER),
} as unknown as Parameters<typeof PosOperatorsService.prototype.signIn> extends never
  ? never
  : ConstructorParameters<typeof PosOperatorsService>[3];

// `programPoolQueries` lets each test return canned rows for the SQL the
// service issues, in order. This is more readable than a giant single
// query implementation.
function programPoolQueries(pool: MockPool, results: Array<unknown[]>): void {
  let i = 0;
  pool.query.mockImplementation(async () => ({
    rows: results[i++] ?? [],
  }));
}

const VALID_BODY = {
  kind: "manager_admin" as const,
  device_token_attestation: "device-attestation-test",
};

const TENANT_ID = "11111111-1111-7111-8111-111111111111";
const STORE_ID = "22222222-2222-7222-8222-222222222222";
const DEVICE_ID = "33333333-3333-7333-8333-333333333333";
const USER_ID = "44444444-4444-7444-8444-444444444444";
const MEMBERSHIP_ID = "55555555-5555-7555-8555-555555555555";
const ROLE_ID = "66666666-6666-7666-8666-666666666666";

const ACTIVE_DEVICE_ROW = {
  id: DEVICE_ID,
  tenantId: TENANT_ID,
  storeId: STORE_ID,
  label: "till-1",
  tokenHash: Buffer.alloc(32),
  revokedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe("PosOperatorsService.signIn", () => {
  it("returns 'refused' (clerk_jwt_invalid) when the verifier throws", async () => {
    const pool = makePool();
    const verifier = makeVerifier(new Error("bad signature"));
    const devices = makeDeviceRepo();
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      verifier,
      devices,
      SILENT_LOGGER,
    );

    const r = await svc.signIn("not-a-jwt", VALID_BODY, "rid-1");

    expect(r).toEqual({ kind: "refused" });
    expect(pool.query).not.toHaveBeenCalled();
    expect(devices.findActiveByAttestation).not.toHaveBeenCalled();
  });

  it("returns 'refused' (user_unmapped) when no users row matches the Clerk subject", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      // 1. user lookup → empty
      [],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.signIn("jwt", VALID_BODY, "rid-2");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' (user_disabled) when the local user is soft-deleted", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [
        {
          id: USER_ID,
          email: "u@example.com",
          display_name: null,
          clerk_user_id: "user_test_sub",
          deleted_at: new Date(),
        },
      ],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.signIn("jwt", VALID_BODY, "rid-3");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' (device_invalid) when the attestation maps to no active device", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [
        {
          id: USER_ID,
          email: "u@example.com",
          display_name: null,
          clerk_user_id: "user_test_sub",
          deleted_at: null,
        },
      ],
    ]);
    const devices = makeDeviceRepo(null);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      devices,
      SILENT_LOGGER,
    );

    const r = await svc.signIn("jwt", VALID_BODY, "rid-4");
    expect(r).toEqual({ kind: "refused" });
    expect(devices.findActiveByAttestation).toHaveBeenCalledWith(
      VALID_BODY.device_token_attestation,
    );
  });

  it("returns 'refused' (membership_missing) when the operator has no membership in the device's tenant", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      // 1. user lookup
      [
        {
          id: USER_ID,
          email: "u@example.com",
          display_name: null,
          clerk_user_id: "user_test_sub",
          deleted_at: null,
        },
      ],
      // 2. membership lookup → empty
      [],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE_ROW),
      SILENT_LOGGER,
    );

    const r = await svc.signIn("jwt", VALID_BODY, "rid-5");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' (role_ineligible) for store_staff", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [
        {
          id: USER_ID,
          email: "u@example.com",
          display_name: null,
          clerk_user_id: "user_test_sub",
          deleted_at: null,
        },
      ],
      [
        {
          id: MEMBERSHIP_ID,
          tenant_id: TENANT_ID,
          user_id: USER_ID,
          role_id: ROLE_ID,
          store_access_kind: "all",
          revoked_at: null,
          deleted_at: null,
          role_code: "store_staff",
        },
      ],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE_ROW),
      SILENT_LOGGER,
    );

    const r = await svc.signIn("jwt", VALID_BODY, "rid-6");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' (store_not_in_access_set) when membership is 'specific' and store is not allowed", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [
        {
          id: USER_ID,
          email: "u@example.com",
          display_name: null,
          clerk_user_id: "user_test_sub",
          deleted_at: null,
        },
      ],
      [
        {
          id: MEMBERSHIP_ID,
          tenant_id: TENANT_ID,
          user_id: USER_ID,
          role_id: ROLE_ID,
          store_access_kind: "specific",
          revoked_at: null,
          deleted_at: null,
          role_code: "store_manager",
        },
      ],
      // 3. store_access lookup → empty
      [],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE_ROW),
      SILENT_LOGGER,
    );

    const r = await svc.signIn("jwt", VALID_BODY, "rid-7");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'takeover_required' when an active operator session already exists for the (device, store)", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [
        {
          id: USER_ID,
          email: "u@example.com",
          display_name: "Manager One",
          clerk_user_id: "user_test_sub",
          deleted_at: null,
        },
      ],
      [
        {
          id: MEMBERSHIP_ID,
          tenant_id: TENANT_ID,
          user_id: USER_ID,
          role_id: ROLE_ID,
          store_access_kind: "all",
          revoked_at: null,
          deleted_at: null,
          role_code: "store_manager",
        },
      ],
      // 3. active session lookup → one row exists
      [{ one: 1 }],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE_ROW),
      SILENT_LOGGER,
    );

    const r = await svc.signIn("jwt", VALID_BODY, "rid-8");
    expect(r).toEqual({ kind: "takeover_required" });
  });

  it("returns 'signed_in' for a tenant_admin with store_access_kind=all (operator.id == clerk_user_id, role mapped to admin)", async () => {
    const issuedAt = new Date("2026-05-06T12:00:00Z");
    const sessionId = "77777777-7777-7777-8777-777777777777";
    const pool = makePool();
    programPoolQueries(pool, [
      [
        {
          id: USER_ID,
          email: "admin@tenant.example",
          display_name: "Tenant Admin",
          clerk_user_id: "user_clerk_admin",
          deleted_at: null,
        },
      ],
      [
        {
          id: MEMBERSHIP_ID,
          tenant_id: TENANT_ID,
          user_id: USER_ID,
          role_id: ROLE_ID,
          store_access_kind: "all",
          revoked_at: null,
          deleted_at: null,
          role_code: "tenant_admin",
        },
      ],
      // 3. active session lookup → none
      [],
      // 4. INSERT auth_tokens RETURNING id, issued_at
      [{ id: sessionId, issued_at: issuedAt }],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier("user_clerk_admin"),
      makeDeviceRepo(ACTIVE_DEVICE_ROW),
      SILENT_LOGGER,
    );

    const r = await svc.signIn("jwt", VALID_BODY, "rid-9");

    expect(r).toEqual({
      kind: "signed_in",
      operator: {
        id: "user_clerk_admin", // Clerk subject (v1 bridge), not USER_ID
        // 033 (FR-033-1, SC-033-1): the provider-neutral key = users.id,
        // distinct from the Clerk subject `id`.
        user_id: USER_ID,
        display_name: "Tenant Admin",
        role: "admin",
        tenant_id: TENANT_ID,
        branch_id: STORE_ID, // store_id surfaced as branch_id
      },
      operator_session: {
        id: sessionId,
        issued_at: issuedAt.toISOString(),
        // 031 D1: a fresh sign-in returns the client-presentable envelope (the
        // opaque raw token generated in issueOperatorSessionRow, not a row field).
        envelope: expect.any(String),
      },
    });
  });

  it("maps store_manager → POS role 'manager'", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [
        {
          id: USER_ID,
          email: "m@example.com",
          display_name: "Mgr",
          clerk_user_id: "user_clerk_mgr",
          deleted_at: null,
        },
      ],
      [
        {
          id: MEMBERSHIP_ID,
          tenant_id: TENANT_ID,
          user_id: USER_ID,
          role_id: ROLE_ID,
          store_access_kind: "all",
          revoked_at: null,
          deleted_at: null,
          role_code: "store_manager",
        },
      ],
      [],
      [{ id: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa", issued_at: new Date() }],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier("user_clerk_mgr"),
      makeDeviceRepo(ACTIVE_DEVICE_ROW),
      SILENT_LOGGER,
    );

    const r = await svc.signIn("jwt", VALID_BODY, "rid-10");
    expect(r.kind).toBe("signed_in");
    if (r.kind === "signed_in") {
      expect(r.operator.role).toBe("manager");
    }
  });

  it("does NOT log the Clerk JWT or the device attestation on refusal", async () => {
    const warnCalls: unknown[] = [];
    const logger = {
      warn: jest.fn((...args) => {
        warnCalls.push(args);
      }),
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      fatal: jest.fn(),
      child: jest.fn(() => logger),
    } as unknown as ConstructorParameters<typeof PosOperatorsService>[3];
    const pool = makePool();
    const verifier = makeVerifier(new Error("bad sig"));
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      verifier,
      makeDeviceRepo(),
      logger,
    );

    const SECRET_JWT = "eyJraWQiOiJzZWNyZXQtand0LXZhbHVlIn0.x.y";
    const SECRET_ATTESTATION = "secret-device-attestation-1234";

    await svc.signIn(SECRET_JWT, {
      kind: "manager_admin",
      device_token_attestation: SECRET_ATTESTATION,
    }, "rid-redact");

    const serialized = JSON.stringify(warnCalls);
    expect(serialized).not.toContain(SECRET_JWT);
    expect(serialized).not.toContain(SECRET_ATTESTATION);
  });
});
