/**
 * DeviceRepository — unit spec (no Postgres).
 *
 * The only branch that is unreachable via HTTP-level integration tests
 * is the early-return guard at the top of `findActiveByAttestation`:
 *
 *   if (rawAttestation.length === 0) return null;
 *
 * When called via the HTTP endpoint the Zod schema enforces `.min(1)` on
 * `device_token_attestation`, so an empty string never reaches the repo.
 * This spec calls the method directly with an empty string to cover that
 * defensive branch without standing up a Postgres container.
 */
import "reflect-metadata";

import type { Pool } from "pg";

import { deviceActivity } from "../../src/pos-operators/device-activity";
import { DeviceRepository } from "../../src/pos-operators/device.repository";

describe("DeviceRepository.findActiveByAttestation — empty attestation guard", () => {
  it("returns null immediately for an empty attestation string without querying the DB", async () => {
    // The pool is never called when the attestation is empty.
    const fakePool = {
      query: jest.fn().mockRejectedValue(new Error("should not be called")),
    } as unknown as Pool;

    const repo = new DeviceRepository(fakePool, fakePool);
    const result = await repo.findActiveByAttestation("");

    expect(result).toBeNull();
    expect((fakePool as unknown as { query: jest.Mock }).query).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// RT-213 — the tenant-status gate shared by every device lookup
// ===========================================================================

const DEVICE_ID = "0a000000-0000-7000-8000-0000000de213";
const TENANT_ID = "0a000000-0000-7000-8000-0000000a0213";
const STORE_ID = "0a000000-0000-7000-8000-0000000b0213";

/** Pre-tenant lookup pool answering drizzle's array-mode device query. */
function lookupPool(found: boolean): { pool: Pool; query: jest.Mock } {
  const query = jest.fn(async (config: { rowMode?: string }) => {
    if (found && config && config.rowMode === "array") {
      return {
        rows: [
          [
            DEVICE_ID,
            TENANT_ID,
            STORE_ID,
            "Lane 1",
            Buffer.from("hash"),
            null,
            "2026-10-01T00:00:00.000Z",
            "2026-10-01T00:00:00.000Z",
          ],
        ],
      };
    }
    return { rows: [] };
  });
  return { pool: { query } as unknown as Pool, query };
}

/** Domain pool whose tenant-context client returns `tenantRow` for the tenants read. */
function domainPool(tenantRow: { status: string; deleted_at: Date | null } | null): {
  pool: Pool;
  connect: jest.Mock;
  queries: string[];
} {
  const queries: string[] = [];
  const client = {
    query: jest.fn(async (text: string) => {
      queries.push(text);
      if (/\bfrom\s+tenants\b/i.test(text)) {
        return { rows: tenantRow === null ? [] : [tenantRow] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const connect = jest.fn(async () => client);
  return { pool: { connect } as unknown as Pool, connect, queries };
}

const ACTIVE = { status: "active", deleted_at: null };
const SUSPENDED = { status: "suspended", deleted_at: null };
const DELETED = { status: "active", deleted_at: new Date("2026-10-01T00:00:00Z") };

describe("DeviceRepository — RT-213 tenant status gate", () => {
  it("findActiveByAttestation: active tenant → the device row", async () => {
    const repo = new DeviceRepository(lookupPool(true).pool, domainPool(ACTIVE).pool);
    const row = await repo.findActiveByAttestation("device-token");
    expect(row?.id).toBe(DEVICE_ID);
    expect(row?.tenantId).toBe(TENANT_ID);
  });

  it.each([
    ["suspended", SUSPENDED],
    ["soft-deleted", DELETED],
    ["not visible", null],
  ])("findActiveByAttestation: %s tenant → null (as if revoked)", async (_label, tenant) => {
    const repo = new DeviceRepository(lookupPool(true).pool, domainPool(tenant).pool);
    expect(await repo.findActiveByAttestation("device-token")).toBeNull();
  });

  it("findActiveByAttestation: no active device → null without reading the tenant", async () => {
    const domain = domainPool(ACTIVE);
    const repo = new DeviceRepository(lookupPool(false).pool, domain.pool);
    expect(await repo.findActiveByAttestation("device-token")).toBeNull();
    expect(domain.connect).not.toHaveBeenCalled();
  });

  it("findActiveById: active tenant → the device row", async () => {
    const repo = new DeviceRepository(lookupPool(true).pool, domainPool(ACTIVE).pool);
    const row = await repo.findActiveById(DEVICE_ID);
    expect(row?.id).toBe(DEVICE_ID);
    expect(row?.tenantId).toBe(TENANT_ID);
  });

  it.each([
    ["suspended", SUSPENDED],
    ["soft-deleted", DELETED],
  ])("findActiveById: %s tenant → null (as if revoked)", async (_label, tenant) => {
    const repo = new DeviceRepository(lookupPool(true).pool, domainPool(tenant).pool);
    expect(await repo.findActiveById(DEVICE_ID)).toBeNull();
  });

  it("findActiveById: revoked or unknown device → null without reading the tenant", async () => {
    const domain = domainPool(ACTIVE);
    const repo = new DeviceRepository(lookupPool(false).pool, domain.pool);
    expect(await repo.findActiveById(DEVICE_ID)).toBeNull();
    expect(domain.connect).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// RT-365 / RT-369 — the 0040 columns device auth may name
// ===========================================================================

describe("DeviceRepository — the device lookup names only the 0040 columns it needs (RT-365 / RT-369)", () => {
  // The 0040 lifecycle columns `packages/db` declares. RT-365 kept the auth
  // lookup off all of them so it survived a database without 0040. RT-369's
  // rotation overlap needs two of them in the attestation lookup's predicate
  // (0040 is a prerequisite since RT-365 shipped); every other lifecycle
  // column stays out, and the select list is unchanged.
  const LIFECYCLE_COLUMNS =
    /\b(expires_at|last_seen_at|revoked_by|revoke_reason|revoke_note|previous_token_hash|previous_valid_until|retired_at|retired_by|retire_reason)\b/g;
  const OVERLAP_COLUMNS = ["previous_token_hash", "previous_valid_until"];

  async function lookupSql(lookup: (repo: DeviceRepository) => Promise<unknown>): Promise<string> {
    const { pool, query } = lookupPool(false);
    await lookup(new DeviceRepository(pool, pool));
    return (query.mock.calls as Array<[{ text?: string } | string]>)
      .map(([config]) => (typeof config === "string" ? config : (config.text ?? "")))
      .join("\n");
  }

  it("findActiveById names no lifecycle column", async () => {
    const sql = await lookupSql((repo) => repo.findActiveById(DEVICE_ID));
    expect(sql).toMatch(/\bfrom "devices"/i);
    expect(sql.match(LIFECYCLE_COLUMNS)).toBeNull();
  });

  it("findActiveByAttestation selects no lifecycle column and filters only on the overlap pair", async () => {
    const sql = await lookupSql((repo) => repo.findActiveByAttestation("raw-token"));
    const [selectList, rest] = sql.split(/\bfrom "devices"/i);
    expect(rest).toBeDefined();
    expect(selectList!.match(LIFECYCLE_COLUMNS)).toBeNull();
    expect([...new Set(rest!.match(LIFECYCLE_COLUMNS))].sort()).toEqual(OVERLAP_COLUMNS);
  });
});

// ===========================================================================
// RT-370 — the expiry flag and the activity write
// ===========================================================================

describe("DeviceRepository — DEVICE_TOKEN_EXPIRY_ENFORCED (RT-370)", () => {
  const FLAG = "DEVICE_TOKEN_EXPIRY_ENFORCED";
  const saved = process.env[FLAG];
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  async function whereClause(lookup: (repo: DeviceRepository) => Promise<unknown>): Promise<string> {
    const { pool, query } = lookupPool(false);
    await lookup(new DeviceRepository(pool, pool));
    const sql = (query.mock.calls as Array<[{ text?: string } | string]>)
      .map(([config]) => (typeof config === "string" ? config : (config.text ?? "")))
      .join("\n");
    const [selectList, rest] = sql.split(/\bfrom "devices"/i);
    expect(selectList!).not.toMatch(/expires_at/);
    return rest!;
  }

  it.each([
    ["findActiveByAttestation", (repo: DeviceRepository) => repo.findActiveByAttestation("raw-token")],
    ["findActiveById", (repo: DeviceRepository) => repo.findActiveById(DEVICE_ID)],
  ])("%s: flag off (unset) → the lookup does not read expires_at", async (_label, lookup) => {
    delete process.env[FLAG];
    expect(await whereClause(lookup)).not.toMatch(/expires_at/);
  });

  it.each([
    ["findActiveByAttestation", (repo: DeviceRepository) => repo.findActiveByAttestation("raw-token")],
    ["findActiveById", (repo: DeviceRepository) => repo.findActiveById(DEVICE_ID)],
  ])("%s: flag on → the lookup requires expires_at > now() (database clock)", async (_label, lookup) => {
    process.env[FLAG] = "true";
    expect(await whereClause(lookup)).toMatch(/"devices"\."expires_at" > now\(\)/);
  });

  it("flag on: findForRotation (the rotate-only grace) still matches any expiry", async () => {
    process.env[FLAG] = "true";
    const query = jest.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as Pool;
    await new DeviceRepository(pool, pool).findForRotation("raw-token");
    const [sql] = query.mock.calls[0] as unknown as [string];
    expect(sql).not.toMatch(/expires_at\s*>/);
  });
});

describe("DeviceRepository — activity write (RT-370)", () => {
  beforeEach(() => deviceActivity.reset());
  afterEach(async () => {
    await deviceActivity.flush();
    deviceActivity.reset();
  });

  const touched = (queries: string[]): number => queries.filter((q) => /\bupdate\s+devices\b/i.test(q)).length;

  it("an authenticated device is recorded once, on the domain pool, however often it authenticates", async () => {
    const domain = domainPool(ACTIVE);
    const repo = new DeviceRepository(lookupPool(true).pool, domain.pool);
    await repo.findActiveByAttestation("device-token");
    await repo.findActiveByAttestation("device-token");
    await repo.findActiveById(DEVICE_ID);
    await deviceActivity.flush();
    expect(touched(domain.queries)).toBe(1);
  });

  it("an unknown or revoked device, or one of an inactive tenant, is not recorded", async () => {
    const none = domainPool(ACTIVE);
    await new DeviceRepository(lookupPool(false).pool, none.pool).findActiveByAttestation("device-token");
    const suspended = domainPool(SUSPENDED);
    await new DeviceRepository(lookupPool(true).pool, suspended.pool).findActiveByAttestation("device-token");
    await deviceActivity.flush();
    expect(touched(none.queries)).toBe(0);
    expect(touched(suspended.queries)).toBe(0);
  });

  it("a failing activity write does not change the lookup's result", async () => {
    const lookup = lookupPool(true);
    let calls = 0;
    const domain = {
      connect: jest.fn(async () => {
        calls += 1;
        // First connect: the tenant-status read succeeds; second: the activity write's connection fails.
        if (calls > 1) throw new Error("connection refused");
        return {
          query: jest.fn(async (text: string) =>
            /\bfrom\s+tenants\b/i.test(text) ? { rows: [ACTIVE] } : { rows: [] },
          ),
          release: jest.fn(),
        };
      }),
    } as unknown as Pool;
    const row = await new DeviceRepository(lookup.pool, domain).findActiveByAttestation("device-token");
    expect(row?.id).toBe(DEVICE_ID);
    await expect(deviceActivity.flush()).resolves.toBeUndefined();
  });

  it("recordActivity (the rotation guard's path) records through the same throttle", async () => {
    const domain = domainPool(ACTIVE);
    const repo = new DeviceRepository(lookupPool(true).pool, domain.pool);
    repo.recordActivity({ id: DEVICE_ID, tenantId: TENANT_ID });
    await repo.findActiveById(DEVICE_ID);
    await deviceActivity.flush();
    expect(touched(domain.queries)).toBe(1);
  });
});

// ===========================================================================
// RT-639 — the lookup the rotate-soon hint reads
// ===========================================================================

describe("DeviceRepository.findActiveByAttestationWithExpiry (RT-639)", () => {
  const FLAG = "DEVICE_TOKEN_EXPIRY_ENFORCED";
  const EXPIRES = "2027-01-09T00:00:00.000Z";
  const saved = process.env[FLAG];
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  /** Pre-tenant lookup pool answering with the select list plus `expires_at`. */
  function expiryPool(found: boolean): { pool: Pool; query: jest.Mock } {
    const query = jest.fn(async (config: { rowMode?: string }) => {
      if (found && config && config.rowMode === "array") {
        return {
          rows: [
            [DEVICE_ID, TENANT_ID, STORE_ID, "Lane 1", Buffer.from("hash"), null,
             "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", EXPIRES],
          ],
        };
      }
      return { rows: [] };
    });
    return { pool: { query } as unknown as Pool, query };
  }

  async function lookupSql(): Promise<string> {
    const { pool, query } = expiryPool(false);
    await new DeviceRepository(pool, pool).findActiveByAttestationWithExpiry("raw-token");
    return (query.mock.calls as Array<[{ text?: string } | string]>)
      .map(([config]) => (typeof config === "string" ? config : (config.text ?? "")))
      .join("\n");
  }

  it("returns the device with its expiry when the tenant is active", async () => {
    const repo = new DeviceRepository(expiryPool(true).pool, domainPool(ACTIVE).pool);
    const row = await repo.findActiveByAttestationWithExpiry("device-token");

    expect(row?.id).toBe(DEVICE_ID);
    expect(row?.tenantId).toBe(TENANT_ID);
    expect(row?.expiresAt).toEqual(new Date(EXPIRES));
  });

  it("an empty attestation is null without querying the DB", async () => {
    const { pool, query } = expiryPool(true);
    expect(await new DeviceRepository(pool, pool).findActiveByAttestationWithExpiry("")).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ["suspended", SUSPENDED],
    ["soft-deleted", DELETED],
    ["not visible", null],
  ])("a %s tenant → null (as if revoked)", async (_label, tenant) => {
    const repo = new DeviceRepository(expiryPool(true).pool, domainPool(tenant).pool);
    expect(await repo.findActiveByAttestationWithExpiry("device-token")).toBeNull();
  });

  it("no active device → null without reading the tenant", async () => {
    const domain = domainPool(ACTIVE);
    const repo = new DeviceRepository(expiryPool(false).pool, domain.pool);
    expect(await repo.findActiveByAttestationWithExpiry("device-token")).toBeNull();
    expect(domain.connect).not.toHaveBeenCalled();
  });

  it("selects expires_at, in the same single query as the device", async () => {
    const sql = await lookupSql();
    const [selectList] = sql.split(/\bfrom "devices"/i);
    expect(selectList).toMatch(/"expires_at"/);
  });

  it("flag off → expires_at is selected but never filtered on", async () => {
    delete process.env[FLAG];
    const [, rest] = (await lookupSql()).split(/\bfrom "devices"/i);
    expect(rest).not.toMatch(/expires_at/);
  });

  it("flag on → expires_at > now() (database clock) is required, as on every device lookup", async () => {
    process.env[FLAG] = "true";
    const [, rest] = (await lookupSql()).split(/\bfrom "devices"/i);
    expect(rest).toMatch(/"devices"\."expires_at" > now\(\)/);
  });
});
