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
 *      `authorization`, e.g. `dp2_token=…`, whatever its auth scheme, and a
 *      quoted value whole), and a standalone `Bearer …`, `token key:secret`
 *      or `Basic …` credential;
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
 * A credential key ending an identifier, its separator (an optional closing
 * quote of the key, `:` or `=`) and its value: a quoted value up to its
 * closing quote (spaces included), or an optional auth-scheme word (`Bearer`,
 * `Basic`, `token` as in Frappe's `token key:secret`, `Digest`) with the
 * credential up to a delimiter (PR #905 review). An already-redacted value is
 * left as it is, so sanitising is idempotent.
 */
const KEY_VALUE =
  /([A-Za-z0-9_-]*?(?:token|password|passwd|pwd|secret|api[_-]?key|authorization))(["']?\s*[:=]\s*)(?!["']?\[redacted\])("[^"]*"?|'[^']*'?|(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;&}\]]+)/gi;

/**
 * A standalone auth scheme and its credential, outside any key: `Bearer
 * <b64token>` (RFC 6750), Frappe's `token <key>:<secret>`, and `Basic
 * <base64>` (at least 8 characters with a digit, `+`, `/`, `=` or a
 * lower-to-upper case change, as in `dXNlcjpwYXNz`; prose such as "Basic
 * validation" or "Basic Rate" is left alone). The scheme word matches any
 * case; the credential's case test must not, hence the inline `[a-z][A-Z]`.
 */
const SCHEME_CREDENTIALS = [
  /\b(bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\b(token)\s+[\w.-]+:[\w.-]+/gi,
  /\b([Bb][Aa][Ss][Ii][Cc])\s+(?=[A-Za-z0-9+/]*(?:[0-9+/=]|[a-z][A-Z]))[A-Za-z0-9+/]{8,}={0,2}/g,
];

/** The key and separator kept, the value replaced; a quoted value keeps its quotes. */
function redactKeyValue(_match: string, key: string, separator: string, value: string): string {
  const quote = value.startsWith('"') || value.startsWith("'") ? value[0]! : "";
  const closing = quote !== "" && value.length > 1 && value.endsWith(quote) ? quote : "";
  return `${key}${separator}${quote}${REDACTED}${closing}`;
}

/** The message as Backend-Core stores it, or null when nothing is left. */
export function sanitizeRejectionMessage(message: string | null | undefined): string | null {
  if (typeof message !== "string") return null;
  const redacted = SCHEME_CREDENTIALS.reduce(
    (text, scheme) => text.replace(scheme, (_match, word: string) => `${word} ${REDACTED}`),
    message.replace(CONTROL_CHARS, "").trim().replace(KEY_VALUE, redactKeyValue),
  );
  const bounded = Array.from(redacted).slice(0, REJECTION_MESSAGE_MAX).join("");
  return bounded.length === 0 ? null : bounded;
}
