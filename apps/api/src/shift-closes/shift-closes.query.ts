/**
 * Zod schemas for the RT-383 admin shift-close reads
 * (`shift-closes.openapi.yaml`: `consoleListShiftCloses`,
 * `consoleGetShiftClose`).
 *
 * Mirrors the contract parameters. Tenant and store scope are NEVER read here:
 * they come from the dashboard session (§XII). `.strict()` rejects an unknown
 * query key (a smuggled `tenant_id` is a 400). Every refusal here is a 400
 * `validation_error` raised before any database read of the closes.
 *
 * Ids are normalised to lower case (the contract's "case insensitive"). The
 * date-time and decimal filters are kept as the strings sent: Postgres casts
 * them (`::timestamptz`, `::numeric`) so no precision is lost to a JS Date or
 * number.
 */
import { z } from "zod";

import { canonicalInstant } from "../pos-shifts/shift-money";

const UuidSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

/** RFC 3339 `date-time`: `Z` or a `±HH:MM` offset (the colon is required). */
const RFC3339_INSTANT_RE = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** The widest offset a Postgres `timestamptz` input accepts (±15:59); beyond it is SQLSTATE 22009. */
const MAX_OFFSET_MINUTES = 15 * 60 + 59;

/**
 * An RFC 3339 instant Postgres can represent. Zod's `datetime({ offset: true })`
 * also admits `+0530` and offsets up to `±99:99`; Postgres refuses offsets
 * beyond ±15:59 (22009) and year 0000 (22008). Both are refused here, as a 400,
 * before any database read.
 */
const InstantSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => {
    const m = RFC3339_INSTANT_RE.exec(value);
    if (m === null || Number(m[1]) === 0) return false;
    if (m[2] === undefined) return true;
    const minutes = Number(m[3]);
    return minutes <= 59 && Number(m[2]) * 60 + minutes <= MAX_OFFSET_MINUTES;
  }, "must be an RFC 3339 date-time with an offset between -15:59 and +15:59");

/** `NonNegativeDecimalAmount`: at most 15 integer and 4 fractional digits. */
const NON_NEGATIVE_DECIMAL_RE = /^[0-9]{1,15}(\.[0-9]{1,4})?$/;

export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;

export const ShiftCloseListQuerySchema = z
  .object({
    store_id: UuidSchema.optional(),
    closed_from: InstantSchema.optional(),
    closed_to: InstantSchema.optional(),
    close_kind: z.enum(["normal", "forced"]).optional(),
    min_abs_variance: z.string().regex(NON_NEGATIVE_DECIMAL_RE).optional(),
    currency_code: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    approval: z.enum(["approved", "not_approved"]).optional(),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/, "cursor must be an opaque continuation token")
      .optional(),
    page_size: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
  })
  .strict()
  .refine(
    (q) => q.closed_from === undefined || q.closed_to === undefined || isLater(q.closed_to, q.closed_from),
    { message: "closed_to must be later than closed_from", path: ["closed_to"] },
  );

export type ShiftCloseListQuery = z.infer<typeof ShiftCloseListQuerySchema>;

export const ShiftIdParamSchema = UuidSchema;

/**
 * True when instant `a` is strictly later than `b`, exactly: compared on the
 * canonical form (epoch seconds, then the fraction as written), so two
 * instants in the same millisecond are still ordered, as Postgres orders them.
 */
function isLater(a: string, b: string): boolean {
  const [aSeconds = "", aFraction = ""] = canonicalInstant(a).split(".");
  const [bSeconds = "", bFraction = ""] = canonicalInstant(b).split(".");
  if (Number(aSeconds) !== Number(bSeconds)) return Number(aSeconds) > Number(bSeconds);
  const width = Math.max(aFraction.length, bFraction.length);
  return aFraction.padEnd(width, "0") > bFraction.padEnd(width, "0");
}
