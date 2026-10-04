import type { Pool } from "pg";

import {
  AUTH_LOOKUP_REQUIRED_GRANTS,
  authLookupPoolFactory,
  verifyDatabasePoolBoundary,
} from "../../src/auth/database-pools";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function rolePool(input: {
  roleName: string;
  superuser?: boolean;
  bypassRls?: boolean;
  /** RT-143: "table:privilege" keys reported as granted (default: exactly the required set). */
  grants?: ReadonlySet<string>;
}): Pool {
  const grants =
    input.grants ?? new Set(AUTH_LOOKUP_REQUIRED_GRANTS.map(([t, p]) => `${t}:${p}`));
  return {
    query: jest.fn(async (sql: string, params?: [string[], string[]]) => {
      if (sql.includes("has_table_privilege")) {
        const [tables, privileges] = params!;
        return {
          rows: tables.map((table_name, i) => ({
            table_name,
            privilege: privileges[i],
            granted: grants.has(`${table_name}:${privileges[i]}`),
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
  const REQUIRED = new Set(AUTH_LOOKUP_REQUIRED_GRANTS.map(([t, p]) => `${t}:${p}`));

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
    ["sales", "SELECT, INSERT, UPDATE, DELETE"],
    ["audit_events", "SELECT, INSERT, UPDATE, DELETE"],
    ["memberships", "INSERT, UPDATE, DELETE"],
    // RT-113 BC2: cashier admission state and stored replay bodies are
    // tenant data behind FORCE RLS; the BYPASSRLS lookup role must not read them.
    ["cashier_admissions", "SELECT, INSERT, UPDATE, DELETE"],
    ["cashier_admission_requests", "SELECT, INSERT, UPDATE, DELETE"],
  ])("rejects a lookup role holding a forbidden grant on %s", async (table, privileges) => {
    const grants = new Set([...REQUIRED, `${table}:${privileges}`]);
    await expect(
      verifyDatabasePoolBoundary(
        rolePool({ roleName: "app_domain" }),
        rolePool({ roleName: "app_auth_lookup", bypassRls: true, grants }),
      ),
    ).rejects.toThrow(new RegExp(`forbidden grants on: ${table}`));
  });
});
