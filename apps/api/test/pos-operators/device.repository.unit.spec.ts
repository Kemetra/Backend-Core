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
