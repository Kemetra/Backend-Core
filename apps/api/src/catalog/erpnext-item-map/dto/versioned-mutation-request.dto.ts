/**
 * VersionedMutationRequest DTO + Zod schema (013-CRUD / T032, T035; 013-REPOINT / T040).
 *
 * Mirrors the OpenAPI `VersionedMutationRequest`
 * (packages/contracts/openapi/catalog/erpnext-item-map.yaml):
 *   required: [version]
 *   additionalProperties: false
 *
 * The confirm + retire commands carry ONLY the expected `version` for
 * optimistic concurrency (Constitution §III): the update is
 * `WHERE id = :id AND version = :version`; a mismatch is 409. STRICT
 * (`.strict()`, §XII): identity + actor fields are server-resolved and a
 * smuggled key is rejected 400 `validation_error`.
 */
import { z } from "zod";

export const VersionedMutationRequestSchema = z
  .object({
    // Postgres int4, bound as `WHERE version = $2`. Past 2^31-1 is 22003, not 409.
    version: z.number().int().min(1).max(2147483647),
  })
  .strict();

export type VersionedMutationRequestDto = z.infer<
  typeof VersionedMutationRequestSchema
>;
