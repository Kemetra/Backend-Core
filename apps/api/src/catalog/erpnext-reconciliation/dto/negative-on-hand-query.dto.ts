/**
 * negative-on-hand-query.dto.ts — Zod schemas for the RT-177 read operations
 * `listErpnextNegativeOnHandStores` + `listErpnextNegativeOnHand`.
 *
 * Mirrors the contract parameters `NegativeOnHandCursor` / `Limit` / `StoreId`:
 *   - `cursor`: optional opaque token (base64url, 1..2048). Its content is
 *     validated by the service against the operation that issued it; a token
 *     that does not decode is a 400, never a silent from-start.
 *   - `limit`: optional integer 1..500, default 100.
 *   - `storeId` (path): a uuid.
 *
 * Tenant and store scope are NEVER read here — they come from the dashboard
 * session (§XII). `.strict()` rejects unknown query keys.
 */
import { z } from "zod";

export const NegativeOnHandQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+$/, "cursor must be an opaque continuation token")
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

export type NegativeOnHandQuery = z.infer<typeof NegativeOnHandQuerySchema>;

export const StoreIdParamSchema = z.string().uuid();
