/**
 * audit.repository.unit.spec.ts
 *
 * Docker-free unit coverage for DrizzleAuditRepository (T304-B-api coverage lift).
 *
 * Strategy: inject a fake `TenantTxRunner` (the `@Optional() tx` seam) so
 * every `listPage` call runs the inner `runQuery` synchronously on a fake
 * PoolClient. The Drizzle DB itself is replaced by a hand-written chain fake.
 *
 * Chain shape used by DrizzleAuditRepository.runQuery:
 *
 *   select().from(t).where(and(...)).orderBy(desc, desc).limit(n)
 *             -> Promise<Row[]>
 *
 * `where()` returns a whereResult that exposes `.orderBy()` which returns
 * an orderByResult that exposes `.limit()` which resolves to the seeded
 * row array.
 *
 * TxRunner injection pattern (vs. memberships/stores runWithTenantContext mock):
 *   DrizzleAuditRepository takes `@Optional() tx?: TenantTxRunner` as its
 *   second constructor argument. Tests pass a passthrough that records the
 *   ctx and forwards to the inner work fn — no module-level mock of
 *   @data-pulse-2/db needed.
 *
 * EXPLICIT EXCLUSION: RLS enforcement is NOT verified by these unit mocks.
 * The fake DB resolves whatever rows are seeded regardless of tenant context —
 * RLS is a DB-layer guarantee tested only with a real Postgres instance
 * (Testcontainers integration spec).
 */

import { DrizzleAuditRepository } from "../../src/audit/audit.repository";
import type {
  ListPageInput,
  AuditEventRecord,
} from "../../src/audit/audit.repository";
import type { Pool, PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Fixed test constants
// ---------------------------------------------------------------------------

const TENANT_ID = "0a000000-0000-7000-8000-0000000000a1";
const ACTOR_ID  = "0a000000-0000-7000-8000-00000000aa01";
const STORE_ID  = "0a000000-0000-7000-8000-0000000000c1";
const ROW_ID_1  = "0a000000-0000-7000-8000-000000000101";
const ROW_ID_2  = "0a000000-0000-7000-8000-000000000102";
const REQUEST_ID = "0a000000-0000-7000-8000-0000000000e1";
const TARGET_ID = "0a000000-0000-7000-8000-0000000000d1";

// ---------------------------------------------------------------------------
// Module-level state — reset in beforeEach
// ---------------------------------------------------------------------------

let _selectRows: Record<string, unknown>[] = [];

// ---------------------------------------------------------------------------
// Fake Drizzle DB chain
// ---------------------------------------------------------------------------
//
// DrizzleAuditRepository.runQuery chain:
//   select().from(t).where(and(...)).orderBy(desc, desc).limit(n)
//
// `where()` must NOT be thenable (the repo does not await it directly).
// Instead it exposes `.orderBy()` which exposes `.limit()`.

function makeFakeDb() {
  const limitResult = {
    then: (
      resolve: (v: Record<string, unknown>[]) => void,
      _reject?: (e: unknown) => void,
    ) => Promise.resolve(_selectRows).then(resolve, _reject),
  };

  const orderByResult = {
    limit: (_n: number) => limitResult,
  };

  const whereResult = {
    orderBy: (..._args: unknown[]) => orderByResult,
  };

  const chain: Record<string, unknown> = {
    select: (_fields?: unknown) => chain,
    from: () => chain,
    where: (..._args: unknown[]) => whereResult,
  };

  return chain;
}

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => makeFakeDb()),
}));

// ---------------------------------------------------------------------------
// TxRunner fake — records ctx and calls work with a fake PoolClient
// ---------------------------------------------------------------------------

type TxCtx = { tenantId: string | null; isPlatformAdmin: boolean };

let _lastTxCtx: TxCtx | null = null;

function fakeTx(
  _pool: Pool,
  ctx: TxCtx,
  work: (client: PoolClient) => Promise<AuditEventRecord[]>,
): Promise<AuditEventRecord[]> {
  _lastTxCtx = ctx;
  return work({} as PoolClient);
}

// ---------------------------------------------------------------------------
// Row builder — DB-level shape (column names match drizzle schema)
// ---------------------------------------------------------------------------

function makeDbRow(overrides: Partial<{
  id: string;
  occurredAt: Date;
  actorUserId: string | null;
  actorLabel: string | null;
  tenantId: string | null;
  storeId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  metadata: Record<string, unknown> | null;
}> = {}): Record<string, unknown> {
  return {
    id: ROW_ID_1,
    occurredAt: new Date("2026-05-01T12:00:00.000Z"),
    actorUserId: ACTOR_ID,
    actorLabel: null,
    tenantId: TENANT_ID,
    storeId: null,
    action: "auth.signin.ok",
    targetType: null,
    targetId: null,
    requestId: REQUEST_ID,
    metadata: { ip: "1.2.3.4" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Base input builder
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<ListPageInput> = {}): ListPageInput {
  return {
    tenantId: TENANT_ID,
    isPlatformAdmin: false,
    cursor: null,
    limit: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Builder: construct DrizzleAuditRepository with the fake TxRunner
// ---------------------------------------------------------------------------

function buildRepo() {
  const fakePool = {} as Pool;
  const repo = new DrizzleAuditRepository(fakePool, fakeTx as unknown as NonNullable<ConstructorParameters<typeof DrizzleAuditRepository>[1]>);
  return { repo };
}

// ---------------------------------------------------------------------------
// Reset state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _selectRows = [];
  _lastTxCtx = null;

  const { drizzle } = jest.requireMock("drizzle-orm/node-postgres") as {
    drizzle: jest.Mock;
  };
  drizzle.mockImplementation(() => makeFakeDb());
});

// ===========================================================================
// A. listPage — empty result
// ===========================================================================

describe("DrizzleAuditRepository.listPage — empty result", () => {
  it("A1: returns empty array when DB returns no rows", async () => {
    _selectRows = [];
    const { repo } = buildRepo();

    const result = await repo.listPage(makeInput());

    expect(result).toEqual([]);
  });
});

// ===========================================================================
// B. listPage — row mapping
// ===========================================================================

describe("DrizzleAuditRepository.listPage — row mapping", () => {
  it("B2: maps DB row to AuditEventRecord shape (camelCase fields)", async () => {
    const occurredAt = new Date("2026-05-01T12:00:00.000Z");
    _selectRows = [
      makeDbRow({
        id: ROW_ID_1,
        occurredAt,
        actorUserId: ACTOR_ID,
        actorLabel: "alice@example.com",
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        action: "auth.signin.ok",
        targetType: "store",
        targetId: TARGET_ID,
        requestId: REQUEST_ID,
        metadata: { reason: "test" },
      }),
    ];
    const { repo } = buildRepo();

    const [row] = await repo.listPage(makeInput());

    expect(row).toBeDefined();
    expect(row!.id).toBe(ROW_ID_1);
    expect(row!.occurredAt).toEqual(occurredAt);
    expect(row!.actorUserId).toBe(ACTOR_ID);
    expect(row!.actorLabel).toBe("alice@example.com");
    expect(row!.tenantId).toBe(TENANT_ID);
    expect(row!.storeId).toBe(STORE_ID);
    expect(row!.action).toBe("auth.signin.ok");
    expect(row!.targetType).toBe("store");
    expect(row!.targetId).toBe(TARGET_ID);
    expect(row!.requestId).toBe(REQUEST_ID);
    expect(row!.metadata).toEqual({ reason: "test" });
  });

  it("B3: maps multiple rows preserving driver order", async () => {
    _selectRows = [
      makeDbRow({ id: ROW_ID_1, action: "auth.signin.ok" }),
      makeDbRow({ id: ROW_ID_2, action: "auth.signout.ok" }),
    ];
    const { repo } = buildRepo();

    const result = await repo.listPage(makeInput());

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe(ROW_ID_1);
    expect(result[0]!.action).toBe("auth.signin.ok");
    expect(result[1]!.id).toBe(ROW_ID_2);
    expect(result[1]!.action).toBe("auth.signout.ok");
  });

  it("B4: null metadata from DB row is defaulted to {} in mapping", async () => {
    _selectRows = [makeDbRow({ metadata: null })];
    const { repo } = buildRepo();

    const [row] = await repo.listPage(makeInput());

    expect(row!.metadata).toEqual({});
  });

  it("B5: null tenantId in DB row falls back to input.tenantId (defence-in-depth row mapping)", async () => {
    // The explicit WHERE predicate prevents cross-tenant rows, but if the
    // column somehow arrives null, the mapping coerces to input.tenantId.
    _selectRows = [makeDbRow({ tenantId: null })];
    const { repo } = buildRepo();

    const [row] = await repo.listPage(makeInput({ tenantId: TENANT_ID }));

    expect(row!.tenantId).toBe(TENANT_ID);
  });

  it("B6: nullable fields (actorUserId, actorLabel, storeId, targetType, targetId, requestId) preserved as null", async () => {
    _selectRows = [
      makeDbRow({
        actorUserId: null,
        actorLabel: null,
        storeId: null,
        targetType: null,
        targetId: null,
        requestId: null,
      }),
    ];
    const { repo } = buildRepo();

    const [row] = await repo.listPage(makeInput());

    expect(row!.actorUserId).toBeNull();
    expect(row!.actorLabel).toBeNull();
    expect(row!.storeId).toBeNull();
    expect(row!.targetType).toBeNull();
    expect(row!.targetId).toBeNull();
    expect(row!.requestId).toBeNull();
  });
});

// ===========================================================================
// C. listPage — TxRunner delegation
// ===========================================================================

describe("DrizzleAuditRepository.listPage — TxRunner delegation", () => {
  it("C7: invokes TxRunner with the tenantId from input", async () => {
    _selectRows = [];
    const { repo } = buildRepo();

    await repo.listPage(makeInput({ tenantId: TENANT_ID, isPlatformAdmin: false }));

    expect(_lastTxCtx).not.toBeNull();
    expect(_lastTxCtx!.tenantId).toBe(TENANT_ID);
  });

  it("C8: invokes TxRunner with isPlatformAdmin=true when platform admin caller", async () => {
    _selectRows = [];
    const { repo } = buildRepo();

    await repo.listPage(makeInput({ isPlatformAdmin: true }));

    expect(_lastTxCtx!.isPlatformAdmin).toBe(true);
  });

  it("C9: invokes TxRunner with isPlatformAdmin=false for a regular tenant caller", async () => {
    _selectRows = [];
    const { repo } = buildRepo();

    await repo.listPage(makeInput({ isPlatformAdmin: false }));

    expect(_lastTxCtx!.isPlatformAdmin).toBe(false);
  });
});

// ===========================================================================
// D. listPage — optional filter presence does not break query or mapping
// ===========================================================================

describe("DrizzleAuditRepository.listPage — optional filters produce mapped results", () => {
  it("D10: action filter set — returns mapped rows without error", async () => {
    _selectRows = [makeDbRow({ action: "auth.signin.ok" })];
    const { repo } = buildRepo();

    const result = await repo.listPage(makeInput({ action: "auth." }));

    expect(result).toHaveLength(1);
    expect(result[0]!.action).toBe("auth.signin.ok");
  });

  it("D11: actorUserId filter set — returns mapped rows without error", async () => {
    _selectRows = [makeDbRow({ actorUserId: ACTOR_ID })];
    const { repo } = buildRepo();

    const result = await repo.listPage(makeInput({ actorUserId: ACTOR_ID }));

    expect(result).toHaveLength(1);
    expect(result[0]!.actorUserId).toBe(ACTOR_ID);
  });

  it("D12: storeId filter set — returns mapped rows without error", async () => {
    _selectRows = [makeDbRow({ storeId: STORE_ID })];
    const { repo } = buildRepo();

    const result = await repo.listPage(makeInput({ storeId: STORE_ID }));

    expect(result).toHaveLength(1);
    expect(result[0]!.storeId).toBe(STORE_ID);
  });

  it("D13: from / to date filters set — returns mapped rows without error", async () => {
    _selectRows = [makeDbRow()];
    const { repo } = buildRepo();

    const result = await repo.listPage(
      makeInput({
        from: new Date("2026-05-01T00:00:00Z"),
        to: new Date("2026-05-31T23:59:59Z"),
      }),
    );

    expect(result).toHaveLength(1);
  });

  it("D14: cursor non-null — returns mapped rows without error", async () => {
    _selectRows = [makeDbRow()];
    const { repo } = buildRepo();

    const result = await repo.listPage(
      makeInput({
        cursor: {
          occurredAt: new Date("2026-05-01T11:00:00Z"),
          id: ROW_ID_1,
        },
      }),
    );

    expect(result).toHaveLength(1);
  });

  it("D15: all optional filters set simultaneously — no error, mapped rows returned", async () => {
    _selectRows = [makeDbRow()];
    const { repo } = buildRepo();

    const result = await repo.listPage(
      makeInput({
        action: "auth.",
        actorUserId: ACTOR_ID,
        storeId: STORE_ID,
        from: new Date("2026-05-01T00:00:00Z"),
        to: new Date("2026-05-31T23:59:59Z"),
        cursor: { occurredAt: new Date("2026-05-01T11:00:00Z"), id: ROW_ID_1 },
        limit: 25,
      }),
    );

    expect(result).toHaveLength(1);
  });
});

// ===========================================================================
// E. listPage — limit propagation
// ===========================================================================

describe("DrizzleAuditRepository.listPage — limit propagation", () => {
  it("E16: returns up to the supplied limit rows from DB (fake returns exactly limit rows)", async () => {
    _selectRows = Array.from({ length: 10 }, (_, i) =>
      makeDbRow({ id: `0a000000-0000-7000-8000-0000000001${String(i).padStart(2, "0")}` }),
    );
    const { repo } = buildRepo();

    const result = await repo.listPage(makeInput({ limit: 10 }));

    expect(result).toHaveLength(10);
  });
});
