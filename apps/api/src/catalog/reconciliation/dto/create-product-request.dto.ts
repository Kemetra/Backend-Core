/**
 * CreateProductFromUnknownItemRequest DTO — 005-WAVE2-CREATE-EDGES (T636).
 *
 * Zod schema + inferred type for the `tenantAdminCreateProductFromUnknownItem`
 * request body. Extracted from reconciliation.controller.ts so the contract
 * has a single named home and can be unit-tested in isolation.
 *
 * Mirrors OpenAPI `CreateProductFromUnknownItemRequest`
 * (packages/contracts/openapi/catalog/unknown-items.yaml):
 *   required: [name, tax_category]
 *   additionalProperties: false  -> .strict()
 *
 * The `.strict()` is load-bearing for Constitution §III (backend authority).
 * A request that smuggles `tenantId`/`tenant_id` is rejected at the boundary
 * with HTTP 400 (envelope code `validation_error` per ErrorCodes.VALIDATION)
 * instead of silently stripping the field. The persisted
 * `tenant_products.tenant_id` is always the resolved principal tenant from
 * `request.context` — the body never has a chance to override it.
 *
 * OpenAPI and runtime both use the platform `validation_error` wire code.
 */
import { z } from "zod";

export const CreateProductFromUnknownItemRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    tax_category: z.string().trim().min(1).max(64),
    category_id: z.string().uuid().nullable().optional(),
  })
  .strict();

export type CreateProductFromUnknownItemRequestDto = z.infer<
  typeof CreateProductFromUnknownItemRequestSchema
>;
