/**
 * RT-143 — the worker refuses a superuser / BYPASSRLS DATABASE_URL role at
 * boot in production, and stays out of the way on the no-DB path.
 */
import type { Pool } from "pg";

import { verifyWorkerDatabaseRole } from "../src/database-role-verifier";
import { AuditDbPool, WorkerDatabaseRoleVerifier } from "../src/worker.module";

function fakePool(row: { is_superuser: boolean; bypass_rls: boolean } | null): Pool {
  const query = jest.fn(async () => ({
    rows: row === null ? [] : [{ role_name: "app_runtime", ...row }],
  }));
  return { query } as unknown as Pool;
}

const ORIGINAL_NODE_ENV = process.env["NODE_ENV"];
const ORIGINAL_VERIFY = process.env["VERIFY_DATABASE_POOL_BOUNDARY"];

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = ORIGINAL_NODE_ENV;
  if (ORIGINAL_VERIFY === undefined) delete process.env["VERIFY_DATABASE_POOL_BOUNDARY"];
  else process.env["VERIFY_DATABASE_POOL_BOUNDARY"] = ORIGINAL_VERIFY;
});

describe("verifyWorkerDatabaseRole", () => {
  it("accepts a non-superuser, NOBYPASSRLS role", async () => {
    await expect(
      verifyWorkerDatabaseRole(fakePool({ is_superuser: false, bypass_rls: false })),
    ).resolves.toBeUndefined();
  });

  it("rejects a superuser role", async () => {
    await expect(
      verifyWorkerDatabaseRole(fakePool({ is_superuser: true, bypass_rls: false })),
    ).rejects.toThrow(/must be non-superuser and must not have BYPASSRLS/);
  });

  it("rejects a BYPASSRLS role", async () => {
    await expect(
      verifyWorkerDatabaseRole(fakePool({ is_superuser: false, bypass_rls: true })),
    ).rejects.toThrow(/must be non-superuser and must not have BYPASSRLS/);
  });

  it("rejects when the role cannot be resolved", async () => {
    await expect(verifyWorkerDatabaseRole(fakePool(null))).rejects.toThrow(
      /database role could not be resolved/,
    );
  });
});

describe("WorkerDatabaseRoleVerifier", () => {
  const bypassPool = (): Pool => fakePool({ is_superuser: false, bypass_rls: true });

  it("fails boot in production with a BYPASSRLS role", async () => {
    process.env["NODE_ENV"] = "production";
    const verifier = new WorkerDatabaseRoleVerifier(new AuditDbPool(bypassPool()));
    await expect(verifier.onModuleInit()).rejects.toThrow(/BYPASSRLS/);
  });

  it("runs outside production when VERIFY_DATABASE_POOL_BOUNDARY=1", async () => {
    process.env["NODE_ENV"] = "test";
    process.env["VERIFY_DATABASE_POOL_BOUNDARY"] = "1";
    const verifier = new WorkerDatabaseRoleVerifier(new AuditDbPool(bypassPool()));
    await expect(verifier.onModuleInit()).rejects.toThrow(/BYPASSRLS/);
  });

  it("does not query outside production without the opt-in", async () => {
    process.env["NODE_ENV"] = "test";
    delete process.env["VERIFY_DATABASE_POOL_BOUNDARY"];
    const pool = bypassPool();
    await new WorkerDatabaseRoleVerifier(new AuditDbPool(pool)).onModuleInit();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("skips the no-DB path (pool is null)", async () => {
    process.env["NODE_ENV"] = "production";
    await expect(
      new WorkerDatabaseRoleVerifier(new AuditDbPool(null)).onModuleInit(),
    ).resolves.toBeUndefined();
  });
});
