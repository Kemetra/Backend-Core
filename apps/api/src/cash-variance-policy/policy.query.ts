/**
 * Zod schemas for the shift variance policy operations
 * (`cash-variance-policy.openapi.yaml` 1.0.0-draft). Strict: tenant and store
 * come from the path, the session or the device row, never the body or query
 * (§XII), so an unknown key is a 400 `validation_error` before any read.
 *
 * Money stays an exact-decimal string. A publish may carry at most the
 * currency's ISO-4217 minor-unit fractional digits (400); whether the
 * currency is supported (V1: EGP) is the service's 422, checked later in the
 * contract's order.
 */
import { z } from "zod";

import { minorUnitExponent } from "../catalog/sales/iso4217-minor-units";

const UuidSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

export const PathIdSchema = UuidSchema;

/** `NonNegativeDecimalAmount`: at most 15 integer and 4 fractional digits. */
const AMOUNT_RE = /^\d{1,15}(\.\d{1,4})?$/;

/** The fractional digits of an amount, as written. */
function fractionDigits(amount: string): number {
  const dot = amount.indexOf(".");
  return dot === -1 ? 0 : amount.length - dot - 1;
}

export const PolicyValueSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("none") }).strict(),
    z
      .object({
        mode: z.literal("limit"),
        limitAmount: z.string().regex(AMOUNT_RE, "must be a non-negative exact-decimal string"),
        currencyCode: z.string().regex(/^[A-Z]{3}$/, "must be an ISO-4217 code"),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.mode !== "limit") return;
    const exponent = minorUnitExponent(value.currencyCode);
    if (exponent !== null && fractionDigits(value.limitAmount) > exponent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["limitAmount"],
        message: "has more fractional digits than the currency's minor unit",
      });
    }
  });

/** A UTF-16 surrogate without its pair: not Unicode text (jsonb refuses it in the audit row). */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** `Reason`: 1 to 200 characters (code points, as the database counts), no NUL, well-formed. */
const ReasonSchema = z
  .string()
  .refine((text) => [...text].length >= 1 && [...text].length <= 200, "must be 1 to 200 characters")
  .refine((text) => !text.includes("\u0000"), "must not contain NUL")
  .refine((text) => !LONE_SURROGATE_RE.test(text), "must be well-formed Unicode text");

/** RFC 3339 instant (`Z` or `±HH:MM`) Postgres can represent (no year 0000, offset ≤ ±15:59). */
const RFC3339_RE = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const InstantSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => {
    const m = RFC3339_RE.exec(value);
    if (m === null || Number(m[1]) === 0) return false;
    if (m[2] === undefined) return true;
    const minutes = Number(m[3]);
    return minutes <= 59 && Number(m[2]) * 60 + minutes <= 15 * 60 + 59;
  }, "must be an RFC 3339 date-time with an offset between -15:59 and +15:59");

const ExpectedRevisionIdSchema = UuidSchema.nullable();

export const PublishTenantPolicySchema = z
  .object({
    expectedRevisionId: ExpectedRevisionIdSchema,
    policyValue: PolicyValueSchema,
    reason: ReasonSchema,
  })
  .strict();

export const PublishStoreOverrideSchema = z
  .object({
    expectedRevisionId: ExpectedRevisionIdSchema,
    kind: z.enum(["set", "clear"]),
    policyValue: PolicyValueSchema.optional(),
    reason: ReasonSchema,
    effectiveUntil: InstantSchema.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const isSet = body.kind === "set";
    if (isSet && body.policyValue === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["policyValue"], message: "is required for a set" });
    }
    if (!isSet && (body.policyValue !== undefined || body.effectiveUntil !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"], message: "a clear carries no value and no expiry" });
    }
  });

export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 100;

export const RevisionListQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/, "cursor must be an opaque continuation token")
      .optional(),
    page_size: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
  })
  .strict();

/** The device read takes no query parameter. */
export const DeviceReadQuerySchema = z.object({}).strict();

/** `If-None-Match`: one strong ETag as this API issues it. */
export const IfNoneMatchSchema = z.string().regex(/^"[0-9a-f]{64}"$/).optional();

export type PublishTenantPolicyBody = z.infer<typeof PublishTenantPolicySchema>;
export type PublishStoreOverrideBody = z.infer<typeof PublishStoreOverrideSchema>;
export type RevisionListQuery = z.infer<typeof RevisionListQuerySchema>;
