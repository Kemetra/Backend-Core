/**
 * Zod schemas of the RT-327 Console device health reads
 * (`consoleListDeviceHealth`, `consoleGetDeviceHealth`). Mirrors the contract.
 *
 * Tenant, store scope and caller are NEVER read here: they come from the
 * dashboard session (§XII). `.strict()` rejects an unknown query key, and a
 * repeated key (an array) fails the string schemas. Every refusal is a 400
 * `validation_error` raised before any database read. Ids are normalised to
 * lower case (the contract's "case insensitive").
 */
import { z } from "zod";

import { COMPLIANCE_VALUES } from "./compliance";
import { UPDATE_CHANNELS } from "./dto";
import { LIVENESS_VALUES } from "./liveness";
import { TRUST_STATES } from "./device-health.projections";
import { APP_VERSION_MAX_LENGTH, APP_VERSION_MIN_LENGTH, APP_VERSION_PATTERN } from "./semver";

export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;

const UuidSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

export const DeviceHealthListQuerySchema = z
  .object({
    store_id: UuidSchema.optional(),
    trust_state: z.enum(TRUST_STATES).optional(),
    app_version: z.string().min(APP_VERSION_MIN_LENGTH).max(APP_VERSION_MAX_LENGTH).regex(APP_VERSION_PATTERN).optional(),
    update_channel: z.enum(UPDATE_CHANNELS).optional(),
    compliance: z.enum(COMPLIANCE_VALUES).optional(),
    liveness: z.enum(LIVENESS_VALUES).optional(),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/, "cursor must be an opaque continuation token")
      .optional(),
    page_size: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
  })
  .strict();

export type DeviceHealthListQuery = z.infer<typeof DeviceHealthListQuerySchema>;

export const DeviceIdParamSchema = UuidSchema;
