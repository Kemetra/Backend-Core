/**
 * snapshot-report.dto.ts — Zod body schema for `binViewReportSnapshot`.
 *
 * Mirrors the 019 contract `BinViewSnapshotReport` (strict wire projection):
 *   - `entries`: 0..500 BinEntry (empty is a valid, non-failing report);
 *   - each entry: `erpnextItemRef {doctype:"Item", name}`, exact-decimal `quantity`
 *     STRING (the contract pattern — NEVER a float, §III), required `stockUom`;
 *   - `readAt`: connector-reported ISO timestamp (preserved; never a security clock).
 *
 * §XII strict boundary: `.strict()` everywhere rejects unknown keys, and there is
 * NO `tenant_id`/`storeId`/scope field — scope is the connector principal's;
 * `requestRef` is a PATH param (un-forgeable). A body that smuggles scope or an
 * unknown key is a 400 validation_error.
 */
import { z } from "zod";

/** The contract's exact-decimal quantity pattern (no float). */
const QUANTITY_PATTERN = /^-?[0-9]{1,15}(\.[0-9]{1,6})?$/;

const ErpnextItemRefSchema = z
  .object({
    doctype: z.literal("Item"),
    name: z.string().min(1).max(140),
  })
  .strict();

const BinEntrySchema = z
  .object({
    erpnextItemRef: ErpnextItemRefSchema,
    quantity: z
      .string()
      .regex(QUANTITY_PATTERN, "quantity must be an exact-decimal string"),
    stockUom: z.string().min(1).max(140),
  })
  .strict();

export const SnapshotReportBodySchema = z
  .object({
    entries: z.array(BinEntrySchema).max(500),
    readAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type SnapshotReportBody = z.infer<typeof SnapshotReportBodySchema>;
