/**
 * Docker-free unit tests for `withTenant`.
 *
 * Covers: UUID validation (non-string inputs), tenants.update id-guard,
 * and write-refusal guards for all 9 tenant-scoped table namespaces.
 *
 * NOT covered here (deferred to the integration suite in with-tenant.spec.ts):
 *   - Row-isolation correctness — requires real Postgres + RLS.
 *   - SQL predicate structure via .toSQL() — the integration suite owns this;
 *     asserting raw SQL fragments here would be fragile and add no behavioral value.
 *   - refuseTenantMismatch's `allowNull: true` branch — not reachable through
 *     any current withTenant call site; no public path exercises it.
 *
 * EXPLICIT EXCLUSION: RLS enforcement is NOT verified by these unit tests.
 * Unit mocks cannot substitute for PostgreSQL Row-Level Security. RLS isolation
 * is the responsibility of the integration suite and the DB migration tests.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { TENANT_SCOPED_TABLES, withTenant } from "../../src/helpers/with-tenant";

const TENANT_A = "0a000000-0000-7000-8000-00000000a001";
const TENANT_B = "0b000000-0000-7000-8000-00000000b001";

// Minimal stub pool — withTenant only needs a NodePgDatabase instance to
// construct query builders. The pool is never connected for synchronous guard paths.
const fakePool = { query: jest.fn(), connect: jest.fn() } as unknown as Pool;
const db = drizzle(fakePool) as unknown as NodePgDatabase;

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("withTenant — input validation (unit)", () => {
  it("WT-U1: throws on non-UUID string", () => {
    expect(() => withTenant(db, "not-a-uuid")).toThrow(/UUID/i);
  });

  it("WT-U2: throws on empty string", () => {
    expect(() => withTenant(db, "")).toThrow(/UUID/i);
  });

  it("WT-U3: throws on null passed as tenantId", () => {
    expect(() => withTenant(db, null as unknown as string)).toThrow(/UUID/i);
  });

  it("WT-U4: throws on number passed as tenantId", () => {
    expect(() => withTenant(db, 42 as unknown as string)).toThrow(/UUID/i);
  });

  it("WT-U5: returns object with bound tenantId", () => {
    const wt = withTenant(db, TENANT_A);
    expect(wt.tenantId).toBe(TENANT_A);
  });
});

// ---------------------------------------------------------------------------
// tenants namespace — id-guard on update
// ---------------------------------------------------------------------------

describe("withTenant — tenants.update id-guard (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U6: throws when set.id is defined and differs from bound tenantId", () => {
    expect(() => wt.tenants.update({ id: TENANT_B })).toThrow(
      /refusing tenants update that changes id/i,
    );
  });

  it("WT-U7: does NOT throw when set.id equals the bound tenantId", () => {
    expect(() => wt.tenants.update({ id: TENANT_A })).not.toThrow();
  });

  it("WT-U8: does NOT throw when set.id is undefined", () => {
    expect(() => wt.tenants.update({ name: "renamed" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// stores — insert/update guards
// ---------------------------------------------------------------------------

describe("withTenant — stores write refusal (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U9: stores.insert throws on tenant_id mismatch", () => {
    expect(() =>
      wt.stores.insert({
        id: "0a000000-0000-7000-8000-0000000000ff",
        tenantId: TENANT_B,
        code: "X1",
        name: "Cross-tenant store",
      }),
    ).toThrow(/tenant_id/i);
  });

  it("WT-U10: stores.update throws on tenant_id reassignment", () => {
    expect(() => wt.stores.update({ tenantId: TENANT_B })).toThrow(
      /tenant_id/i,
    );
  });

  it("WT-U10d: insert refusal names the offending tenant_id, string or not", () => {
    const insertWith = (tenantId: unknown) => () =>
      wt.stores.insert({
        id: "0a000000-0000-7000-8000-0000000000ff",
        tenantId: tenantId as string,
        code: "X1",
        name: "Cross-tenant store",
      });
    expect(insertWith(TENANT_B)).toThrow(`got ${TENANT_B})`);
    expect(insertWith({ id: TENANT_B })).toThrow(`got {"id":"${TENANT_B}"})`);
  });
});

// ---------------------------------------------------------------------------
// stores — insert/update guard pass-through (matching tenant)
// ---------------------------------------------------------------------------

describe("withTenant — stores insert/update pass-through (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U9b: stores.insert does NOT throw when tenant_id matches", () => {
    expect(() =>
      wt.stores.insert({
        id: "0a000000-0000-7000-8000-0000000000f1",
        tenantId: TENANT_A,
        code: "A1",
        name: "Store A1",
      }),
    ).not.toThrow();
  });

  it("WT-U10b: stores.update does NOT throw when set.tenantId matches", () => {
    expect(() => wt.stores.update({ tenantId: TENANT_A })).not.toThrow();
  });

  it("WT-U10c: stores.update does NOT throw when set.tenantId is undefined", () => {
    expect(() => wt.stores.update({ name: "renamed" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// storeAccess — insert guard
// ---------------------------------------------------------------------------

describe("withTenant — storeAccess write refusal (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U11: storeAccess.insert throws on tenant_id mismatch", () => {
    expect(() =>
      wt.storeAccess.insert({
        membershipId: "0a000000-0000-7000-8000-0000000001ff",
        tenantId: TENANT_B,
        storeId: "0a000000-0000-7000-8000-0000000003ff",
      }),
    ).toThrow(/tenant_id/i);
  });
});

// ---------------------------------------------------------------------------
// storeAccess — insert pass-through
// ---------------------------------------------------------------------------

describe("withTenant — storeAccess insert pass-through (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U11b: storeAccess.insert does NOT throw when tenant_id matches", () => {
    expect(() =>
      wt.storeAccess.insert({
        membershipId: "0a000000-0000-7000-8000-0000000001f1",
        tenantId: TENANT_A,
        storeId: "0a000000-0000-7000-8000-0000000003f1",
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// memberships — insert/update guards
// ---------------------------------------------------------------------------

describe("withTenant — memberships write refusal (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U12: memberships.insert throws on tenant_id mismatch", () => {
    expect(() =>
      wt.memberships.insert({
        id: "0a000000-0000-7000-8000-0000000010ff",
        tenantId: TENANT_B,
        userId: "0a000000-0000-7000-8000-0000000020ff",
        roleId: "0a000000-0000-7000-8000-0000000030ff",
        storeAccessKind: "all",
      }),
    ).toThrow(/tenant_id/i);
  });

  it("WT-U13: memberships.update throws on tenant_id reassignment", () => {
    expect(() => wt.memberships.update({ tenantId: TENANT_B })).toThrow(
      /tenant_id/i,
    );
  });
});

// ---------------------------------------------------------------------------
// memberships — insert/update pass-through
// ---------------------------------------------------------------------------

describe("withTenant — memberships insert/update pass-through (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U12b: memberships.insert does NOT throw when tenant_id matches", () => {
    expect(() =>
      wt.memberships.insert({
        id: "0a000000-0000-7000-8000-0000000010f1",
        tenantId: TENANT_A,
        userId: "0a000000-0000-7000-8000-0000000020f1",
        roleId: "0a000000-0000-7000-8000-0000000030f1",
        storeAccessKind: "all",
      }),
    ).not.toThrow();
  });

  it("WT-U13b: memberships.update does NOT throw when set.tenantId matches", () => {
    expect(() => wt.memberships.update({ tenantId: TENANT_A })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// roles — insert/update guards (including platform-scope null refusal)
// ---------------------------------------------------------------------------

describe("withTenant — roles write refusal (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U14: roles.insert refuses null tenant_id (platform-scope path)", () => {
    expect(() =>
      wt.roles.insert({
        id: "0a000000-0000-7000-8000-0000000040ff",
        tenantId: null,
        code: "platform_admin",
        name: "Platform Admin",
      }),
    ).toThrow(/tenant_id/i);
  });

  it("WT-U15: roles.insert refuses mismatched tenant_id", () => {
    expect(() =>
      wt.roles.insert({
        id: "0a000000-0000-7000-8000-0000000041ff",
        tenantId: TENANT_B,
        code: "manager",
        name: "Manager",
      }),
    ).toThrow(/tenant_id/i);
  });

  it("WT-U16: roles.update throws when set.tenantId is null", () => {
    expect(() => wt.roles.update({ tenantId: null })).toThrow(/tenant_id/i);
  });

  it("WT-U17: roles.update throws when set.tenantId is a different tenant", () => {
    expect(() => wt.roles.update({ tenantId: TENANT_B })).toThrow(/tenant_id/i);
  });
});

// ---------------------------------------------------------------------------
// roles — insert/update pass-through
// ---------------------------------------------------------------------------

describe("withTenant — roles insert/update pass-through (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U15b: roles.insert does NOT throw when tenant_id matches", () => {
    expect(() =>
      wt.roles.insert({
        id: "0a000000-0000-7000-8000-0000000042ff",
        tenantId: TENANT_A,
        code: "manager",
        name: "Manager",
      }),
    ).not.toThrow();
  });

  it("WT-U16b: roles.update does NOT throw when set.tenantId equals bound tenant", () => {
    expect(() => wt.roles.update({ tenantId: TENANT_A })).not.toThrow();
  });

  it("WT-U16c: roles.update does NOT throw when set.tenantId is undefined", () => {
    expect(() => wt.roles.update({ name: "renamed" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// authTokens — insert/update guards
// ---------------------------------------------------------------------------

describe("withTenant — authTokens write refusal (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U18: authTokens.insert throws on tenant_id mismatch", () => {
    expect(() =>
      wt.authTokens.insert({
        id: "0a000000-0000-7000-8000-0000000050ff",
        tenantId: TENANT_B,
        tokenHash: Buffer.from("hash"),
        scope: "dashboard_api",
        expiresAt: new Date(),
      }),
    ).toThrow(/tenant_id/i);
  });

  it("WT-U19: authTokens.update throws on tenant_id reassignment", () => {
    expect(() => wt.authTokens.update({ tenantId: TENANT_B })).toThrow(
      /tenant_id/i,
    );
  });
});

// ---------------------------------------------------------------------------
// authTokens — insert/update pass-through
// ---------------------------------------------------------------------------

describe("withTenant — authTokens insert/update pass-through (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U18b: authTokens.insert does NOT throw when tenant_id matches", () => {
    expect(() =>
      wt.authTokens.insert({
        id: "0a000000-0000-7000-8000-0000000050f1",
        tenantId: TENANT_A,
        tokenHash: Buffer.from("hash"),
        scope: "dashboard_api",
        expiresAt: new Date(),
      }),
    ).not.toThrow();
  });

  it("WT-U19b: authTokens.update does NOT throw when set.tenantId matches", () => {
    expect(() => wt.authTokens.update({ tenantId: TENANT_A })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// invitations — insert/update guards
// ---------------------------------------------------------------------------

describe("withTenant — invitations write refusal (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U20: invitations.insert throws on tenant_id mismatch", () => {
    expect(() =>
      wt.invitations.insert({
        id: "0a000000-0000-7000-8000-0000000070ff",
        tenantId: TENANT_B,
        email: "x@example.com",
        roleId: "0a000000-0000-7000-8000-0000000080ff",
        invitedByUserId: "0a000000-0000-7000-8000-0000000090ff",
        storeAccessKind: "all",
        tokenHash: Buffer.from("tok"),
        expiresAt: new Date(),
      }),
    ).toThrow(/tenant_id/i);
  });

  it("WT-U21: invitations.update throws on tenant_id reassignment", () => {
    expect(() => wt.invitations.update({ tenantId: TENANT_B })).toThrow(
      /tenant_id/i,
    );
  });
});

// ---------------------------------------------------------------------------
// invitations — insert/update pass-through
// ---------------------------------------------------------------------------

describe("withTenant — invitations insert/update pass-through (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U20b: invitations.insert does NOT throw when tenant_id matches", () => {
    expect(() =>
      wt.invitations.insert({
        id: "0a000000-0000-7000-8000-0000000070f1",
        tenantId: TENANT_A,
        email: "ok@example.com",
        roleId: "0a000000-0000-7000-8000-0000000080f1",
        invitedByUserId: "0a000000-0000-7000-8000-0000000090f1",
        storeAccessKind: "all",
        tokenHash: Buffer.from("tok"),
        expiresAt: new Date(),
      }),
    ).not.toThrow();
  });

  it("WT-U21b: invitations.update does NOT throw when set.tenantId matches", () => {
    expect(() => wt.invitations.update({ tenantId: TENANT_A })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// auditEvents — null tenant guard
// ---------------------------------------------------------------------------

describe("withTenant — auditEvents write refusal (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U22: auditEvents.insert throws on null tenant_id", () => {
    expect(() =>
      wt.auditEvents.insert({
        id: "0a000000-0000-7000-8000-0000000000a1",
        tenantId: null,
        action: "platform.event",
      }),
    ).toThrow(/tenant_id/i);
  });
});

// ---------------------------------------------------------------------------
// auditEvents — insert pass-through
// ---------------------------------------------------------------------------

describe("withTenant — auditEvents insert pass-through (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U22b: auditEvents.insert does NOT throw when tenant_id matches", () => {
    expect(() =>
      wt.auditEvents.insert({
        id: "0a000000-0000-7000-8000-0000000000a2",
        tenantId: TENANT_A,
        action: "tenant.event",
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// idempotencyKeys — insert guard
// ---------------------------------------------------------------------------

describe("withTenant — idempotencyKeys write refusal (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U23: idempotencyKeys.insert throws on tenant_id mismatch", () => {
    expect(() =>
      wt.idempotencyKeys.insert({
        id: "0a000000-0000-7000-8000-0000000000b1",
        tenantId: TENANT_B,
        clientId: "client-1",
        key: "idem-key-1",
        requestHash: Buffer.from("req"),
        responseStatus: 200,
        responseBody: {},
        expiresAt: new Date(),
      }),
    ).toThrow(/tenant_id/i);
  });
});

// ---------------------------------------------------------------------------
// idempotencyKeys — insert pass-through
// ---------------------------------------------------------------------------

describe("withTenant — idempotencyKeys insert pass-through (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U23b: idempotencyKeys.insert does NOT throw when tenant_id matches", () => {
    expect(() =>
      wt.idempotencyKeys.insert({
        id: "0a000000-0000-7000-8000-0000000000b2",
        tenantId: TENANT_A,
        clientId: "client-1",
        key: "idem-key-2",
        requestHash: Buffer.from("req"),
        responseStatus: 200,
        responseBody: {},
        expiresAt: new Date(),
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helper surface and select/delete reachability
// ---------------------------------------------------------------------------

describe("withTenant — helper surface (unit)", () => {
  const wt = withTenant(db, TENANT_A);

  it("WT-U24: all TENANT_SCOPED_TABLES are reachable and expose a select function", () => {
    const tableToKey: Record<string, keyof typeof wt> = {
      tenants: "tenants",
      stores: "stores",
      memberships: "memberships",
      store_access: "storeAccess",
      roles: "roles",
      auth_tokens: "authTokens",
      invitations: "invitations",
      audit_events: "auditEvents",
      idempotency_keys: "idempotencyKeys",
    };
    for (const tableName of TENANT_SCOPED_TABLES) {
      const key = tableToKey[tableName];
      expect(key).toBeDefined();
      const ns = wt[key!] as { select?: unknown };
      expect(typeof ns.select).toBe("function");
    }
  });

  it("WT-U25: select() on each namespace returns a query builder object (no SQL assertion)", () => {
    // Exercises the select method bodies without asserting SQL structure.
    expect(wt.tenants.select()).toBeDefined();
    expect(wt.stores.select()).toBeDefined();
    expect(wt.memberships.select()).toBeDefined();
    expect(wt.storeAccess.select()).toBeDefined();
    expect(wt.roles.select()).toBeDefined();
    expect(wt.authTokens.select()).toBeDefined();
    expect(wt.invitations.select()).toBeDefined();
    expect(wt.auditEvents.select()).toBeDefined();
    expect(wt.idempotencyKeys.select()).toBeDefined();
  });

  it("WT-U26: delete() on each namespace that exposes delete returns a query builder object", () => {
    expect(wt.stores.delete()).toBeDefined();
    expect(wt.memberships.delete()).toBeDefined();
    expect(wt.storeAccess.delete()).toBeDefined();
    expect(wt.roles.delete()).toBeDefined();
    expect(wt.authTokens.delete()).toBeDefined();
    expect(wt.invitations.delete()).toBeDefined();
    expect(wt.idempotencyKeys.delete()).toBeDefined();
  });

  it("WT-U27: select() with a caller where predicate does not throw (combineWhere with-arg path)", () => {
    // Exercises the combineWhere(scopePredicate, callerWhere) branch where callerWhere is defined.
    // We pass a truthy SQL expression as the where arg — no SQL assertion on output.
    const { eq } = jest.requireActual("drizzle-orm") as typeof import("drizzle-orm");
    const { stores } = jest.requireActual("../../src/schema") as typeof import("../../src/schema");
    const extraWhere = eq(stores.id, "0a000000-0000-7000-8000-0000000000a1");
    expect(wt.stores.select(extraWhere)).toBeDefined();
    expect(wt.tenants.select(extraWhere)).toBeDefined();
  });
});
