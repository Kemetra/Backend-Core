/**
 * RT-812 — the grants fragments (src/auth/grants/) against what deploy really
 * grants. The boot check's lists are assembled from fragments, so this spec is
 * what keeps them honest:
 *   - the routine deploy scripts are exactly the scripts the fragments pair with;
 *   - each fragment requires exactly the GRANTs of its scripts, so dropping a
 *     fragment entry, or a script GRANT the boot check does not verify, fails;
 *   - every table a post-baseline migration creates is classified for the
 *     BYPASSRLS auth lookup role (forbidden, or allowed with a reason);
 *   - the frozen baseline fragment never gains an entry.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMAIN_REQUIRED_GRANTS } from "../../src/auth/database-pools";
import { GRANT_REGISTRY } from "../../src/auth/grant-registry";
import {
  GRANTS_BASELINE_HEAD,
  ROUTINE_MARKER,
  routineGrantScripts,
  scriptGrants,
  tablesCreatedAfter,
} from "../_helpers/domain-grant-scripts";

const key = ([table, privilege]: readonly [string, string]): string => `${table}:${privilege}`;
const sorted = (items: Iterable<string>): string[] => [...new Set(items)].sort();

/** The baseline's scripts, frozen at origin/main 7847a9e9. Never add one. */
const BASELINE_SCRIPTS = [
  "cashier-admissions-domain-grants.sql",
  "device-lifecycle-domain-grants.sql",
  "erpnext-posting-resolution-domain-grants.sql",
  "inventory-anchors-domain-grants.sql",
  "inventory-effect-integration-domain-grants.sql",
  "inventory-position-events-domain-grants.sql",
  "platform-support-sessions-domain-grants.sql",
  "refund-executions-domain-grants.sql",
  "sale-credit-reversals-domain-grants.sql",
  "sale-reprints-domain-grants.sql",
  "sale-responsibilities-domain-grants.sql",
  "shift-cash-up-domain-grants.sql",
  "shift-variance-policy-domain-grants.sql",
  "signin-memberships-domain-grants.sql",
  "stock-locations-domain-grants.sql",
  "tracking-foundation-domain-grants.sql",
];

/** The baseline's lookup-forbidden tables, frozen at origin/main 7847a9e9. Never add one. */
const BASELINE_FORBIDDEN_TABLES = [
  "audit_events", "cash_variance_policy_revisions", "cashier_admission_requests", "cashier_admissions",
  "claim", "claim_receivables", "erpnext_tracking_map", "idempotency_keys", "inventory_anchor_lines",
  "inventory_anchors", "inventory_effect_integration", "inventory_position_events", "memberships",
  "outbox_events", "pairing_codes", "payer_account", "payment_application", "platform_support_sessions",
  "receivable", "refund_executions", "remittance", "sale_approval_uses", "sale_credit_reversal_tenders",
  "sale_credit_reversals", "sale_lines", "sale_refunds", "sale_reprints", "sale_responsibilities",
  "sale_return_lines", "sale_return_tenders", "sale_returns", "sale_sync_deadletters", "sale_tenders",
  "sale_voids", "sales", "shift_cash_movements", "shift_close_approver_checks", "shift_closes",
  "shift_refund_claims", "shifts", "stock_counts", "stock_locations", "stock_movements", "store_access", "tenant_inventory_settings",
  "tenants", "tracking_identities",
];

/** Tables a post-baseline migration creates that are neither forbidden nor allowed for the lookup role. */
function unclassifiedTables(
  created: readonly string[],
  forbidden: ReadonlyArray<readonly [string, string]>,
  allowed: Readonly<Record<string, string>>,
): string[] {
  const classified = new Set([...forbidden.map(([t]) => t), ...Object.keys(allowed)]);
  return sorted(created.filter((t) => !classified.has(t)));
}

describe("routine deploy scripts ⇔ grants fragments", () => {
  it("every marked script pairs with exactly one fragment, and every fragment script is marked", () => {
    expect(routineGrantScripts()).toEqual(sorted(Object.keys(GRANT_REGISTRY.deployScripts)));
  });

  it("each fragment requires exactly the GRANTs of its scripts", () => {
    for (const { name, grants } of GRANT_REGISTRY.fragments) {
      expect({ name, required: sorted(grants.domainRequired.map(key)) }).toEqual({
        name,
        required: sorted(grants.deployScripts.flatMap((s) => scriptGrants(s))),
      });
    }
  });

  it("the boot check verifies every grant the routine scripts give the domain role, and nothing else", () => {
    expect(sorted(DOMAIN_REQUIRED_GRANTS.map(key))).toEqual(sorted(routineGrantScripts().flatMap((s) => scriptGrants(s))));
    expect(DOMAIN_REQUIRED_GRANTS.length).toBeGreaterThanOrEqual(60);
  });

  it("every routine script grants something to the domain role", () => {
    for (const script of routineGrantScripts()) expect({ script, grants: scriptGrants(script).length > 0 }).toEqual({ script, grants: true });
  });

  it("keeps the owner-gated AI entitlement grants out of the routine set", () => {
    expect(routineGrantScripts()).not.toContain("ai-entitlements-domain-grants.sql");
    expect(Object.keys(GRANT_REGISTRY.deployScripts)).not.toContain("ai-entitlements-domain-grants.sql");
  });
});

describe("the oracle reads the scripts the way deploy runs them", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rt812-grants-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("selects only marked *-domain-grants.sql files and parses multi-table, multi-privilege GRANTs", () => {
    writeFileSync(join(dir, "a-domain-grants.sql"), `-- header\n${ROUTINE_MARKER}\nGRANT SELECT, INSERT ON a, b TO :"domain_role";\n`);
    writeFileSync(join(dir, "gated-domain-grants.sql"), `GRANT SELECT ON g TO :"domain_role";\n`);
    writeFileSync(join(dir, "c-catchup.sql"), `${ROUTINE_MARKER}\n`);
    expect(routineGrantScripts(dir)).toEqual(["a-domain-grants.sql"]);
    expect(scriptGrants("a-domain-grants.sql", dir).sort()).toEqual(["a:INSERT", "a:SELECT", "b:INSERT", "b:SELECT"]);
  });

  it("refuses a GRANT it cannot parse instead of skipping it", () => {
    for (const grant of [
      'GRANT SELECT ON TABLE t TO :"domain_role";',
      'GRANT SELECT ON public.t TO :"domain_role";',
      'grant select on t to :"domain_role";',
      'GRANT SELECT ON t TO :"lookup_role";',
    ]) {
      writeFileSync(join(dir, "x-domain-grants.sql"), `${ROUTINE_MARKER}\nGRANT INSERT ON a TO :"domain_role";\n${grant}\n`);
      expect(() => scriptGrants("x-domain-grants.sql", dir)).toThrow(/1 GRANT statement\(s\) the grant oracle cannot parse/);
    }
  });

  it("finds tables created after the baseline head only", () => {
    writeFileSync(join(dir, "0067_old.sql"), "CREATE TABLE old_t (id int);");
    writeFileSync(join(dir, "0068_new.sql"), 'CREATE TABLE IF NOT EXISTS public."new_t" (id int);\nCREATE TABLE other_t ();');
    writeFileSync(join(dir, "0068_new.down.sql"), "CREATE TABLE down_only ();");
    expect(tablesCreatedAfter("0067_old", dir)).toEqual(["new_t", "other_t"]);
  });
});

describe("auth lookup role: every new table is classified (RT-812 rule)", () => {
  it("every table a post-baseline migration creates is forbidden or allowed with a reason", () => {
    expect(
      unclassifiedTables(tablesCreatedAfter(GRANTS_BASELINE_HEAD), GRANT_REGISTRY.lookupForbidden, GRANT_REGISTRY.lookupAllowed),
    ).toEqual([]);
  });

  it("flags a planted unclassified table", () => {
    expect(unclassifiedTables(["planted_t", "sales"], GRANT_REGISTRY.lookupForbidden, {})).toEqual(["planted_t"]);
  });

  it("every allowed table is one a post-baseline migration creates (no stale reasons)", () => {
    const created = new Set(tablesCreatedAfter(GRANTS_BASELINE_HEAD));
    for (const table of Object.keys(GRANT_REGISTRY.lookupAllowed)) expect({ table, created: created.has(table) }).toEqual({ table, created: true });
  });
});

describe("frozen grants baseline", () => {
  const baseline = GRANT_REGISTRY.fragments[0]!;

  it("loads first and is the baseline", () => {
    expect(baseline.name).toBe("baseline");
  });

  it("pairs with exactly the baseline scripts", () => {
    expect([...baseline.grants.deployScripts].sort()).toEqual(BASELINE_SCRIPTS);
  });

  it("forbids exactly the baseline tables and allows none", () => {
    expect(sorted(baseline.grants.lookupForbidden.map(([t]) => t))).toEqual(BASELINE_FORBIDDEN_TABLES);
    expect(baseline.grants.lookupAllowed).toEqual([]);
  });
});
