/**
 * Zod schemas for the RT-367 Console pairing codes (`devices.openapi.yaml`:
 * `consoleIssuePairingCode`, `consoleListPairingCodes`,
 * `consoleCancelPairingCode`).
 *
 * Mirrors the contract. The tenant, the actor and the kind (pair / replace /
 * move) are NEVER read here: the tenant and actor come from the session
 * (§XII), the kind from the stores. `.strict()` rejects an unknown key (400).
 * Ids are normalised to lower case.
 */
import { z } from "zod";

const UuidSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

/** Not blank, no NUL (Postgres `text` refuses U+0000; the 0024 CHECKs refuse blanks). */
const text = (max: number): z.ZodType<string> =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/\S/, "must not be blank")
    .refine((value) => !value.includes("\u0000"), "must not contain a NUL character");

const PrinterUsbIdSchema = z.string().regex(/^0x[0-9A-Fa-f]{4}$/, "must be 0xHHHH");

export const TTL_MINUTES_DEFAULT = 60;

export const PairingCodeIssueBodySchema = z
  .object({
    storeId: UuidSchema,
    terminalLabel: text(64).optional(),
    ttlMinutes: z.number().int().min(1).max(1440).optional(),
    replacesDeviceId: UuidSchema.optional(),
    branchName: text(256),
    branchAddress: text(512),
    taxRegistrationId: text(64),
    printerVendorId: PrinterUsbIdSchema,
    printerProductId: PrinterUsbIdSchema,
    printerComPort: text(32).nullable().optional(),
  })
  .strict();

export type PairingCodeIssueBody = z.infer<typeof PairingCodeIssueBodySchema>;

export const PairingCodeListQuerySchema = z
  .object({
    store_id: UuidSchema.optional(),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/, "cursor must be an opaque continuation token")
      .optional(),
    page_size: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type PairingCodeListQuery = z.infer<typeof PairingCodeListQuerySchema>;

export const PairingCodeIdParamSchema = UuidSchema;
