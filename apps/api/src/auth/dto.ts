/**
 * Auth DTOs (Zod schemas).
 *
 * Schemas are attached to the controller via
 * `@Body(new ZodValidationPipe(<Schema>))`. The pipe throws ZodError on
 * failure; the global exception filter renders it as a `validation_error`
 * envelope (HTTP 400).
 *
 * Names use snake_case where the OpenAPI contract does (e.g.
 * `new_password`) so request bodies map 1:1 onto the wire schema.
 */
import {
  isWithinPasswordMaxLength,
  MAX_PASSWORD_CODE_POINTS,
} from "@data-pulse-2/auth";
import { Email } from "@data-pulse-2/shared";
import { z } from "zod";

/**
 * A password field (RT-153). The maximum is `MAX_PASSWORD_CODE_POINTS`
 * Unicode code points, the unit OpenAPI `maxLength` uses. Zod's `.max()`
 * counts UTF-16 units, so the bound is a refinement. Over-limit input fails
 * here, before any argon2 work. The value is passed on unchanged: no
 * trimming and no normalization.
 */
function passwordString(minLength: number) {
  return z
    .string()
    .min(minLength)
    .superRefine((value, ctx) => {
      if (!isWithinPasswordMaxLength(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_big,
          type: "string",
          maximum: MAX_PASSWORD_CODE_POINTS,
          inclusive: true,
          message: `String must contain at most ${MAX_PASSWORD_CODE_POINTS} character(s)`,
        });
      }
    });
}

/** POST /api/v1/auth/signin */
export const SignInSchema = z.object({
  email: Email,
  password: passwordString(1),
});
export type SignInInput = z.infer<typeof SignInSchema>;

/** POST /api/v1/auth/password-reset/request */
export const PasswordResetRequestSchema = z.object({
  email: Email,
});
export type PasswordResetRequestInput = z.infer<
  typeof PasswordResetRequestSchema
>;

/** POST /api/v1/auth/password-reset/confirm */
export const PasswordResetConfirmSchema = z.object({
  token: z.string().min(1).max(1024),
  // Same maximum as sign-in, so a reset can never set a password that
  // sign-in would reject.
  new_password: passwordString(12),
});
export type PasswordResetConfirmInput = z.infer<
  typeof PasswordResetConfirmSchema
>;

/** POST /api/v1/auth/email/verify/confirm */
export const EmailVerifyConfirmSchema = z.object({
  token: z.string().min(1).max(1024),
});
export type EmailVerifyConfirmInput = z.infer<
  typeof EmailVerifyConfirmSchema
>;

/**
 * Summary of the signed-in user. Mirrors the OpenAPI `UserSummary`
 * schema (see `contracts/auth.openapi.yaml`).
 */
export interface UserSummary {
  id: string;
  email: string;
  display_name: string | null;
  is_platform_admin: boolean;
}

/**
 * What a successful sign-in returns to the controller.
 *
 * `sessionId` is the sessions row key (UUIDv7). It is not a credential.
 * `sessionCredential` is the CSPRNG cookie value, shown to the browser
 * once. Only its SHA-256 is stored.
 */
export interface SignInResult {
  sessionId: string;
  sessionCredential: string;
  userId: string;
  absoluteExpiresAt: Date;
  user: UserSummary;
}
