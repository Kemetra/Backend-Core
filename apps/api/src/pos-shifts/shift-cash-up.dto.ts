/**
 * Strict Zod bodies for the RT-17 shift cash-up writes, mirroring
 * `OpenShiftRequest` and `RecordCashMovementRequest` in
 * `packages/contracts/openapi/pos-shifts.openapi.yaml` 1.1.0-draft.
 *
 * `.strict()` is the mass-assignment ban (Constitution §XII): tenant, store
 * and device come only from the credential, so any unknown key — a scope
 * field included — is a deterministic 400 `validation_error`.
 *
 * Money is exact-decimal strings (never a float). The open's precision
 * against its own `currencyCode` is checked here; a movement's precision
 * depends on the shift's currency and is checked by the service (also 400).
 */
import { z } from "zod";

import { minorUnitExponent } from "../catalog/sales/iso4217-minor-units";
import { fitsCurrencyPrecision } from "./shift-money";

const uuid = z.string().uuid();

/**
 * An RFC 3339 `date-time` on the POS clock (Codex P2, PR #713): `Z` or a
 * numeric `±HH:MM` offset, any fractional-second precision. Zod's
 * `offset: true` also admits `±HHMM` and out-of-range offsets, which RFC 3339
 * does not, so the zone is checked again. Every offset of one instant is the
 * same fact: `canonicalInstant` hashes it, Postgres stores it and the
 * projections echo it in UTC. Shared by every cash-up fact (2b-2's
 * `closedAt` included).
 */
export const ShiftInstantSchema = z
  .string()
  .datetime({ offset: true })
  .regex(/(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/, "must be an RFC 3339 date-time (Z or a ±HH:MM offset)");

const instant = ShiftInstantSchema;

/** `NonNegativeDecimalAmount`: up to 15 integer and 4 fractional digits. */
const nonNegativeAmount = z
  .string()
  .regex(/^[0-9]{1,15}(\.[0-9]{1,4})?$/, "must be a non-negative exact-decimal string");

/** `SignedDecimalAmount`: a non-negative amount, optionally negative (the close's variance). */
const signedAmount = z
  .string()
  .regex(/^-?[0-9]{1,15}(\.[0-9]{1,4})?$/, "must be an exact-decimal string");

/** `PositiveDecimalAmount`: a non-negative amount with a non-zero digit. */
const positiveAmount = nonNegativeAmount.regex(/[1-9]/, "must be greater than zero");

/** ISO-4217 alphabetic code that has a minor unit (a code without one is a 400). */
const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, "must be an ISO-4217 code")
  .refine((code) => minorUnitExponent(code) !== null, "must be an ISO-4217 currency with a minor unit");

/** Short free text: 1 to 200 characters (code points, as the database counts), no NUL. */
const shortText = z
  .string()
  .refine((text) => [...text].length <= 200, "must be at most 200 characters")
  .refine((text) => text.length > 0, "must not be empty")
  .refine((text) => !text.includes("\u0000"), "must not contain NUL");

/**
 * RT-224 attribution claim: the cashier's `users.id` on the device path. Its
 * presence selects the device path; the guard verifies it and the handler
 * records the guard-verified actor. Never a fact field (not hashed).
 */
const operatorUserId = uuid.optional();

/** `shift_id` path parameter: a malformed id is a 400, never a database error. */
export const ShiftIdParamSchema = uuid;

export const OpenShiftRequestSchema = z
  .object({
    shiftId: uuid,
    openedAt: instant,
    openingUserId: uuid,
    currencyCode,
    openingFloat: nonNegativeAmount,
    operatorUserId,
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!fitsCurrencyPrecision({ amount: body.openingFloat, currencyCode: body.currencyCode })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["openingFloat"],
        message: "has more fractional digits than the currency's minor unit",
      });
    }
  });

export const RecordCashMovementRequestSchema = z
  .object({
    movementId: uuid,
    kind: z.enum(["pay_in", "pay_out"]),
    amount: positiveAmount,
    reasonCode: z.enum(["bank_drop", "float_top_up", "petty_expense", "other"]),
    note: shortText.optional(),
    occurredAt: instant,
    operatorUserId,
  })
  .strict();

/** The largest `saleCount` the database stores (`integer`): a larger one is a 400, never a 500. */
const MAX_SALE_COUNT = 2_147_483_647;

/**
 * `CloseShiftRequest`. The service checks what depends on the recorded
 * shift: the amounts' precision against its currency (400), the arithmetic
 * and the opening float (422), the refund refs (422) and the approver (400).
 * Here: the shape, and `forcedReason` present if and only if the close is
 * forced (the contract's if / then / else).
 */
export const CloseShiftRequestSchema = z
  .object({
    closedAt: instant,
    closingUserId: uuid,
    closeKind: z.enum(["normal", "forced"]),
    forcedReason: shortText.optional(),
    openingFloat: nonNegativeAmount,
    cashSalesTotal: nonNegativeAmount,
    cashRefundsTotal: nonNegativeAmount,
    payInTotal: nonNegativeAmount,
    payOutTotal: nonNegativeAmount,
    expectedCash: nonNegativeAmount,
    countedCash: nonNegativeAmount,
    variance: signedAmount,
    saleCount: z.number().int().min(0).max(MAX_SALE_COUNT),
    cashRefundReturnRefs: z
      .array(uuid)
      .refine((refs) => new Set(refs).size === refs.length, "must not repeat a return"),
    varianceApprovedByUserId: uuid.optional(),
    operatorUserId,
  })
  .strict()
  .superRefine((body, ctx) => {
    if ((body.closeKind === "forced") !== (body.forcedReason !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["forcedReason"],
        message: "is required for a forced close and absent otherwise",
      });
    }
  });

export type OpenShiftRequestDto = z.infer<typeof OpenShiftRequestSchema>;
export type RecordCashMovementRequestDto = z.infer<typeof RecordCashMovementRequestSchema>;

/** The ShiftOpened fact: the body without the attribution claim. */
export type OpenShiftFact = Omit<OpenShiftRequestDto, "operatorUserId">;
/** The CashMovement fact: the body without the attribution claim. */
export type CashMovementFact = Omit<RecordCashMovementRequestDto, "operatorUserId">;
export type CloseShiftRequestDto = z.infer<typeof CloseShiftRequestSchema>;
/** The ShiftClosed fact: the body without the attribution claim. */
export type CloseShiftFact = Omit<CloseShiftRequestDto, "operatorUserId">;
