/**
 * 0070_shift_forced_closes (RT-742): [the force-close table, its SELECT +
 * INSERT policies, its two composite FK targets on shifts and devices].
 */
import { countConstraints, countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["shift_forced_closes"];

export const MIGRATION: MigrationEntry = {
  id: "0070_shift_forced_closes",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await countConstraints(db, ["uq_shifts_force_close_target", "uq_devices_tenant_store_target"]),
    ],
    applied: ["1", "2", "2"],
    rolledBack: ["0", "0", "0"],
  },
};
