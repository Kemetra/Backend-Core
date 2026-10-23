/**
 * 0071_erpnext_posting_rejection_message (RT-410): [the rejection_message
 * column, its two validated CHECKs].
 */
import { countColumns, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0071_erpnext_posting_rejection_message",
  probe: {
    measure: async (db) => [
      await countColumns(db, "erpnext_posting_status", ["rejection_message"]),
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_constraint
         WHERE conname = ANY($1::text[]) AND convalidated`,
        [["erpnext_posting_status_rejection_message_length", "erpnext_posting_status_rejection_message_when_rejected"]],
      ),
    ],
    applied: ["1", "2"],
    rolledBack: ["0", "0"],
  },
};
