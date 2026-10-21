/**
 * PosOperatorsService.signOut — unit spec (no Postgres, no Clerk network).
 *
 * Mirrors the PR-5 sign-in unit-spec style: mocks every dependency
 * (pg.Pool, OperatorTokenVerifier, DeviceRepository, Logger) so each refusal
 * branch can be exercised without standing up a container.
 *
 * Sign-out has no body-side device attestation and no `X-Device-Token`
 * header — the device / store / tenant binding was pinned at sign-in
 * onto the session row. The endpoint therefore performs identity checks
 * against the session row itself: the session must exist, be a
 * `pos_operator` scope row, belong to the resolved Clerk user, and be
 * unrevoked / unexpired.
 *
 * Every refusal cause collapses to a typed `{ kind: "refused" }` result
 * at the boundary. The controller maps it to a generic 401 envelope —
 * the same envelope that sign-in refusals produce (FR-POS-AUTH-6, ADR D10).
 */
import "reflect-metadata";

import type { Pool } from "pg";

import { PosOperatorsService } from "../../src/pos-operators/pos-operators.service";
import { DeviceRepository } from "../../src/pos-operators/device.repository";
import type { OperatorTokenVerifier } from "../../src/auth/operator-token-verifier";

interface MockPool {
  query: jest.Mock;
}

function makePool(): MockPool {
  return { query: jest.fn() };
}

function makeVerifier(sub: string | Error = "user_test_sub"): OperatorTokenVerifier {
  return {
    verify: jest.fn(async () => {
      if (sub instanceof Error) throw sub;
      return { providerKey: "clerk", sub };
    }),
  };
}

function makeDeviceRepo(): jest.Mocked<DeviceRepository> {
  return {
    findActiveByAttestation: jest.fn(async () => null),
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
  pool.query.mockImplementation(async () => ({
    rows: results[i++] ?? [],
  }));
}

const USER_ID = "44444444-4444-7444-8444-444444444444";
const OTHER_USER_ID = "55555555-5555-7555-8555-555555555555";
const SESSION_ID = "66666666-6666-7666-8666-666666666666";

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

const VALID_BODY = { session_id: SESSION_ID };

describe("PosOperatorsService.signOut", () => {
  it("returns 'refused' when the verifier throws (invalid Clerk JWT)", async () => {
    const pool = makePool();
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(new Error("bad signature")),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.signOut("not-a-jwt", VALID_BODY, "rid-1");

    expect(r).toEqual({ kind: "refused" });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("returns 'refused' when the Clerk subject does not map to a local user", async () => {
    const pool = makePool();
    programPoolQueries(pool, [
      // user lookup → empty
      [],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.signOut("jwt", VALID_BODY, "rid-2");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when the local user is soft-deleted", async () => {
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

    const r = await svc.signOut("jwt", VALID_BODY, "rid-3");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when no auth_tokens row matches the session_id", async () => {
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
      // session lookup → empty
      [],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.signOut("jwt", VALID_BODY, "rid-4");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when the session belongs to a different user", async () => {
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
          id: SESSION_ID,
          user_id: OTHER_USER_ID,
          scope: "pos_operator",
          revoked_at: null,
          expires_at: FUTURE,
        },
      ],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.signOut("jwt", VALID_BODY, "rid-5");
    expect(r).toEqual({ kind: "refused" });
    // Importantly, no UPDATE should have run for a wrong-user session.
    const updateCalls = pool.query.mock.calls.filter((args) =>
      typeof args[0] === "string" && /UPDATE\s+auth_tokens/i.test(args[0] as string),
    );
    expect(updateCalls).toHaveLength(0);
  });

  it("returns 'refused' when the session row is not pos_operator scope", async () => {
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
          id: SESSION_ID,
          user_id: USER_ID,
          scope: "dashboard_api",
          revoked_at: null,
          expires_at: FUTURE,
        },
      ],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.signOut("jwt", VALID_BODY, "rid-6");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when the session is already revoked", async () => {
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
          id: SESSION_ID,
          user_id: USER_ID,
          scope: "pos_operator",
          revoked_at: PAST,
          expires_at: FUTURE,
        },
      ],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.signOut("jwt", VALID_BODY, "rid-7");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns 'refused' when the session is expired", async () => {
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
          id: SESSION_ID,
          user_id: USER_ID,
          scope: "pos_operator",
          revoked_at: null,
          expires_at: PAST,
        },
      ],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.signOut("jwt", VALID_BODY, "rid-8");
    expect(r).toEqual({ kind: "refused" });
  });

  it("returns { kind: 'signed_out' } on the happy path and issues an UPDATE with revoked_at IS NULL guard", async () => {
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
      // 2. session lookup
      [
        {
          id: SESSION_ID,
          user_id: USER_ID,
          scope: "pos_operator",
          revoked_at: null,
          expires_at: FUTURE,
        },
      ],
      // 3. UPDATE auth_tokens RETURNING id
      [{ id: SESSION_ID }],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.signOut("jwt", VALID_BODY, "rid-9");
    expect(r).toEqual({ kind: "signed_out" });

    // Confirm the UPDATE is guarded against double-revoke races.
    const updateCalls = pool.query.mock.calls.filter((args) =>
      typeof args[0] === "string" && /UPDATE\s+auth_tokens/i.test(args[0] as string),
    );
    expect(updateCalls).toHaveLength(1);
    const sql = updateCalls[0]![0] as string;
    const params = updateCalls[0]![1] as unknown[];
    expect(sql).toMatch(/SET\s+revoked_at\s*=\s*now\(\)/i);
    expect(sql).toMatch(/WHERE[\s\S]+user_id\s*=\s*\$2/i);
    expect(sql).toMatch(/WHERE[\s\S]+revoked_at\s+IS\s+NULL/i);
    expect(params).toEqual([SESSION_ID, USER_ID]);
  });

  it("returns 'refused' when the UPDATE finds no row to revoke (race lost)", async () => {
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
          id: SESSION_ID,
          user_id: USER_ID,
          scope: "pos_operator",
          revoked_at: null,
          expires_at: FUTURE,
        },
      ],
      // UPDATE returned 0 rows — concurrent revoke beat us
      [],
    ]);
    const svc = new PosOperatorsService(
      pool as unknown as Pool,
      makeVerifier(),
      makeDeviceRepo(),
      SILENT_LOGGER,
    );

    const r = await svc.signOut("jwt", VALID_BODY, "rid-10");
    expect(r).toEqual({ kind: "refused" });
  });

  it("does NOT log the Clerk JWT or the session_id payload contents at the WARN level on refusal", async () => {
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

    const SECRET_JWT = "eyJraWQiOiJzZWNyZXQtand0LXNpZ24tb3V0In0.x.y";
    const svc = new PosOperatorsService(
      makePool() as unknown as Pool,
      makeVerifier(new Error("bad sig")),
      makeDeviceRepo(),
      logger,
    );

    await svc.signOut(SECRET_JWT, VALID_BODY, "rid-redact");

    const serialized = JSON.stringify(warnCalls);
    expect(serialized).not.toContain(SECRET_JWT);
  });
});
