/** 0073_device_build_identity (RT-719): [its four nullable devices columns, their four CHECKs]. */
import { countColumns, countConstraints, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0073_device_build_identity",
  probe: {
    measure: async (db) => [
      await countColumns(db, "devices", [
        "reported_build_commit",
        "reported_app_version",
        "reported_contract_pin",
        "build_reported_at",
      ]),
      await countConstraints(db, [
        "devices_reported_build_commit_shape",
        "devices_reported_contract_pin_shape",
        "devices_reported_app_version_shape",
        "devices_build_identity_consistent",
      ]),
    ],
    applied: ["4", "4"],
    rolledBack: ["0", "0"],
  },
};
