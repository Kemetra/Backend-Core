/**
 * RT-738 (CAT-W1 + CAT-W2) — request bodies of the interim console catalog
 * writes (`catalog/console-catalog.yaml` 1.1.0-draft).
 *
 * Every body is `.strict()`: an unknown key — a price, a tenant id, a status,
 * a tracking field — is a 400 `validation_error`, so a server-owned field can
 * never be mass-assigned (§XII, O-2). Text counts code points as the contract
 * and the database do, and refuses a NUL or a lone surrogate (RT-611 /
 * RT-612). Every refusal here is a 400, raised after the guards and before
 * any read.
 */
import { z } from "zod";

import { hasNoNul, maxCodePoints, NO_NUL_MESSAGE, wellFormedText } from "../../common/text-validation";

const IDENTIFIER_TYPES = ["barcode", "sku", "plu", "supplier_code", "external_pos_id"] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

/** At least one character that is not whitespace. */
const NOT_BLANK = /[^\s]/;
/** The contract's identifier value pattern: no control character, no leading or trailing whitespace. */
// eslint-disable-next-line no-control-regex -- the contract pattern refuses control characters by range.
const IDENTIFIER_VALUE = /^[^\s\u0000-\u001F\u007F]([^\u0000-\u001F\u007F]*[^\s\u0000-\u001F\u007F])?$/;

/** Well-formed text of 1..`max` code points with no NUL, stored as sent. */
function text(max: number): z.ZodType<string, z.ZodTypeDef, string> {
  return z
    .string()
    .min(1)
    .superRefine(maxCodePoints(max))
    .superRefine(wellFormedText)
    .refine(hasNoNul, NO_NUL_MESSAGE);
}

/** Text with at least one non-whitespace character. */
function nonBlank(max: number): z.ZodType<string, z.ZodTypeDef, string> {
  return text(max).refine((value) => NOT_BLANK.test(value), "must not be blank");
}

const UuidSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

/**
 * An RFC 3339 instant, as the epoch milliseconds it names. Only compared with
 * a stored `updated_at` at millisecond precision, never written.
 */
const InstantMillisSchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().datetime({ offset: true }))
  .transform((value, ctx) => {
    const millis = Date.parse(value);
    if (Number.isNaN(millis)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be an RFC 3339 date-time" });
      return z.NEVER;
    }
    return millis;
  });

const ProductName = nonBlank(500);
const ProductDescription = text(2000).nullable();
const TaxCategory = nonBlank(50);

export const CreateCatalogProductBodySchema = z
  .object({
    name: ProductName,
    description: ProductDescription.optional(),
    categoryId: UuidSchema.nullable().optional(),
    taxCategory: TaxCategory,
    isActive: z.boolean().optional(),
  })
  .strict();
export type CreateCatalogProductBody = z.infer<typeof CreateCatalogProductBodySchema>;

export const UpdateCatalogProductBodySchema = z
  .object({
    expectedUpdatedAt: InstantMillisSchema,
    name: ProductName.optional(),
    description: ProductDescription.optional(),
    categoryId: UuidSchema.nullable().optional(),
    taxCategory: TaxCategory.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) => ["name", "description", "categoryId", "taxCategory", "isActive"].some((key) => key in body),
    "at least one field to change is required",
  );
export type UpdateCatalogProductBody = z.infer<typeof UpdateCatalogProductBodySchema>;

export const RetireBodySchema = z.object({ expectedUpdatedAt: InstantMillisSchema }).strict();
export type RetireBody = z.infer<typeof RetireBodySchema>;

export const ProductIdentifierKeySchema = z
  .object({
    identifierType: z.enum(IDENTIFIER_TYPES),
    value: text(200).refine((value) => IDENTIFIER_VALUE.test(value), "must have no control character and no leading or trailing whitespace"),
    storeId: UuidSchema.nullable().optional(),
    sourceSystem: nonBlank(100).nullable().optional(),
  })
  .strict()
  .superRefine((key, ctx) => {
    const external = key.identifierType === "external_pos_id";
    if (external && (key.sourceSystem ?? null) === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceSystem"], message: "is required for external_pos_id" });
    }
    if (external && (key.storeId ?? null) !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["storeId"], message: "is not allowed for external_pos_id" });
    }
    if (!external && (key.sourceSystem ?? null) !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceSystem"], message: "is only allowed for external_pos_id" });
    }
  });
export type ProductIdentifierKeyBody = z.infer<typeof ProductIdentifierKeySchema>;

export const UpsertStoreOverrideBodySchema = z
  .object({
    expectedUpdatedAt: InstantMillisSchema.nullable(),
    isActive: z.boolean().nullable().optional(),
    taxCategory: TaxCategory.nullable().optional(),
  })
  .strict()
  .refine((body) => "isActive" in body || "taxCategory" in body, "isActive or taxCategory is required");
export type UpsertStoreOverrideBody = z.infer<typeof UpsertStoreOverrideBodySchema>;
