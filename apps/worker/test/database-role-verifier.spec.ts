/**
 * RT-143 — the worker refuses a superuser / BYPASSRLS DATABASE_URL role at
 * boot in production, and stays out of the way on the no-DB path.
 *
 * RT-353 — the audit retention sweep has its own role. The domain role must
 * not be able to mark retention, and the retention role must hold exactly
 * SELECT and UPDATE (retention_marked_at) on audit_events.
 */
import type { Pool } from "pg";

import { AuditRetentionDbPool } from "../src/audit/audit-retention-db-pool";
import {
  verifyAuditRetentionRole,
  verifyWorkerDatabaseRole,
} from "../src/database-role-verifier";
import {
  AuditDbPool,
  AuditRetentionRoleVerifier,
  WorkerDatabaseRoleVerifier,
} from "../src/worker.module";

function fakePool(
  row: { is_superuser: boolean; bypass_rls: boolean; can_mark_retention?: boolean } | null,
): Pool {
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

describe("verifyWorkerDatabaseRole — RT-353 retention marker", () => {
  it("rejects a domain role that can UPDATE audit_events.retention_marked_at", async () => {
    await expect(
      verifyWorkerDatabaseRole(
        fakePool({ is_superuser: false, bypass_rls: false, can_mark_retention: true }),
      ),
    ).rejects.toThrow(
      /DATABASE_URL role must not hold UPDATE on audit_events\.retention_marked_at/,
    );
  });
});

const DB_ID = { db_name: "rt", db_oid: "16384", server_started: "2026-10-10 14:00:00+00" };

interface RetentionRow {
  role_name: string;
  session_role: string;
  db_name: string;
  db_oid: string;
  server_started: string;
  is_superuser: boolean;
  bypass_rls: boolean;
  can_select: boolean;
  can_mark: boolean;
  extra_privilege: boolean;
}

const GOOD_RETENTION: RetentionRow = {
  role_name: "audit_retention_worker",
  session_role: "audit_retention_worker",
  ...DB_ID,
  is_superuser: false,
  bypass_rls: false,
  can_select: true,
  can_mark: true,
  extra_privilege: false,
};

function retentionPool(row: RetentionRow | null): Pool {
  const query = jest.fn(async () => ({ rows: row === null ? [] : [row] }));
  return { query } as unknown as Pool;
}

function domainPool(roleName = "app_domain", id: Partial<typeof DB_ID> = {}): Pool {
  const query = jest.fn(async () => ({ rows: [{ role_name: roleName, ...DB_ID, ...id }] }));
  return { query } as unknown as Pool;
}

describe("verifyAuditRetentionRole (RT-353)", () => {
  it("accepts a distinct role holding exactly SELECT + UPDATE (retention_marked_at)", async () => {
    await expect(
      verifyAuditRetentionRole(retentionPool(GOOD_RETENTION), domainPool()),
    ).resolves.toBeUndefined();
  });

  it("rejects when the role cannot be resolved", async () => {
    await expect(verifyAuditRetentionRole(retentionPool(null), domainPool())).rejects.toThrow(
      /AUDIT_RETENTION_DATABASE_URL role could not be resolved/,
    );
  });

  it.each([
    ["a superuser", { is_superuser: true }],
    ["a BYPASSRLS role", { bypass_rls: true }],
  ])("rejects %s", async (_name, patch) => {
    await expect(
      verifyAuditRetentionRole(retentionPool({ ...GOOD_RETENTION, ...patch }), domainPool()),
    ).rejects.toThrow(/must be non-superuser and must not have BYPASSRLS/);
  });

  it("rejects a session that only switched to the role (session_user differs)", async () => {
    await expect(
      verifyAuditRetentionRole(
        retentionPool({ ...GOOD_RETENTION, session_role: "postgres" }),
        domainPool(),
      ),
    ).rejects.toThrow(/must log in as itself/);
  });

  it.each([
    ["another database on the same server", { db_name: "rt_staging", db_oid: "16999" }],
    ["the same database name on another server", { server_started: "2026-10-01 09:00:00+00" }],
  ])("rejects a retention URL pointing at %s", async (_name, id) => {
    await expect(
      verifyAuditRetentionRole(retentionPool(GOOD_RETENTION), domainPool("app_domain", id)),
    ).rejects.toThrow(/must connect to the same database as DATABASE_URL/);
  });

  it("rejects the same role as DATABASE_URL", async () => {
    await expect(
      verifyAuditRetentionRole(
        retentionPool({ ...GOOD_RETENTION, role_name: "app_domain", session_role: "app_domain" }),
        domainPool("app_domain"),
      ),
    ).rejects.toThrow(/must be a different role from DATABASE_URL/);
  });

  it("rejects a role without SELECT on audit_events, naming it", async () => {
    await expect(
      verifyAuditRetentionRole(
        retentionPool({ ...GOOD_RETENTION, can_select: false }),
        domainPool(),
      ),
    ).rejects.toThrow(/is missing required grants: SELECT ON audit_events$/);
  });

  it("rejects a role without UPDATE (retention_marked_at), naming it", async () => {
    await expect(
      verifyAuditRetentionRole(retentionPool({ ...GOOD_RETENTION, can_mark: false }), domainPool()),
    ).rejects.toThrow(/is missing required grants: UPDATE \(retention_marked_at\) ON audit_events$/);
  });

  it("rejects a role holding any other privilege on audit_events", async () => {
    await expect(
      verifyAuditRetentionRole(
        retentionPool({ ...GOOD_RETENTION, extra_privilege: true }),
        domainPool(),
      ),
    ).rejects.toThrow(
      /may hold only SELECT and UPDATE \(retention_marked_at\) on audit_events, and no role membership/,
    );
  });
});

describe("AuditRetentionRoleVerifier (RT-353)", () => {
  const badRetention = (): Pool => retentionPool({ ...GOOD_RETENTION, can_mark: false });

  it("fails boot in production when the retention role lacks its grant", async () => {
    process.env["NODE_ENV"] = "production";
    const verifier = new AuditRetentionRoleVerifier(
      new AuditDbPool(domainPool()),
      new AuditRetentionDbPool(badRetention(), true),
    );
    await expect(verifier.onModuleInit()).rejects.toThrow(/UPDATE \(retention_marked_at\)/);
  });

  it("runs outside production when VERIFY_DATABASE_POOL_BOUNDARY=1", async () => {
    process.env["NODE_ENV"] = "test";
    process.env["VERIFY_DATABASE_POOL_BOUNDARY"] = "1";
    const verifier = new AuditRetentionRoleVerifier(
      new AuditDbPool(domainPool()),
      new AuditRetentionDbPool(badRetention(), true),
    );
    await expect(verifier.onModuleInit()).rejects.toThrow(/UPDATE \(retention_marked_at\)/);
  });

  it("names the missing URL when the sweep borrows the domain pool under the opt-in", async () => {
    process.env["NODE_ENV"] = "test";
    process.env["VERIFY_DATABASE_POOL_BOUNDARY"] = "1";
    const domain = domainPool();
    const verifier = new AuditRetentionRoleVerifier(
      new AuditDbPool(domain),
      new AuditRetentionDbPool(domain, false),
    );
    await expect(verifier.onModuleInit()).rejects.toThrow(
      /AUDIT_RETENTION_DATABASE_URL is not set/,
    );
  });

  it("does not query outside production without the opt-in", async () => {
    process.env["NODE_ENV"] = "test";
    delete process.env["VERIFY_DATABASE_POOL_BOUNDARY"];
    const pool = badRetention();
    await new AuditRetentionRoleVerifier(
      new AuditDbPool(domainPool()),
      new AuditRetentionDbPool(pool, true),
    ).onModuleInit();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("skips the no-DB path", async () => {
    process.env["NODE_ENV"] = "production";
    await expect(
      new AuditRetentionRoleVerifier(
        new AuditDbPool(null),
        new AuditRetentionDbPool(null, false),
      ).onModuleInit(),
    ).resolves.toBeUndefined();
  });
});
