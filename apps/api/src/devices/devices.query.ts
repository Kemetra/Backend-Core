/**
 * Zod schemas for the RT-365 Console device registry
 * (`devices.openapi.yaml`: `consoleListDevices`, `consoleGetDevice`,
 * `consoleRevokeDevice`) and the RT-366 impact preview (`consoleGetDeviceImpact`).
 *
 * Mirrors the contract. Tenant, store and actor are NEVER read here: they
 * come from the dashboard session (§XII). `.strict()` rejects an unknown key
 * (a smuggled `tenant_id` or `storeId` is a 400). Every refusal here is a 400
 * `validation_error` raised before any database read. Ids are normalised to
 * lower case (the contract's "case insensitive").
 */
import { z } from "zod";

import { LIFECYCLE_ACTIONS } from "./device-lifecycle.evaluator";
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

/**
 * `RevokeNote`: 1..500 characters, not blank (0040 CHECK
 * `devices_revoke_note_shape`), and no NUL (Postgres `text` refuses it, which
 * would otherwise surface as a 500).
 */
const RevokeNoteSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/\S/, "note must not be blank")
  .refine((note) => !note.includes("\u0000"), "note must not contain a NUL character");

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

/**
 * `consoleRetireDevice` (RT-368): the retire reason is free operator text
 * (0040 `devices_retire_reason_shape`), not a `RevokeReason`.
 */
export const DeviceRetireBodySchema = z
  .object({
    retireReason: z
      .string()
      .min(1)
      .max(500)
      .regex(/\S/, "retireReason must not be blank")
      .refine((reason) => !reason.includes("\u0000"), "retireReason must not contain a NUL character"),
  })
  .strict();

export type DeviceRetireBody = z.infer<typeof DeviceRetireBodySchema>;

/**
 * `consoleGetDeviceImpact` (RT-366): the action, and the revoke reason exactly
 * when the action is `revoke` (replace / move / retire record their own).
 */
export const DeviceImpactQuerySchema = z
  .object({
    action: z.enum(LIFECYCLE_ACTIONS),
    reason: z.enum(REVOKE_REASONS).optional(),
  })
  .strict()
  .refine((query) => (query.action === "revoke") === (query.reason !== undefined), {
    message: "reason is required for a revoke and not accepted for any other action",
    path: ["reason"],
  });

export type DeviceImpactQuery = z.infer<typeof DeviceImpactQuerySchema>;
