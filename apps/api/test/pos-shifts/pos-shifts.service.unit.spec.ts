jest.mock("@data-pulse-2/db", () => ({
  runWithTenantContext: jest.fn(async (pool: Pool, _ctx: unknown, fn: (c: unknown) => unknown) => fn({ query: (...args: unknown[]) => (pool.query as jest.Mock)(...args) })),
}));

import "reflect-metadata";

import type { Pool } from "pg";
import type { Logger } from "@data-pulse-2/shared";
import { runWithTenantContext } from "@data-pulse-2/db";
import { PosShiftsService } from "../../src/pos-shifts/pos-shifts.service";
import type { ClerkVerifier } from "../../src/pos-operators/clerk-verifier";

const BRANCH_ID   = "b1000000-0000-4000-8000-000000000001";
const TENANT_ID   = "b1000000-0000-4000-8000-000000000002";
const USER_ID     = "b1000000-0000-4000-8000-000000000003";
const MEMBERSHIP_ID = "b1000000-0000-4000-8000-000000000004";
const CLERK_SUB   = "user_clerk_test_sub";
const RAW_JWT     = "raw-jwt-token";

const SHIFT_ROW = {
  shift_id: "s1",
  display_name: "Alice",
  label: "Till 1",
  opened_at: new Date(Date.now() - 3_600_000),
};

const MEMBERSHIP_ROW = {
  id: MEMBERSHIP_ID,
  tenant_id: TENANT_ID,
  store_access_kind: "all",
  role_code: "store_manager",
};

function makePool(): jest.Mocked<Pick<Pool, "query">> & Pool {
  return { query: jest.fn() } as unknown as jest.Mocked<Pick<Pool, "query">> & Pool;
}

function makeVerifier(sub: string | Error = CLERK_SUB): ClerkVerifier {
  return {
    verify: jest.fn(async () => {
      if (sub instanceof Error) throw sub;
      return { sub };
    }),
  };
}

const mockLogger = {
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  fatal: jest.fn(),
  child: jest.fn(),
} as unknown as Logger;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("PosShiftsService.getStuck — JWT verify failure", () => {
  it("returns { kind: 'refused' } when clerkVerifier.verify throws", async () => {
    const pool = makePool();
    const verifier = makeVerifier(new Error("invalid jwt"));
    const service = new PosShiftsService(pool, verifier, mockLogger);

    const result = await service.getStuck(RAW_JWT, BRANCH_ID, null);

    expect(result.kind).toBe("refused");
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe("PosShiftsService.getStuck — user lookup failure", () => {
  it("returns { kind: 'refused' } when no users row matches the clerk sub", async () => {
    const pool = makePool();
    const verifier = makeVerifier(CLERK_SUB);
    const service = new PosShiftsService(pool, verifier, mockLogger);

    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const result = await service.getStuck(RAW_JWT, BRANCH_ID, "req-1");

    expect(result.kind).toBe("refused");
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe("PosShiftsService.getStuck — membership lookup failure", () => {
  it("returns { kind: 'refused' } when no membership row is found", async () => {
    const pool = makePool();
    const verifier = makeVerifier(CLERK_SUB);
    const service = new PosShiftsService(pool, verifier, mockLogger);

    (pool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ id: USER_ID }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.getStuck(RAW_JWT, BRANCH_ID, null);

    expect(result.kind).toBe("refused");
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});

describe("PosShiftsService.getStuck — ineligible role", () => {
  it("returns { kind: 'refused' } when role_code is 'store_staff'", async () => {
    const pool = makePool();
    const verifier = makeVerifier(CLERK_SUB);
    const service = new PosShiftsService(pool, verifier, mockLogger);

    (pool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ id: USER_ID }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: MEMBERSHIP_ID,
            tenant_id: TENANT_ID,
            store_access_kind: "all",
            role_code: "store_staff",
          },
        ],
      });

    const result = await service.getStuck(RAW_JWT, BRANCH_ID, null);

    expect(result.kind).toBe("refused");
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});

describe("PosShiftsService.getStuck — specific store access failure", () => {
  it("returns { kind: 'refused' } when store_access_kind is 'specific' and store is not in access set", async () => {
    const pool = makePool();
    const verifier = makeVerifier(CLERK_SUB);
    const service = new PosShiftsService(pool, verifier, mockLogger);

    (pool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ id: USER_ID }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: MEMBERSHIP_ID,
            tenant_id: TENANT_ID,
            store_access_kind: "specific",
            role_code: "store_manager",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.getStuck(RAW_JWT, BRANCH_ID, null);

    expect(result.kind).toBe("refused");
    expect(pool.query).toHaveBeenCalledTimes(3);
  });
});

describe("PosShiftsService.getStuck — happy path (all-access)", () => {
  it("returns { kind: 'ok', body: { kind: 'ok', shifts: [...] } } for all-access manager", async () => {
    const pool = makePool();
    const verifier = makeVerifier(CLERK_SUB);
    const service = new PosShiftsService(pool, verifier, mockLogger);

    (pool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ id: USER_ID }] })
      .mockResolvedValueOnce({ rows: [MEMBERSHIP_ROW] });

    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [SHIFT_ROW] });

    const result = await service.getStuck(RAW_JWT, BRANCH_ID, "req-2");

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(runWithTenantContext).toHaveBeenNthCalledWith(
      1, pool, { tenantId: null, isPlatformAdmin: true }, expect.any(Function),
    );
    expect(runWithTenantContext).toHaveBeenNthCalledWith(
      2, pool, { tenantId: TENANT_ID, isPlatformAdmin: false }, expect.any(Function),
    );
    expect(result.body.kind).toBe("ok");
    expect(Array.isArray(result.body.shifts)).toBe(true);
    expect(result.body.shifts).toHaveLength(1);
    const shift = result.body.shifts[0]!;
    expect(shift.shift_id).toBe("s1");
    expect(shift.cashier_display_name).toBe("Alice");
    expect(shift.terminal_label).toBe("Till 1");
    expect(typeof shift.opened_at).toBe("string");
    expect(typeof shift.duration_minutes).toBe("number");
    expect(shift.duration_minutes).toBeGreaterThanOrEqual(0);
  });

  it("returns empty shifts array when no stuck shifts exist", async () => {
    const pool = makePool();
    const verifier = makeVerifier(CLERK_SUB);
    const service = new PosShiftsService(pool, verifier, mockLogger);

    (pool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ id: USER_ID }] })
      .mockResolvedValueOnce({ rows: [MEMBERSHIP_ROW] });

    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const result = await service.getStuck(RAW_JWT, BRANCH_ID, null);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.body.shifts).toHaveLength(0);
  });
});

describe("PosShiftsService.getStuck — specific-access happy path", () => {
  it("returns { kind: 'ok' } when store_access_kind is 'specific' and store is in access set", async () => {
    const pool = makePool();
    const verifier = makeVerifier(CLERK_SUB);
    const service = new PosShiftsService(pool, verifier, mockLogger);

    (pool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ id: USER_ID }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: MEMBERSHIP_ID,
            tenant_id: TENANT_ID,
            store_access_kind: "specific",
            role_code: "store_manager",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ one: 1 }] });

    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [SHIFT_ROW] });

    const result = await service.getStuck(RAW_JWT, BRANCH_ID, null);

    expect(result.kind).toBe("ok");
    expect(pool.query).toHaveBeenCalledTimes(4);
  });
});

describe("PosShiftsService — default stuckThresholdMinutes", () => {
  it("can be constructed without the 4th parameter (default = 15)", () => {
    const pool = makePool();
    const verifier = makeVerifier(CLERK_SUB);
    expect(() => new PosShiftsService(pool, verifier, mockLogger)).not.toThrow();
  });
});

describe("PosShiftsService.getStuck — eligible roles", () => {
  const eligibleRoles = ["owner", "tenant_admin", "store_manager"] as const;

  for (const role of eligibleRoles) {
    it(`allows role '${role}' through to runWithTenantContext`, async () => {
      const pool = makePool();
      const verifier = makeVerifier(CLERK_SUB);
      const service = new PosShiftsService(pool, verifier, mockLogger);

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ id: USER_ID }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: MEMBERSHIP_ID,
              tenant_id: TENANT_ID,
              store_access_kind: "all",
              role_code: role,
            },
          ],
        });

      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const result = await service.getStuck(RAW_JWT, BRANCH_ID, null);
      expect(result.kind).toBe("ok");
    });
  }
});
