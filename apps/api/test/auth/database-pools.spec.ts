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
  // RT-213: device auth reads the device's tenant status on the domain role
  // (inside the tenant's RLS context). Without this grant every till would be
  // refused at once, so a missing grant must fail boot instead.
  "tenants:SELECT",
  // RT-343: sign-in reads the user's memberships (joined to roles) on this role.
  "memberships:SELECT",
  "roles:SELECT",
  // RT-17 (0036): the shift cash-up writes. UPDATE on shifts: the close moves
  // it to closed and the 0036 triggers take FOR SHARE / FOR UPDATE row locks.
  "shifts:SELECT",
  "shifts:INSERT",
  "shifts:UPDATE",
  "shift_closes:SELECT",
  "shift_closes:INSERT",
  "shift_cash_movements:SELECT",
  "shift_cash_movements:INSERT",
  "shift_refund_claims:SELECT",
  "shift_refund_claims:INSERT",
  // RT-330 (0037): the frozen posting resolution (append-only).
  "erpnext_posting_resolution:SELECT",
  "erpnext_posting_resolution:INSERT",
  // RT-425 (0042): the per-effect inventory integration state (mutable, no DELETE).
  "inventory_effect_integration:SELECT",
  "inventory_effect_integration:INSERT",
  "inventory_effect_integration:UPDATE",
  // RT-432 (0044): stock locations (read by every inventory path; INSERT by the
  // store trigger). Identity is immutable: no UPDATE / DELETE.
  "stock_locations:SELECT",
  "stock_locations:INSERT",
  // RT-448 (0045): tracking identities (read by the identity list). Read-only.
  "tracking_identities:SELECT",
  // RT-435 (0056): status-move / relocation event records (append-only) and
  // the tenant inventory settings (upserted, no DELETE).
  "inventory_position_events:SELECT",
  "inventory_position_events:INSERT",
  // RT-414 (0062): platform support sessions (opened, renewed, ended; never deleted).
  "platform_support_sessions:SELECT",
  "platform_support_sessions:INSERT",
  "platform_support_sessions:UPDATE",
  "tenant_inventory_settings:SELECT",
  "tenant_inventory_settings:INSERT",
  "tenant_inventory_settings:UPDATE",
  // RT-427 (0063): the Inventory Anchors (append-only).
  "inventory_anchors:SELECT",
  "inventory_anchors:INSERT",
  "inventory_anchor_lines:SELECT",
  "inventory_anchor_lines:INSERT",
  // RT-327 (0068): POS device health (upserted) and the global version policy (no DELETE).
  "device_health:SELECT",
  "device_health:INSERT",
  "device_health:UPDATE",
  "pos_version_policy:SELECT",
  "pos_version_policy:INSERT",
  "pos_version_policy:UPDATE",
  // RT-539 (0047): the receipt reprint record (append-only).
  "sale_reprints:SELECT",
  "sale_reprints:INSERT",
  // RT-418 (0051): payer responsibilities (append-only), and the payer rows the
  // Console routes create and a credit capture locks FOR SHARE (needs UPDATE).
  "sale_responsibilities:SELECT",
  "sale_responsibilities:INSERT",
  "payer_account:SELECT",
  "payer_account:INSERT",
  "payer_account:UPDATE",
  // RT-577 (0054): credit-sale reversals and their refund tenders (append-only),
  // and the shared approval-use ledger a credit return writes (append-only).
  "sale_credit_reversals:SELECT",
  "sale_credit_reversals:INSERT",
  "sale_credit_reversal_tenders:SELECT",
  "sale_credit_reversal_tenders:INSERT",
  "sale_approval_uses:SELECT",
  "sale_approval_uses:INSERT",
  // RT-787 (0067): refund executions (append-only).
  "refund_executions:SELECT",
  "refund_executions:INSERT",
  // RT-387 (0050): the shift variance policy revisions (append-only; the
  // Console publishes and every resolution reads them) and the persisted
  // approver verdict of a close (append-only, written once after the commit).
  "cash_variance_policy_revisions:SELECT",
  "cash_variance_policy_revisions:INSERT",
  "shift_close_approver_checks:SELECT",
  "shift_close_approver_checks:INSERT",
  // RT-365: the Console revoke locks the device row FOR UPDATE and sets the
  // revoke fields (FOR UPDATE needs the UPDATE privilege).
  "devices:UPDATE",
  // RT-367: the Console pairing codes INSERT (issue), SELECT (list, cancel,
  // the one-replacement check) and UPDATE (cancel; the redemption's burn).
  "pairing_codes:SELECT",
  "pairing_codes:INSERT",
  "pairing_codes:UPDATE",
]);

const LOOKUP_GRANTS: ReadonlySet<string> = new Set(
  AUTH_LOOKUP_REQUIRED_GRANTS.map(([t, p]) => `${t}:${p}`),
);

function rolePool(input: {
  roleName: string;
  /** The login role (`session_user`). Default: the role itself. */
  sessionRole?: string;
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
            session_role: input.sessionRole ?? input.roleName,
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

  // RT-357 — a URL can log in as a privileged role and switch with
  // `options=-c role=…`: current_user then passes every check below, while
  // RESET ROLE restores the login's own privileges.
  it.each([
    {
      name: "a domain URL that switched from another login",
      domain: { roleName: "app_domain", sessionRole: "postgres" },
      lookup: { roleName: "app_auth_lookup", bypassRls: true },
      message: /DATABASE_URL role must log in as itself/,
    },
    {
      name: "a lookup URL that switched from another login",
      domain: { roleName: "app_domain" },
      lookup: { roleName: "app_auth_lookup", sessionRole: "postgres", bypassRls: true },
      message: /AUTH_LOOKUP_DATABASE_URL role must log in as itself/,
    },
  ])("RT-357: rejects $name", async ({ domain, lookup, message }) => {
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
    // RT-213: the BYPASSRLS lookup role must not read tenants (it would see
    // every tenant row); device auth reads tenant status on the domain role.
    ["tenants", "SELECT"],
    ["tenants", "UPDATE"],
    ["tenants", "TRUNCATE"],
    // RT-17 (0036): shift cash-up facts are tenant data behind FORCE RLS.
    ["shifts", "SELECT"],
    ["shifts", "TRUNCATE"],
    ["shift_closes", "SELECT"],
    ["shift_cash_movements", "INSERT"],
    ["shift_refund_claims", "REFERENCES"],
    // RT-387 (0050): the policy revisions and the approver verdicts are tenant data.
    ["cash_variance_policy_revisions", "SELECT"],
    ["shift_close_approver_checks", "INSERT"],
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
    for (const table of [
      "sales",
      "receivable",
      "audit_events",
      "cashier_admissions",
      "tenants",
      "shifts",
      "shift_closes",
      "shift_cash_movements",
      "shift_refund_claims",
      "inventory_effect_integration",
      "stock_locations",
      "tracking_identities",
      "erpnext_tracking_map",
      "inventory_position_events",
      "tenant_inventory_settings",
      "inventory_anchors",
      "inventory_anchor_lines",
      "device_health",
      "pos_version_policy",
      "platform_support_sessions",
      "sale_reprints",
      "sale_responsibilities",
      "sale_credit_reversals",
      "sale_credit_reversal_tenders",
      "sale_approval_uses",
      "refund_executions",
      "cash_variance_policy_revisions",
      "shift_close_approver_checks",
    ]) {
      const entry = AUTH_LOOKUP_FORBIDDEN_GRANTS.find(([t]) => t === table);
      expect(entry).toBeDefined();
      const listed = entry![1].split(",").map((p) => p.trim());
      expect([...listed].sort()).toEqual([...ALL].sort());
    }
  });

  it("RT-212: forbids every privilege except SELECT on memberships, store_access and pairing_codes", () => {
    for (const table of ["memberships", "store_access", "pairing_codes"]) {
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
