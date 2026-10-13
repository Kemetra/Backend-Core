/**
 * receivable-query.dto.ts — Zod query schema for `consoleListReceivables` (035 T030).
 *
 * Mirrors the contract list parameters
 * (packages/contracts/openapi/settlement/settlement.yaml):
 *   store_id (uuid, optional)   — out-of-scope id → non-disclosing 404
 *   state    (ReceivableState)  — optional lifecycle filter
 *   payer_ref (uuid, optional)  — out-of-scope id → non-disclosing 404
 *   cursor   (opaque keyset)    — a prior page's nextCursor (the last id)
 *   page_size (1..200, def 50)
 *
 * Scope (tenant) is NEVER read here — it comes from the dashboard session
 * principal (§XII). `.strict()` rejects unknown query keys (a smuggled
 * `tenant_id` → 400). The cursor is the last page's last receivable `id` (a
 * `gen_random_uuid()` UUID, any version); the keyset is `id < $cursor`,
 * newest-first. A malformed cursor is a clean 400, never a silent from-start.
 */
import { z } from "zod";

import { RECEIVABLE_STATES } from "../receivable-state-machine";

/** Any-version UUID — the receivable id is `gen_random_uuid()` (v4). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ReceivableListQuerySchema = z
  .object({
    store_id: z.string().uuid().optional(),
    state: z.enum(RECEIVABLE_STATES).optional(),
    payer_ref: z.string().uuid().optional(),
    cursor: z
      .string()
      .min(1)
      .max(36, "cursor exceeds the maximum length")
      .regex(UUID_RE, "cursor must be a receivable-reference token")
      .optional(),
    page_size: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type ReceivableListQuery = z.infer<typeof ReceivableListQuerySchema>;
