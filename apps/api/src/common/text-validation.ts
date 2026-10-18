/**
 * text-validation.ts — RT-611: shared zod helpers for console text inputs.
 *
 *   - `wellFormedText`: refuses a lone UTF-16 surrogate. Postgres stores it as
 *     U+FFFD (so a resend is never a no-op) or refuses it in a `$jsonb` cast
 *     (22P02) only after the UPDATE.
 *   - `maxCodePoints`: the OpenAPI `maxLength` counts code points while zod
 *     `.max(n)` counts UTF-16 units, so a contract-valid emoji string would be a
 *     400. Use this in place of `.max(n)`.
 */
import type { RefinementCtx } from "zod";
import { z } from "zod";

/** RT-612: Postgres refuses NUL in a text column (22021); reject it as a 400 first. */
export const NO_NUL_MESSAGE = "must not hold a NUL character";

export function hasNoNul(value: string): boolean {
  return !value.includes("\u0000");
}

/** A lone surrogate: with the `u` flag a valid pair is one code point and never matches. */
const LONE_SURROGATE = /\p{Surrogate}/u;

export function isWellFormedText(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

export function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1; // eslint-disable-line @typescript-eslint/no-unused-vars
  return count;
}

/** `.superRefine` callback: a lone surrogate is a validation issue. */
export function wellFormedText(value: string, ctx: RefinementCtx): void {
  if (!isWellFormedText(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be well-formed text (no lone surrogate)" });
  }
}

/** `.superRefine` callback factory: at most `max` code points. */
export function maxCodePoints(max: number): (value: string, ctx: RefinementCtx) => void {
  return (value, ctx) => {
    if (codePointLength(value) > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "string",
        maximum: max,
        inclusive: true,
        message: `must be at most ${max} characters`,
      });
    }
  };
}
