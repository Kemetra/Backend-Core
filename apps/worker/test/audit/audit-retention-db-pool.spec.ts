/**
 * RT-353 — the audit retention sweep connects with its own credential
 * (AUDIT_RETENTION_DATABASE_URL, the `audit_retention_worker` role), not the
 * domain role. Production refuses to boot without it; dev and test fall back
 * to the domain pool, which the wrapper then must not close.
 */
import type { Pool } from "pg";

import {
  AuditRetentionDbPool,
  auditRetentionPoolProviderFactory,
} from "../../src/audit/audit-retention-db-pool";

const FAKE_RETENTION_URL = "postgres://retention:retention@127.0.0.1:1/fake";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function fakePool(): Pool {
  return { end: jest.fn(async () => undefined) } as unknown as Pool;
}

describe("auditRetentionPoolProviderFactory", () => {
  it("throws in production when AUDIT_RETENTION_DATABASE_URL is missing", () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["AUDIT_RETENTION_DATABASE_URL"];

    expect(() => auditRetentionPoolProviderFactory(fakePool())).toThrow(
      /AUDIT_RETENTION_DATABASE_URL is required in production/,
    );
  });

  it("borrows the domain pool outside production when the URL is missing", () => {
    process.env["NODE_ENV"] = "test";
    delete process.env["AUDIT_RETENTION_DATABASE_URL"];
    const domain = fakePool();

    expect(auditRetentionPoolProviderFactory(domain).pool).toBe(domain);
  });

  it("stays on the no-DB path when neither pool exists", () => {
    process.env["NODE_ENV"] = "test";
    delete process.env["AUDIT_RETENTION_DATABASE_URL"];

    expect(auditRetentionPoolProviderFactory(null).pool).toBeNull();
  });

  it("opens its own pool from AUDIT_RETENTION_DATABASE_URL", async () => {
    process.env["NODE_ENV"] = "production";
    process.env["AUDIT_RETENTION_DATABASE_URL"] = FAKE_RETENTION_URL;
    const domain = fakePool();

    const wrapper = auditRetentionPoolProviderFactory(domain);
    expect(wrapper.pool).not.toBeNull();
    expect(wrapper.pool).not.toBe(domain);
    await wrapper.onModuleDestroy(); // never connected, so end() resolves at once
  });
});

describe("AuditRetentionDbPool — lifecycle", () => {
  it("ends an owned pool exactly once", async () => {
    const pool = fakePool();
    const wrapper = new AuditRetentionDbPool(pool, true);

    await wrapper.onModuleDestroy();
    await wrapper.onModuleDestroy();
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(wrapper.pool).toBeNull();
  });

  it("never ends a borrowed domain pool (AuditDbPool owns it)", async () => {
    const pool = fakePool();
    const wrapper = new AuditRetentionDbPool(pool, false);

    await wrapper.onModuleDestroy();
    expect(pool.end).not.toHaveBeenCalled();
  });

  it("is a no-op on the no-DB path", async () => {
    await expect(new AuditRetentionDbPool(null, false).onModuleDestroy()).resolves.toBeUndefined();
  });
});
