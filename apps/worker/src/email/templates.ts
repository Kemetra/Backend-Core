/**
 * Email templates — slice 5 (T115).
 *
 * Pure functions. No I/O. No `process.env`. No URL construction from
 * env vars (no front-end origin is wired into the worker yet — PQ-1).
 * The rawToken is embedded into the body as the source of truth; a
 * future slice that introduces a UI will format it inside a clickable
 * link. Until then, the recipient sees the token directly, which is
 * perfectly functional for the auth flows in scope.
 *
 * Why no userId in the body, subject, or tags?
 * --------------------------------------------
 * The recipient already knows who they are; surfacing their internal
 * UUID would be an unforced PII leak (it can show in mail-archive
 * search, screenshots, support pastes, etc.). The producer's `userId`
 * is for audit / dedupe only — the templates discard it.
 *
 * Tags
 * ----
 * `template_id` is a stable, non-PII label that real providers
 * (SendGrid, Postmark, etc.) use for analytics. We pre-emptively put
 * one on every message so the future provider integration has the
 * dashboard hook it needs without a template change.
 */
import type { EmailMessage } from "./email.adapter";

/**
 * Validated job shape after Zod parsing in the processor. We keep this
 * narrow on purpose: templates have no business knowing about producer
 * concerns.
 */
export interface RenderableEmailJob {
  readonly email: string;
  readonly rawToken: string;
}

export interface RenderableInvitationJob {
  readonly email: string;
  readonly rawToken: string;
  readonly tenantId: string;
}

export function renderPasswordResetEmail(
  job: RenderableEmailJob,
): EmailMessage {
  const { email, rawToken } = job;
  const textBody =
    "We received a request to reset your password.\n\n" +
    `Use this code to complete the reset: ${rawToken}\n\n` +
    "If you did not request this, you can ignore this email — your password will not change.";
  const htmlBody =
    "<p>We received a request to reset your password.</p>" +
    `<p>Use this code to complete the reset: <code>${rawToken}</code></p>` +
    "<p>If you did not request this, you can ignore this email — your password will not change.</p>";

  return {
    to: email,
    subject: "Reset your password",
    textBody,
    htmlBody,
    tags: { template_id: "auth.password-reset" },
  };
}

export function renderInvitationEmail(
  job: RenderableInvitationJob,
): EmailMessage {
  const { email, rawToken } = job;
  const textBody =
    "You have been invited to join a tenant on Retail Tower OS.\n\n" +
    `Use this token to accept the invitation: ${rawToken}\n\n` +
    "If you did not expect this invitation, you can ignore this email.";
  const htmlBody =
    "<p>You have been invited to join a tenant on Retail Tower OS.</p>" +
    `<p>Use this token to accept the invitation: <code>${rawToken}</code></p>` +
    "<p>If you did not expect this invitation, you can ignore this email.</p>";

  return {
    to: email,
    subject: "You have been invited to Retail Tower OS",
    textBody,
    htmlBody,
    tags: { template_id: "memberships.invitation" },
  };
}

export function renderEmailVerificationEmail(
  job: RenderableEmailJob,
): EmailMessage {
  const { email, rawToken } = job;
  const textBody =
    "Welcome — please confirm your email address.\n\n" +
    `Use this code to verify: ${rawToken}\n\n` +
    "If you did not create an account, you can ignore this email.";
  const htmlBody =
    "<p>Welcome — please confirm your email address.</p>" +
    `<p>Use this code to verify: <code>${rawToken}</code></p>` +
    "<p>If you did not create an account, you can ignore this email.</p>";

  return {
    to: email,
    subject: "Verify your email address",
    textBody,
    htmlBody,
    tags: { template_id: "auth.email-verify" },
  };
}
