import type { Pool } from "pg";

import {
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
}): Pool {
  return {
    query: jest.fn().mockResolvedValue({
      rows: [
        {
          role_name: input.roleName,
          is_superuser: input.superuser ?? false,
          bypass_rls: input.bypassRls ?? false,
        },
      ],
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
});
