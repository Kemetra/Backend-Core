import type { Pool } from "pg";

import {
  AUTH_LOOKUP_FORBIDDEN_GRANTS,
  AUTH_LOOKUP_REQUIRED_GRANTS,
  authLookupPoolFactory,
  verifyDatabasePoolBoundary,
} from "../../src/auth/database-pools";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/**
 * RT-212: the domain role's required grants, written out here rather than
 * imported so the test states the expected set independently of the code.
 */
const DOMAIN_GRANTS: ReadonlySet<string> = new Set([
  "cashier_admissions:SELECT",
  "cashier_admissions:INSERT",
  "cashier_admissions:UPDATE",
  "cashier_admission_requests:SELECT",
  "cashier_admission_requests:INSERT",
  "cashier_admission_requests:UPDATE",
  "cashier_admission_requests:DELETE",
]);

const LOOKUP_GRANTS: ReadonlySet<string> = new Set(
  AUTH_LOOKUP_REQUIRED_GRANTS.map(([t, p]) => `${t}:${p}`),
);

function rolePool(input: {
  roleName: string;
  superuser?: boolean;
  bypassRls?: boolean;
  /**
   * "table:PRIVILEGE" keys the role holds, one privilege per key. Default:
   * exactly the domain set for a non-BYPASSRLS role and exactly the lookup
   * set for a BYPASSRLS one.
   */
  grants?: ReadonlySet<string>;
}): Pool {
  const grants = input.grants ?? (input.bypassRls ? LOOKUP_GRANTS : DOMAIN_GRANTS);
  return {
    query: jest.fn(async (sql: string, params?: [string[], string[]]) => {
      if (sql.includes("has_table_privilege")) {
        const [tables, privileges] = params!;
        // Mirrors has_table_privilege: a comma-separated list is true when
        // ANY listed privilege is held.
        return {
          rows: tables.map((table_name, i) => ({
            table_name,
            privilege: privileges[i],
            granted: privileges[i]!
              .split(",")
              .some((p) => grants.has(`${table_name}:${p.trim()}`)),
          })),
        };
      }
      return {
        rows: [
          {
            role_name: input.roleName,
            is_superuser: input.superuser ?? false,
            bypass_rls: input.bypassRls ?? false,
          },
        ],
      };
    }),
  } as unknown as Pool;
}

describe("database pool boundary", () => {
  it("fails closed when the production lookup credential is missing", () => {
    process.env["NODE_ENV"] = "production";
    process.env["DATABASE_URL"] = "postgres://domain/runtime";
    delete process.env["AUTH_LOOKUP_DATABASE_URL"];

    expect(() => authLookupPoolFactory({} as Pool)).toThrow(
      /AUTH_LOOKUP_DATABASE_URL is required in production/,
    );
  });

  it("rejects reusing the domain credential for production bootstrap lookups", () => {
    process.env["NODE_ENV"] = "production";
    process.env["DATABASE_URL"] = "postgres://shared/runtime";
    process.env["AUTH_LOOKUP_DATABASE_URL"] = "postgres://shared/runtime";

    expect(() => authLookupPoolFactory({} as Pool)).toThrow(
      /must use credentials distinct from DATABASE_URL/,
    );
  });

  it("accepts a non-BYPASSRLS domain role and a distinct bootstrap BYPASSRLS role", async () => {
    await expect(
      verifyDatabasePoolBoundary(
        rolePool({ roleName: "app_domain" }),
        rolePool({ roleName: "app_auth_lookup", bypassRls: true }),
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    {
      name: "domain superuser",
      domain: { roleName: "app_domain", superuser: true },
      lookup: { roleName: "app_auth_lookup", bypassRls: true },
      message: /DATABASE_URL role must be non-superuser/,
    },
    {
      name: "domain BYPASSRLS",
      domain: { roleName: "app_domain", bypassRls: true },
      lookup: { roleName: "app_auth_lookup", bypassRls: true },
      message: /must not have BYPASSRLS/,
    },
    {
      name: "lookup superuser",
      domain: { roleName: "app_domain" },
      lookup: { roleName: "app_auth_lookup", superuser: true, bypassRls: true },
      message: /must not be a superuser/,
    },
    {
      name: "lookup without BYPASSRLS",
      domain: { roleName: "app_domain" },
      lookup: { roleName: "app_auth_lookup" },
      message: /must have BYPASSRLS/,
    },
    {
      name: "shared role",
      domain: { roleName: "app_shared" },
      lookup: { roleName: "app_shared", bypassRls: true },
      message: /must use distinct database roles/,
    },
  ])("rejects $name", async ({ domain, lookup, message }) => {
    await expect(
      verifyDatabasePoolBoundary(rolePool(domain), rolePool(lookup)),
    ).rejects.toThrow(message);
  });

  // RT-143 — the lookup role's grants are its boundary (it has BYPASSRLS).
  const REQUIRED = LOOKUP_GRANTS;

  it("rejects a lookup role missing a required grant, naming it", async () => {
    const grants = new Set(REQUIRED);
    grants.delete("auth_tokens:INSERT");
    await expect(
      verifyDatabasePoolBoundary(
        rolePool({ roleName: "app_domain" }),
        rolePool({ roleName: "app_auth_lookup", bypassRls: true, grants }),
      ),
    ).rejects.toThrow(/missing required grants: INSERT ON auth_tokens/);
  });

  it.each([
    ["sales", "SELECT"],
    ["sales", "DELETE"],
    ["audit_events", "UPDATE"],
    ["memberships", "INSERT"],
    // RT-113 BC2: cashier admission state and stored replay bodies are
    // tenant data behind FORCE RLS; the BYPASSRLS lookup role must not read them.
    ["cashier_admissions", "SELECT"],
    ["cashier_admission_requests", "SELECT"],
    // RT-212: every table privilege counts, not just SELECT/INSERT/UPDATE/DELETE.
    // TRUNCATE is not subject to row security, so with BYPASSRLS or without
    // it would let the lookup credential empty a tenant table.
    ["sales", "TRUNCATE"],
    ["sales", "REFERENCES"],
    ["sales", "TRIGGER"],
    ["audit_events", "TRUNCATE"],
    ["audit_events", "TRIGGER"],
    ["receivable", "TRUNCATE"],
    ["cashier_admissions", "TRUNCATE"],
    ["cashier_admission_requests", "REFERENCES"],
    ["memberships", "TRUNCATE"],
    ["memberships", "REFERENCES"],
    ["memberships", "TRIGGER"],
    ["store_access", "TRUNCATE"],
    ["store_access", "TRIGGER"],
  ])("rejects a lookup role holding %s %s", async (table, privilege) => {
    const grants = new Set([...REQUIRED, `${table}:${privilege}`]);
    await expect(
      verifyDatabasePoolBoundary(
        rolePool({ roleName: "app_domain" }),
        rolePool({ roleName: "app_auth_lookup", bypassRls: true, grants }),
      ),
    ).rejects.toThrow(new RegExp(`forbidden grants on: ${table}`));
  });

  it("RT-212: forbids every table privilege on each fully forbidden table", () => {
    const ALL = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
    for (const table of ["sales", "receivable", "audit_events", "cashier_admissions"]) {
      const entry = AUTH_LOOKUP_FORBIDDEN_GRANTS.find(([t]) => t === table);
      expect(entry).toBeDefined();
      const listed = entry![1].split(",").map((p) => p.trim());
      expect([...listed].sort()).toEqual([...ALL].sort());
    }
  });

  it("RT-212: forbids every privilege except SELECT on memberships and store_access", () => {
    for (const table of ["memberships", "store_access"]) {
      const entry = AUTH_LOOKUP_FORBIDDEN_GRANTS.find(([t]) => t === table);
      expect(entry).toBeDefined();
      const listed = entry![1].split(",").map((p) => p.trim());
      expect([...listed].sort()).toEqual(
        ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].sort(),
      );
    }
  });

  // RT-212 — the domain role's table grants. Runtime grants are provisioned
  // outside migrations, so a deploy that skips a grant step must not boot.
  it.each([...DOMAIN_GRANTS])(
    "RT-212: rejects a domain role missing %s, naming the table and privilege",
    async (key) => {
      const [table, privilege] = key.split(":");
      const grants = new Set(DOMAIN_GRANTS);
      grants.delete(key);
      await expect(
        verifyDatabasePoolBoundary(
          rolePool({ roleName: "app_domain", grants }),
          rolePool({ roleName: "app_auth_lookup", bypassRls: true }),
        ),
      ).rejects.toThrow(
        new RegExp(`AuthModule: DATABASE_URL role is missing required grants: ${privilege} ON ${table}\\b`),
      );
    },
  );

  it("RT-212: names every missing domain grant in one message", async () => {
    const grants = new Set(DOMAIN_GRANTS);
    grants.delete("cashier_admissions:UPDATE");
    grants.delete("cashier_admission_requests:DELETE");
    await expect(
      verifyDatabasePoolBoundary(
        rolePool({ roleName: "app_domain", grants }),
        rolePool({ roleName: "app_auth_lookup", bypassRls: true }),
      ),
    ).rejects.toThrow(
      /AuthModule: DATABASE_URL role is missing required grants: UPDATE ON cashier_admissions, DELETE ON cashier_admission_requests/,
    );
  });
});
