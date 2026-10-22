/** 0068_pos_device_health (RT-327): [its two tables, their SELECT + INSERT + UPDATE policies]. */
import { countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["device_health", "pos_version_policy"];

export const MIGRATION: MigrationEntry = {
  id: "0068_pos_device_health",
  probe: {
    measure: async (db) => [await countTables(db, TABLES), await countPolicies(db, TABLES)],
    applied: ["2", "6"],
    rolledBack: ["0", "0"],
  },
};
