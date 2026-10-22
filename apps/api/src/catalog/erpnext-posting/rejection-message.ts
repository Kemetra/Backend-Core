/**
 * rejection-message.ts — RT-410 (AD-POSTING-001 D-2; contract
 * `reconciliation.yaml` 1.3.0-draft `PostingBacklogItem.reason`).
 *
 * The Connector's rejection message (posting-feed `RejectionReason.message`)
 * is already scrubbed by the Connector; Backend-Core sanitises it again before
 * storing it on the dead-lettered `erpnext_posting_status` row:
 *
 *   1. C0 and C1 control characters are removed (a space is not one), and the
 *      result is trimmed;
 *   2. credential values become `[redacted]`: a value after a key that ENDS an
 *      identifier (`token`, `password`, `passwd`, `pwd`, `secret`, `api_key`,
 *      `authorization`, e.g. `dp2_token=…`), and a `Bearer …` token;
 *   3. the result is cut to 1000 characters (code points, as `char_length`
 *      counts them), AFTER redaction, since a replacement can lengthen it;
 *   4. nothing left → null.
 *
 * It never throws: a message never causes an ack to be rejected. The message
 * is business data and PII-suspect (it may embed sale values): it is never
 * logged, audited, used as a metric label or sent to Sentry / Datadog.
 */

/** The stored bound (`rejection_message` CHECK, the contract's `maxLength`). */
export const REJECTION_MESSAGE_MAX = 1000;

const REDACTED = "[redacted]";

/** C0 (U+0000–U+001F) and C1 (U+0080–U+009F) control characters. */
// eslint-disable-next-line no-control-regex -- matching control characters is this pattern's purpose (D-2).
const CONTROL_CHARS = /[\u0000-\u001F\u0080-\u009F]/gu;

/**
 * A credential key ending an identifier, its separator (an optional quote,
 * `:` or `=`, an optional quote) and its value (an optional `Bearer ` and the
 * token up to a delimiter). An already-redacted value is left as it is, so
 * sanitising is idempotent.
 */
const KEY_VALUE =
  /([A-Za-z0-9_-]*?(?:token|password|passwd|pwd|secret|api[_-]?key|authorization))(["']?\s*[:=]\s*["']?)(?!\[redacted\])((?:bearer\s+)?[^\s"',;&}\]]+)/gi;

/** A standalone `Bearer <token>` (RFC 6750 b64token characters). */
const BEARER = /\b(bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi;

/** The message as Backend-Core stores it, or null when nothing is left. */
export function sanitizeRejectionMessage(message: string | null | undefined): string | null {
  if (typeof message !== "string") return null;
  const redacted = message
    .replace(CONTROL_CHARS, "")
    .trim()
    .replace(KEY_VALUE, (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`)
    .replace(BEARER, (_match, bearer: string) => `${bearer} ${REDACTED}`);
  const bounded = Array.from(redacted).slice(0, REJECTION_MESSAGE_MAX).join("");
  return bounded.length === 0 ? null : bounded;
}
