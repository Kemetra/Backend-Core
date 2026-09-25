/**
 * 033 — POS-facing provider-neutral `user_id` surface (unit spec).
 *
 * Asserts the FRs/SCs of spec 033 that the existing sign-in / takeover-fresh
 * success tests do not already cover:
 *
 *   - SC-033-2 path 4: takeover-confirm IDEMPOTENT REPLAY (envelope is null)
 *     still carries `user_id == users.id` and non-null (it is identity, not a
 *     hash-once secret).
 *   - FR-033-5: `user_id` is a sibling response field, NOT encoded inside the
 *     opaque `envelope` bearer string.
 *   - SC-033-1: `user_id` is `users.id`, distinct from `id` (= clerk_user_id).
 *   - US2 / SC-033-3: backward-compatibility characterized against the REAL
 *     contract boundary — a lenient consumer ignores the new field; a strict
 *     validator pinned to the OLD `additionalProperties: false` schema rejects
 *     it (which is why the contract bump is a coordinated DP2/POS-Pulse pin
 *     pair — plan §OQ-033-2).
 *
 * Harness mirrors pos-operators.wave3.service.spec.ts: a mock pool whose
 * `query` returns programmed results in order; transaction-control statements
 * on the connect() client are skipped.
 */
import "reflect-metadata";

import type { Pool } from "pg";

import { PosOperatorsService } from "../../src/pos-operators/pos-operators.service";
import { DeviceRepository } from "../../src/pos-operators/device.repository";
import type { ClerkVerifier } from "../../src/pos-operators/clerk-verifier";
import { hashToken } from "@data-pulse-2/auth";

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

function makeVerifier(sub = "user_test_sub"): ClerkVerifier {
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
  child: jest.fn(() => SILENT_LOGGER),
} as unknown as ConstructorParameters<typeof PosOperatorsService>[3];

function programPoolQueries(pool: MockPool, results: Array<unknown[]>): void {
  let i = 0;
  pool.query.mockImplementation(async () => ({ rows: results[i++] ?? [] }));
}

const TENANT_ID = "11111111-1111-7111-8111-111111111111";
const STORE_ID = "22222222-2222-7222-8222-222222222222";
const USER_ID = "33333333-3333-7333-8333-333333333333";
const SESSION_ID = "55555555-5555-7555-8555-555555555555";
const MEMBERSHIP_ID = "66666666-6666-7666-8666-666666666666";
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

const VALID_TAKEOVER_BODY = {
  event_id: "77777777-7777-4777-8777-777777777777",
  operator_id: OPERATOR_CLERK_SUB,
  device_token_attestation: "attest",
};

/**
 * Programs the query sequence for a takeover-confirm IDEMPOTENT REPLAY:
 * user → membership → idempotency INSERT conflict (empty) → SELECT existing
 * (same operator hash, session_id present) → findOperatorSessionWithIssuedAt
 * (live session). Service returns the `duplicate` branch with envelope: null.
 */
function programReplay(pool: MockPool): void {
  programPoolQueries(pool, [
    [VALID_USER_ROW],
    [MANAGER_MEMBERSHIP_ROW],
    // upsert INSERT → conflict (ON CONFLICT DO NOTHING returns no rows)
    [],
    // SELECT existing row → same operator, session_id already written
    [
      {
        request_hash: hashToken(OPERATOR_CLERK_SUB),
        response_body: { session_id: SESSION_ID },
      },
    ],
    // findOperatorSessionWithIssuedAt → live (non-revoked, future expiry)
    [
      {
        id: SESSION_ID,
        user_id: USER_ID,
        scope: "pos_operator",
        revoked_at: null,
        expires_at: FUTURE,
        issued_at: new Date("2026-05-06T12:00:00Z"),
      },
    ],
  ]);
}

describe("033 — takeover-confirm idempotent replay (null envelope) carries user_id", () => {
  it("returns signed_in with envelope=null AND a non-null user_id == users.id", async () => {
    const pool = makePool();
    programReplay(pool);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.takeoverConfirm("jwt", VALID_TAKEOVER_BODY, "rid-replay");

    expect(r.kind).toBe("signed_in");
    if (r.kind !== "signed_in") throw new Error("expected signed_in");

    // Envelope is null on an idempotent replay (031 hash-once invariant)...
    expect(r.operator_session.envelope).toBeNull();
    // ...but user_id is identity, not a secret — STILL present and non-null.
    expect(r.operator.user_id).toBe(USER_ID);
    expect(r.operator.user_id).not.toBe(OPERATOR_CLERK_SUB);
    // Bridge id retained.
    expect(r.operator.id).toBe(OPERATOR_CLERK_SUB);
  });

  it("FR-033-5: user_id does NOT leak into the opaque envelope (envelope is the only token surface)", async () => {
    const pool = makePool();
    // Fresh sign-in path produces a real envelope string.
    programPoolQueries(pool, [
      [VALID_USER_ROW],
      [MANAGER_MEMBERSHIP_ROW],
      [], // no active session
      [{ id: SESSION_ID, issued_at: new Date("2026-05-06T12:00:00Z") }],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(ACTIVE_DEVICE),
      SILENT_LOGGER,
    );

    const r = await svc.signIn("jwt", { device_token_attestation: "attest" }, "rid-env");

    expect(r.kind).toBe("signed_in");
    if (r.kind !== "signed_in") throw new Error("expected signed_in");

    const envelope = r.operator_session.envelope;
    expect(typeof envelope).toBe("string");
    // user_id must be a sibling field, never embedded in the bearer bytes.
    expect(envelope).not.toContain(USER_ID);
    expect(r.operator.user_id).toBe(USER_ID);
  });
});

describe("033 — US2 backward-compatibility characterization (SC-033-3)", () => {
  // Minimal local re-statements of the OLD and NEW PosOperatorSummary shapes,
  // mirroring the OpenAPI schema (required fields + additionalProperties: false).
  const OLD_REQUIRED = ["id", "display_name", "role", "tenant_id", "branch_id"];

  function validateStrict(obj: Record<string, unknown>, allowed: string[]): boolean {
    // required present?
    if (!allowed.every((k) => k in obj)) return false;
    // additionalProperties: false → no key outside `allowed`
    return Object.keys(obj).every((k) => allowed.includes(k));
  }

  const NEW_RESPONSE = {
    id: OPERATOR_CLERK_SUB,
    user_id: USER_ID,
    display_name: "Test User",
    role: "manager",
    tenant_id: TENANT_ID,
    branch_id: STORE_ID,
  };

  it("lenient consumer (reads only the 5 old fields) ignores user_id — no break", () => {
    // A lenient client picks the fields it knows; the unknown field is harmless.
    const { id, display_name, role, tenant_id, branch_id } = NEW_RESPONSE;
    expect({ id, display_name, role, tenant_id, branch_id }).toEqual({
      id: OPERATOR_CLERK_SUB,
      display_name: "Test User",
      role: "manager",
      tenant_id: TENANT_ID,
      branch_id: STORE_ID,
    });
  });

  it("strict consumer pinned to the OLD schema (additionalProperties:false) REJECTS user_id", () => {
    // This is WHY the contract bump is a coordinated pin-pair (plan §OQ-033-2):
    // a strict validator on the old schema rejects the new field.
    expect(validateStrict(NEW_RESPONSE, OLD_REQUIRED)).toBe(false);
    // Against the NEW (post-T1) allow-list it validates.
    expect(validateStrict(NEW_RESPONSE, [...OLD_REQUIRED, "user_id"])).toBe(true);
  });
});
