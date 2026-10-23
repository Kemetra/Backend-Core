/**
 * 0072_inventory_safety (RT-449): [its five tables, their policies (revisions
 * and holds SELECT + INSERT + UPDATE, the other three SELECT + INSERT),
 * tenant_inventory_settings.safety_ttl_seconds, the tracking_identities UPDATE
 * policy]. 0045's SELECT + INSERT policies on tracking_identities are asserted
 * inline in migrate.spec.ts.
 */
import { countColumns, countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = [
  "tenant_inventory_safety_revisions",
  "inventory_safety_changes",
  "inventory_recalls",
  "tracking_holds",
  "tracking_identity_expiry_corrections",
];

export const MIGRATION: MigrationEntry = {
  id: "0072_inventory_safety",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await countColumns(db, "tenant_inventory_settings", ["safety_ttl_seconds"]),
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'tracking_identities'
           AND policyname = 'tracking_identities_tenant_update'`,
      ),
    ],
    applied: ["5", "12", "1", "1"],
    rolledBack: ["0", "0", "0", "0"],
  },
};
