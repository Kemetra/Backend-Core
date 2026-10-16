/**
 * Zod schemas for the RT-365 Console device registry
 * (`devices.openapi.yaml`: `consoleListDevices`, `consoleGetDevice`,
 * `consoleRevokeDevice`).
 *
 * Mirrors the contract. Tenant, store and actor are NEVER read here: they
 * come from the dashboard session (§XII). `.strict()` rejects an unknown key
 * (a smuggled `tenant_id` or `storeId` is a 400). Every refusal here is a 400
 * `validation_error` raised before any database read. Ids are normalised to
 * lower case (the contract's "case insensitive").
 */
import { z } from "zod";

import { REVOKE_REASONS, TRUST_STATES } from "./devices.projections";

const UuidSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;

export const DeviceListQuerySchema = z
  .object({
    store_id: UuidSchema.optional(),
    trust_state: z.enum(TRUST_STATES).optional(),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/, "cursor must be an opaque continuation token")
      .optional(),
    page_size: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
  })
  .strict();

export type DeviceListQuery = z.infer<typeof DeviceListQuerySchema>;

export const DeviceIdParamSchema = UuidSchema;

/** `RevokeNote`: 1..500 characters, not blank (0040 CHECK `devices_revoke_note_shape`). */
const RevokeNoteSchema = z.string().min(1).max(500).regex(/\S/, "note must not be blank");

export const DeviceRevokeBodySchema = z
  .object({
    reason: z.enum(REVOKE_REASONS),
    note: RevokeNoteSchema.optional(),
    acknowledgeCustodyException: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.reason !== "other" || body.note !== undefined, {
    message: "note is required when reason is other",
    path: ["note"],
  });

export type DeviceRevokeBody = z.infer<typeof DeviceRevokeBodySchema>;
