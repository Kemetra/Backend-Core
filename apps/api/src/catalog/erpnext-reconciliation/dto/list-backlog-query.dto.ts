/**
 * list-backlog-query.dto.ts — Zod query schema for `listPostingBacklog`.
 *
 * Mirrors the 012/010 cursor-list convention + the 017 contract `Cursor` / `Limit`
 * / `StoreFilter` / `ClassFilter` parameters:
 *   - `cursor`: optional opaque pagination cursor (the last row's `sequence`,
 *     numeric string); an unparseable cursor is a 400, not a silent from-start.
 *   - `limit`: optional integer 1..500, default 100 (the 009 ceiling).
 *   - `storeId`: optional store filter (uuid; within the session tenant).
 *   - `class`: optional rejection-category filter (free text — matched against
 *     the 015 `rejection_category`).
 *
 * Scope (tenant) is NEVER read here — it comes from the dashboard session
 * principal (§XII). `.strict()` rejects unknown query keys (mass-assignment ban).
 */
import { z } from "zod";

export const ListBacklogQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      // Bound to 18 digits: a PG bigint maxes at 19 digits; capping at 18 keeps
      // the `> $cursor::bigint` comparison safely in range (a too-long cursor is
      // a clean 400, never an unhandled 22003 → 500). Mirrors the 015 feed DTO.
      .max(18, "cursor exceeds the maximum length")
      .regex(/^\d+$/, "cursor must be an opaque numeric token")
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    storeId: z.string().uuid().optional(),
    class: z.string().min(1).max(100).optional(),
  })
  .strict();

export type ListBacklogQuery = z.infer<typeof ListBacklogQuerySchema>;
