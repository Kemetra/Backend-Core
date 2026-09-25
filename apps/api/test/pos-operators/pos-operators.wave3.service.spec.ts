/**
 * PosOperatorsService Wave 3 unit spec — roster, takeoverConfirm, activeSession.
 *
 * No Postgres, no Clerk network. All dependencies mocked via the same pattern
 * as the sign-in / sign-out unit specs. Each refusal branch produces a typed
 * `{ kind: "refused" }` result at the service boundary (ADR D10).
 */
import "reflect-metadata";

import type { Pool } from "pg";

import { hashToken } from "@data-pulse-2/auth";

import { PosOperatorsService } from "../../src/pos-operators/pos-operators.service";
import { DeviceRepository } from "../../src/pos-operators/device.repository";
import type { ClerkVerifier } from "../../src/pos-operators/clerk-verifier";

interface MockPool {
  query: jest.Mock;
  connect: jest.Mock;
}

/**
 * Build a mock pool whose `query` and the PoolClient returned by `connect()`
 * both draw from the same ordered result sequence, skipping transaction-control
 * statements emitted by `runWithTenantContext` (BEGIN / COMMIT / ROLLBACK /
 * set_config). This lets tests specify only the business-query results without
 * caring whether a query went through the pool directly or through a client.
 */
function makePool(): MockPool {
  const queryFn = jest.fn();
  const TX_CTRL = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SELECT set_config|SELECT pg_advisory_xact_lock)/i;
  const clientQueryFn = jest.fn(async (sql: string) => {
    if (TX_CTRL.test(sql.trimStart())) return { rows: [] };
    return queryFn(sql);
  });
  const clientStub = {
    query: clientQueryFn,
    release: jest.fn(),
  };
  const connectFn = jest.fn(async () => clientStub);
  return { query: queryFn, connect: connectFn };
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
} as unknown as ConstructorParameters<typeof PosOperatorsService>[3];

function programPoolQueries(pool: MockPool, results: Array<unknown[]>): void {
  let i = 0;
  pool.query.mockImplementation(async (sql: string) => {
    // findActiveMembershipByStore performs the narrow bootstrap lookup before
    // entering tenant RLS. Keep it explicit without making every behavior test
    // repeat the same plumbing fixture.
    if (/SELECT\s+tenant_id\s+FROM\s+stores/i.test(sql)) {
      return { rows: [{ tenant_id: TENANT_ID }] };
    }
    return { rows: results[i++] ?? [] };
  });
}

const TENANT_ID = "11111111-1111-7111-8111-111111111111";
const STORE_ID = "22222222-2222-7222-8222-222222222222";
const USER_ID = "33333333-3333-7333-8333-333333333333";
const OTHER_USER_ID = "44444444-4444-7444-8444-444444444444";
const SESSION_ID = "55555555-5555-7555-8555-555555555555";
const MEMBERSHIP_ID = "66666666-6666-7666-8666-666666666666";
const EVENT_ID = "77777777-7777-4777-8777-777777777777";
const OPERATOR_CLERK_SUB = "user_test_sub";

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

const ACTIVE_DEVICE = {
  id: "88888888-8888-7888-8888-888888888888",
  tenantId: TENANT_ID,
  storeId: STORE_ID,
  tokenHash: Buffer.from("hash"),
  label: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  revokedAt: null,
};

const VALID_USER_ROW = {
  id: USER_ID,
  email: "u@example.com",
  display_name: "Test User",
  clerk_user_id: OPERATOR_CLERK_SUB,
  deleted_at: null,
};

const MANAGER_MEMBERSHIP_ROW = {
  id: MEMBERSHIP_ID,
  tenant_id: TENANT_ID,
  user_id: USER_ID,
  role_id: "role-id",
  store_access_kind: "all",
  revoked_at: null,
  deleted_at: null,
  role_code: "store_manager",
};

// ---------------------------------------------------------------------------
// GET /roster
// ---------------------------------------------------------------------------

describe("PosOperatorsService.roster", () => {
  it("returns 'refused' when verifier throws (invalid Clerk JWT)", async () => {
    const pool = makePool();
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(new Error("bad sig")),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.roster("bad-jwt", {}, "rid-1");
    expect(r).toEqual({ kind: "refused" });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("returns 'refused' when user is not found", async () => {
    const pool = makePool();
    programPoolQueries(pool, [[]]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.roster("jwt", { branch_id: STORE_ID }, "rid-2");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when branch_id is omitted", async () => {
    const pool = makePool();
    programPoolQueries(pool, [[VALID_USER_ROW]]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.roster("jwt", {}, "rid-3");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when membership lookup returns nothing", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [], // no membership
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.roster("jwt", { branch_id: STORE_ID }, "rid-4");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns cashiers array on happy path", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [{ ...MANAGER_MEMBERSHIP_ROW, store_access_kind: "all" }],
      [
        {
          id: "0195b400-0000-7000-8000-0000000a0001",
          clerk_user_id: "user_staff_1",
          display_name: "Alice",
        },
        {
          id: "0195b400-0000-7000-8000-0000000a0002",
          clerk_user_id: "user_staff_2",
          display_name: "Bob",
        },
      ],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.roster("jwt", { branch_id: STORE_ID }, "rid-5");
    // 034: each entry carries the provider-neutral user_id (= users.id),
    // distinct from id (= clerk_user_id, the v1 bridge).
    expect(r).toEqual({
      cashiers: [
        {
          id: "user_staff_1",
          user_id: "0195b400-0000-7000-8000-0000000a0001",
          display_name: "Alice",
          role: "cashier",
        },
        {
          id: "user_staff_2",
          user_id: "0195b400-0000-7000-8000-0000000a0002",
          display_name: "Bob",
          role: "cashier",
        },
      ],
    });
  });

  it("returns 'refused' when store_access_kind is 'specific' and store not in access set", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [{ ...MANAGER_MEMBERSHIP_ROW, store_access_kind: "specific" }],
      [], // storeIsInAccessSet returns no rows — store not granted
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.roster("jwt", { branch_id: STORE_ID }, "rid-6");
    expect(r).toEqual({ kind: "refused" });
    // Exactly 4 queries: user lookup, store→tenant bootstrap lookup,
    // membership lookup, and access-set check. Cashier fetch must not run.
    expect(pool.query).toHaveBeenCalledTimes(4);
  });

  it("returns 'refused' when user is found but soft-deleted (deleted_at set)", async () => {
    // Covers line 412: `if (userRow.deleted_at !== null) return { kind: "refused" }`
    const pool = makePool();
    programPoolQueries(pool, [
      [{ ...VALID_USER_ROW, deleted_at: new Date("2026-01-01") }],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.roster("jwt", { branch_id: STORE_ID }, "rid-7");
    expect(r).toEqual({ kind: "refused" });
  });
});

// ---------------------------------------------------------------------------
// POST /takeover/confirm
// ---------------------------------------------------------------------------

describe("PosOperatorsService.takeoverConfirm", () => {
  const VALID_BODY = {
    event_id: EVENT_ID,
    operator_id: OPERATOR_CLERK_SUB,
    device_token_attestation: "attest",
  };

  it("returns 'refused' when verifier throws", async () => {
    const pool = makePool();
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(new Error("bad sig")),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.takeoverConfirm("bad-jwt", VALID_BODY, "rid-1");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when operator_id in body does not match JWT sub", async () => {
    const pool = makePool();
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier("different_sub"),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.takeoverConfirm("jwt", VALID_BODY, "rid-2");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when device attestation is invalid", async () => {
    const pool = makePool();
    programPoolQueries(pool, [[VALID_USER_ROW]]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(null),
      SILENT_LOGGER,
    );

    const r = await svc.takeoverConfirm("jwt", VALID_BODY, "rid-3");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when no active session to supersede", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [MANAGER_MEMBERSHIP_ROW],
      // idempotency key INSERT returns fresh row
      [{ id: "ik-id", response_body: null }],
      // revokeActiveOperatorSession returns 0 rows
      [],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.takeoverConfirm("jwt", VALID_BODY, "rid-4");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when user lookup returns null (user_unmapped)", async () => {
    // Covers line 449: `if (!userRow) return { kind: "refused", reason: "user_unmapped" }`
    const pool = makePool();
    programPoolQueries(pool, [[]]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.takeoverConfirm("jwt", VALID_BODY, "rid-user-null");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when user is soft-deleted (user_disabled)", async () => {
    // Covers line 450: `if (userRow.deleted_at !== null) return { kind: "refused" }`
    const pool = makePool();
    programPoolQueries(pool, [
      [{ ...VALID_USER_ROW, deleted_at: new Date("2026-01-01") }],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.takeoverConfirm("jwt", VALID_BODY, "rid-user-deleted");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when membership lookup returns null (membership_missing)", async () => {
    // Covers line 458: `if (!membership) return { kind: "refused" }`
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [], // membership → null
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.takeoverConfirm("jwt", VALID_BODY, "rid-memb-null");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when membership is revoked (membership_revoked)", async () => {
    // Covers line 459: `if (membership.revoked_at !== null || membership.deleted_at !== null)`
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [{ ...MANAGER_MEMBERSHIP_ROW, revoked_at: new Date("2026-01-01") }],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.takeoverConfirm("jwt", VALID_BODY, "rid-memb-revoked");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when role_code is ineligible (role_ineligible)", async () => {
    // Covers line 462: `if (!ELIGIBLE_INTERNAL_ROLES.has(membership.role_code))`
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [{ ...MANAGER_MEMBERSHIP_ROW, role_code: "store_staff" }],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.takeoverConfirm("jwt", VALID_BODY, "rid-ineligible");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when store_access_kind is specific and store not in access set", async () => {
    // Covers the `if (!ok) return { kind: "refused" }` inside store_access_kind === "specific"
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [{ ...MANAGER_MEMBERSHIP_ROW, store_access_kind: "specific" }],
      [], // storeIsInAccessSet returns no rows
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.takeoverConfirm("jwt", VALID_BODY, "rid-store-denied");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when idempotency INSERT conflicts and SELECT finds different operator (conflict type)", async () => {
    // Covers line 900: `if (!existing.request_hash.equals(requestHashBuf))`
    // INSERT returns [] (ON CONFLICT DO NOTHING), SELECT returns a row with a different hash.
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [MANAGER_MEMBERSHIP_ROW],
      // upsertTakeoverIdempotencyKey INSERT → conflict (0 rows returned)
      [],
      // SELECT existing row → different request_hash
      [{ request_hash: Buffer.from("different-operator-hash"), response_body: null }],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.takeoverConfirm("jwt", VALID_BODY, "rid-ik-conflict");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when idempotency INSERT conflicts and SELECT returns nothing (race: fresh path)", async () => {
    // Covers line 895: `if (!existing)` after INSERT conflict + SELECT returns no rows.
    // The race path returns { type: "fresh" }, so the flow continues to revokeActiveSession
    // which finds nothing → refused.
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [MANAGER_MEMBERSHIP_ROW],
      // upsertTakeoverIdempotencyKey INSERT → conflict
      [],
      // SELECT existing row → nothing (race: row deleted between conflict and read)
      [],
      // revokeActiveOperatorSession → no session to revoke
      [],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.takeoverConfirm("jwt", VALID_BODY, "rid-ik-race");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when idempotency INSERT conflicts and SELECT finds same operator with null session_id (concurrent fresh)", async () => {
    // Covers line 907: `if (!sessionId)` when SELECT returns a row whose request_hash
    // matches (same operator) but response_body.session_id is null (concurrent confirm
    // hasn't written the session yet). Returns { type: "fresh" } again.
    const pool = makePool();
    const operatorHash = hashToken(OPERATOR_CLERK_SUB);
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [MANAGER_MEMBERSHIP_ROW],
      // upsertTakeoverIdempotencyKey INSERT → conflict
      [],
      // SELECT existing row → same operator hash, session_id not yet written
      [{ request_hash: operatorHash, response_body: { session_id: null } }],
      // revokeActiveOperatorSession → no session to revoke
      [],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.takeoverConfirm("jwt", VALID_BODY, "rid-ik-concurrent");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns signed_in on happy path and revokes prior session", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [MANAGER_MEMBERSHIP_ROW],
      // upsert idempotency key INSERT → fresh
      [{ id: "ik-id", response_body: null }],
      // revokeActiveOperatorSession → returns revoked session id
      [{ id: SESSION_ID }],
      // issueOperatorSessionRow → INSERT RETURNING
      [{ id: "new-session-id", issued_at: new Date() }],
      // updateIdempotencyKeyWithSession UPDATE (no return needed)
      [],
      // insertAuditEvent — handled internally, pool not called for this in tests
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.takeoverConfirm("jwt", VALID_BODY, "rid-5");
    expect(r).toMatchObject({
      kind: "signed_in",
      operator: {
        id: OPERATOR_CLERK_SUB,
        // 033 (SC-033-2): takeover-confirm fresh path carries the neutral key.
        user_id: USER_ID,
        role: "manager",
        tenant_id: TENANT_ID,
        branch_id: STORE_ID,
      },
      operator_session: { id: "new-session-id" },
    });
  });
});

// ---------------------------------------------------------------------------
// GET /active-session
// ---------------------------------------------------------------------------

const ACTIVE_SESSION_QUERY = { branch_id: STORE_ID, operator_id: OPERATOR_CLERK_SUB };

describe("PosOperatorsService.activeSession", () => {
  it("returns 'refused' when verifier throws", async () => {
    const pool = makePool();
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(new Error("bad sig")),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.activeSession("bad-jwt", ACTIVE_SESSION_QUERY, "rid-1");
    expect(r).toEqual({ kind: "refused" });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("returns 'refused' when requester user is not found", async () => {
    const pool = makePool();
    programPoolQueries(pool, [[]]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.activeSession("jwt", ACTIVE_SESSION_QUERY, "rid-2");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when requester user is soft-deleted", async () => {
    // Covers line 588: `if (requesterRow.deleted_at !== null) return { kind: "refused" }`
    const pool = makePool();
    programPoolQueries(pool, [
      [{ ...VALID_USER_ROW, deleted_at: new Date("2026-01-01") }],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.activeSession("jwt", ACTIVE_SESSION_QUERY, "rid-deleted");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when requester has no membership for the branch", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [], // membership lookup → not found
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.activeSession("jwt", ACTIVE_SESSION_QUERY, "rid-3");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when store_access_kind is specific and store not in access set", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [{ ...MANAGER_MEMBERSHIP_ROW, store_access_kind: "specific" }],
      [], // storeIsInAccessSet → not granted
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.activeSession("jwt", ACTIVE_SESSION_QUERY, "rid-4");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns { kind: 'none' } when target operator does not exist", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],             // requester lookup
      [MANAGER_MEMBERSHIP_ROW],     // membership lookup
      [],                           // target user lookup → not found
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.activeSession(
      "jwt",
      { branch_id: STORE_ID, operator_id: "unknown_sub" },
      "rid-5",
    );
    expect(r).toEqual({ kind: "none" });
  });

  it("returns { kind: 'none' } when target has no active session in the branch", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],                                  // requester lookup
      [MANAGER_MEMBERSHIP_ROW],                          // membership lookup
      [{ ...VALID_USER_ROW, id: OTHER_USER_ID }],        // target lookup
      [],                                                // anyActiveOperatorSessionInStore → 0 rows
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.activeSession(
      "jwt",
      { branch_id: STORE_ID, operator_id: "target_sub" },
      "rid-6",
    );
    expect(r).toEqual({ kind: "none" });
  });

  it("returns { kind: 'active' } when target has an active session in the branch", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],                                  // requester lookup
      [MANAGER_MEMBERSHIP_ROW],                          // membership lookup
      [{ ...VALID_USER_ROW, id: OTHER_USER_ID }],        // target lookup
      [{ one: 1 }],                                      // anyActiveOperatorSessionInStore → 1 row
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.activeSession(
      "jwt",
      { branch_id: STORE_ID, operator_id: "target_sub" },
      "rid-7",
    );
    expect(r).toEqual({ kind: "active" });
  });

  it("response is ONLY { kind } — no extra fields", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [MANAGER_MEMBERSHIP_ROW],
      [{ ...VALID_USER_ROW, id: OTHER_USER_ID }],
      [{ one: 1 }],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.activeSession(
      "jwt",
      { branch_id: STORE_ID, operator_id: "target_sub" },
      "rid-8",
    );
    expect(Object.keys(r)).toEqual(["kind"]);
  });
});
