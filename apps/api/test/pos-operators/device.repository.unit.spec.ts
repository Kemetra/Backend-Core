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
