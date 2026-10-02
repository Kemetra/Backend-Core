/**
 * session.repository.unit.spec.ts
 *
 * Docker-free unit coverage for SessionRepository (T304-B-api coverage lift).
 *
 * Strategy: hand-written fake for the Drizzle DB (extended beyond auth.service
 * fake to support .returning() on insert and update chains) plus a fake
 * SessionCache. No Testcontainers, no real DB, no Redis.
 *
 * The Testcontainers integration spec (session.repository.spec.ts) covers:
 *   - Real clock / now() filter semantics for absolute_expires_at
 *   - FK constraints (user_id, active_tenant_id, active_store_id)
 *   - Idempotent revoke timestamp preservation
 *   - DB-level CHECK constraint (Invariant I-4)
 * None of those are duplicated here.
 */

import { SessionRepository } from "../../src/auth/session.repository";
import type { SessionCache } from "../../src/auth/session.repository";
import type { NewSessionRow, SessionRow } from "@data-pulse-2/db/schema";

// ---------------------------------------------------------------------------
// Fake Drizzle DB
// ---------------------------------------------------------------------------
//
// The fake supports four chain shapes used by SessionRepository:
//
//   1. insert(t).values(v).returning()          -> Promise<SessionRow[]>
//   2. select().from(t).where(c).limit(1)       -> Promise<SessionRow[]>
//   3. update(t).set(p).where(c)                -> awaitable { rowCount }
//   4. update(t).set(p).where(c).returning()    -> Promise<SessionRow[]>
//
// Shape 3 vs 4 is distinguished by whether .returning() is called after
// .where(). The trick: .where() returns an object that is itself awaitable
// (via .then) for shape 3, and also exposes .returning() for shape 4.

let _insertRows: SessionRow[] = [];
let _selectRows: SessionRow[] = [];
let _updateRowCount: number | null = 1;
let _updateReturningRows: SessionRow[] = [];

function makeFakeDb() {
  const insertChain = {
    values: (_v: unknown) => insertChain,
    returning: () => Promise.resolve(_insertRows),
  };

  const whereResult = {
    // Shape 3: plain update — awaitable directly
    then: (
      resolve: (v: { rowCount: number | null }) => void,
      _reject?: (e: unknown) => void,
    ) => {
      return Promise.resolve({ rowCount: _updateRowCount }).then(
        resolve,
        _reject,
      );
    },
    // Shape 4: update with RETURNING
    returning: () => Promise.resolve(_updateReturningRows),
    // Shape 2 (select): limit
    limit: () => Promise.resolve(_selectRows),
  };

  const chain: Record<string, unknown> = {
    // insert chain
    insert: () => insertChain,
    // select chain
    select: () => chain,
    from: () => chain,
    // shared where (used by both select and update)
    where: () => whereResult,
    // update chain
    update: () => chain,
    set: () => chain,
  };

  return chain;
}

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => makeFakeDb()),
}));

// ---------------------------------------------------------------------------
// Fake SessionCache
// ---------------------------------------------------------------------------

function makeFakeCache(): jest.Mocked<SessionCache> {
  return {
    get: jest.fn<Promise<SessionRow | null>, [string]>().mockResolvedValue(null),
    set: jest.fn<Promise<void>, [SessionRow]>().mockResolvedValue(undefined),
    invalidate: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

const SESSION_ID = "0193b000-0000-7000-8000-000000000010";
const USER_ID = "0193b000-0000-7000-8000-000000000001";

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function makeLiveSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    issuedAt: new Date(),
    lastSeenAt: new Date(),
    revokedAt: null,
    activeTenantId: null,
    activeStoreId: null,
    userAgent: null,
    ipAtIssue: null,
    ...overrides,
  } as SessionRow;
}

function makeRevokedSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return makeLiveSession({ revokedAt: new Date(Date.now() - 1000), ...overrides });
}

function makeExpiredSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return makeLiveSession({
    absoluteExpiresAt: new Date(Date.now() - 1000),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Builder: construct SessionRepository under test
// ---------------------------------------------------------------------------

function buildRepo(cache?: jest.Mocked<SessionCache>) {
  const fakePool = {} as never;
  const repo = new SessionRepository(fakePool, cache ? { cache } : {});
  return { repo, cache: cache ?? null };
}

// ---------------------------------------------------------------------------
// Reset shared DB state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _insertRows = [];
  _selectRows = [];
  _updateRowCount = 1;
  _updateReturningRows = [];
  // Force drizzle mock to return a fresh fake each construction call
  const { drizzle } = jest.requireMock("drizzle-orm/node-postgres") as {
    drizzle: jest.Mock;
  };
  drizzle.mockImplementation(() => makeFakeDb());
});

// ===========================================================================
// A. create
// ===========================================================================

describe("SessionRepository.create", () => {
  it("A1: insert returns row — cache.set called, row returned", async () => {
    const row = makeLiveSession();
    _insertRows = [row];
    const cache = makeFakeCache();
    const { repo } = buildRepo(cache);

    const input = {
      id: SESSION_ID,
      userId: USER_ID,
      absoluteExpiresAt: row.absoluteExpiresAt,
    } as NewSessionRow;
    const result = await repo.create(input);

    expect(result).toBe(row);
    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(row);
  });

  it("A2: insert returns [] — throws with correct message", async () => {
    _insertRows = [];
    const cache = makeFakeCache();
    const { repo } = buildRepo(cache);

    const input = {
      id: SESSION_ID,
      userId: USER_ID,
      absoluteExpiresAt: new Date(Date.now() + 3600_000),
    } as NewSessionRow;

    await expect(repo.create(input)).rejects.toThrow(
      "SessionRepository.create: insert returned no row",
    );
  });

  it("A3: insert returns [] — cache.set is NOT called", async () => {
    _insertRows = [];
    const cache = makeFakeCache();
    const { repo } = buildRepo(cache);

    const input = {
      id: SESSION_ID,
      userId: USER_ID,
      absoluteExpiresAt: new Date(Date.now() + 3600_000),
    } as NewSessionRow;

    await expect(repo.create(input)).rejects.toThrow();
    expect(cache.set).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// B. findActiveById
// ===========================================================================

describe("SessionRepository.findActiveById", () => {
  it("B4: live cached row — returned immediately without DB call", async () => {
    const row = makeLiveSession();
    const cache = makeFakeCache();
    cache.get.mockResolvedValue(row);
    // _selectRows intentionally empty — DB must not be queried for a live cache hit
    _selectRows = [];
    const { repo } = buildRepo(cache);

    const result = await repo.findActiveById(SESSION_ID);

    expect(result).toBe(row);
    expect(cache.get).toHaveBeenCalledWith(SESSION_ID);
    // cache.set should NOT be called (no DB round-trip)
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("B5: revoked cached row — cache hit bypassed, DB queried", async () => {
    const revoked = makeRevokedSession();
    const dbRow = makeLiveSession();
    const cache = makeFakeCache();
    cache.get.mockResolvedValue(revoked);
    _selectRows = [dbRow];
    const { repo } = buildRepo(cache);

    const result = await repo.findActiveById(SESSION_ID);

    // Must not return the revoked cached row
    expect(result).toBe(dbRow);
    expect(cache.set).toHaveBeenCalledWith(dbRow);
  });

  it("B6: expired cached row — cache hit bypassed, DB queried", async () => {
    const expired = makeExpiredSession();
    const dbRow = makeLiveSession();
    const cache = makeFakeCache();
    cache.get.mockResolvedValue(expired);
    _selectRows = [dbRow];
    const { repo } = buildRepo(cache);

    const result = await repo.findActiveById(SESSION_ID);

    expect(result).toBe(dbRow);
    expect(cache.set).toHaveBeenCalledWith(dbRow);
  });

  it("B7: cache miss + DB row — row returned, cache.set called", async () => {
    const dbRow = makeLiveSession();
    const cache = makeFakeCache();
    cache.get.mockResolvedValue(null);
    _selectRows = [dbRow];
    const { repo } = buildRepo(cache);

    const result = await repo.findActiveById(SESSION_ID);

    expect(result).toBe(dbRow);
    expect(cache.set).toHaveBeenCalledWith(dbRow);
  });

  it("B8: cache miss + DB empty — returns null, cache.set NOT called", async () => {
    const cache = makeFakeCache();
    cache.get.mockResolvedValue(null);
    _selectRows = [];
    const { repo } = buildRepo(cache);

    const result = await repo.findActiveById(SESSION_ID);

    expect(result).toBeNull();
    expect(cache.set).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// C. touchLastSeen
// ===========================================================================

describe("SessionRepository.touchLastSeen", () => {
  it("C9: rowCount > 0 — returns true, cache invalidated", async () => {
    _updateRowCount = 1;
    const cache = makeFakeCache();
    const { repo } = buildRepo(cache);

    const result = await repo.touchLastSeen(SESSION_ID);

    expect(result).toBe(true);
    expect(cache.invalidate).toHaveBeenCalledTimes(1);
    expect(cache.invalidate).toHaveBeenCalledWith(SESSION_ID);
  });

  it("C10: rowCount = 0 — returns false, cache still invalidated", async () => {
    _updateRowCount = 0;
    const cache = makeFakeCache();
    const { repo } = buildRepo(cache);

    const result = await repo.touchLastSeen(SESSION_ID);

    expect(result).toBe(false);
    expect(cache.invalidate).toHaveBeenCalledWith(SESSION_ID);
  });

  it("C11: rowCount null — returns false, cache still invalidated", async () => {
    _updateRowCount = null;
    const cache = makeFakeCache();
    const { repo } = buildRepo(cache);

    const result = await repo.touchLastSeen(SESSION_ID);

    expect(result).toBe(false);
    expect(cache.invalidate).toHaveBeenCalledWith(SESSION_ID);
  });
});

// ===========================================================================
// D. updateActiveContext
// ===========================================================================

describe("SessionRepository.updateActiveContext", () => {
  it("D12: DB returns updated row — row returned, cache invalidated", async () => {
    const updated = makeLiveSession({ activeTenantId: "tenant-abc", activeStoreId: null });
    _updateReturningRows = [updated];
    const cache = makeFakeCache();
    const { repo } = buildRepo(cache);

    const result = await repo.updateActiveContext(SESSION_ID, {
      activeTenantId: "tenant-abc",
      activeStoreId: null,
    });

    expect(result).toBe(updated);
    expect(cache.invalidate).toHaveBeenCalledTimes(1);
    expect(cache.invalidate).toHaveBeenCalledWith(SESSION_ID);
  });

  it("D13: DB returns [] (revoked session) — returns null, cache still invalidated", async () => {
    _updateReturningRows = [];
    const cache = makeFakeCache();
    const { repo } = buildRepo(cache);

    const result = await repo.updateActiveContext(SESSION_ID, {
      activeTenantId: "tenant-abc",
      activeStoreId: null,
    });

    expect(result).toBeNull();
    expect(cache.invalidate).toHaveBeenCalledWith(SESSION_ID);
  });
});

// ===========================================================================
// F. NoOpSessionCache (default — no custom cache injected)
// ===========================================================================

describe("SessionRepository — default NoOpSessionCache", () => {
  it("F17: create succeeds without injected cache (NoOp paths exercised)", async () => {
    const row = makeLiveSession();
    _insertRows = [row];
    // buildRepo() with no cache arg — SessionRepository uses NoOpSessionCache internally
    const { repo } = buildRepo();

    const input = {
      id: SESSION_ID,
      userId: USER_ID,
      absoluteExpiresAt: row.absoluteExpiresAt,
    } as NewSessionRow;
    const result = await repo.create(input);
    expect(result).toBe(row);
  });

  it("F18: findActiveById with no cache — always falls through to DB", async () => {
    const dbRow = makeLiveSession();
    _selectRows = [dbRow];
    const { repo } = buildRepo();

    const result = await repo.findActiveById(SESSION_ID);
    expect(result).toBe(dbRow);
  });

  it("F19: touchLastSeen with no cache — NoOp.invalidate path exercised", async () => {
    _updateRowCount = 1;
    const { repo } = buildRepo();
    await expect(repo.touchLastSeen(SESSION_ID)).resolves.toBe(true);
  });
});

// ===========================================================================
// E. revoke
// ===========================================================================

describe("SessionRepository.revoke", () => {
  it("E14: rowCount > 0 — returns true, cache invalidated", async () => {
    _updateRowCount = 1;
    const cache = makeFakeCache();
    const { repo } = buildRepo(cache);

    const result = await repo.revoke(SESSION_ID);

    expect(result).toBe(true);
    expect(cache.invalidate).toHaveBeenCalledTimes(1);
    expect(cache.invalidate).toHaveBeenCalledWith(SESSION_ID);
  });

  it("E15: rowCount = 0 (already revoked) — returns false, cache still invalidated", async () => {
    _updateRowCount = 0;
    const cache = makeFakeCache();
    const { repo } = buildRepo(cache);

    const result = await repo.revoke(SESSION_ID);

    expect(result).toBe(false);
    expect(cache.invalidate).toHaveBeenCalledWith(SESSION_ID);
  });

  it("E16: rowCount null — returns false, cache still invalidated", async () => {
    _updateRowCount = null;
    const cache = makeFakeCache();
    const { repo } = buildRepo(cache);

    const result = await repo.revoke(SESSION_ID);

    expect(result).toBe(false);
    expect(cache.invalidate).toHaveBeenCalledWith(SESSION_ID);
  });
});
