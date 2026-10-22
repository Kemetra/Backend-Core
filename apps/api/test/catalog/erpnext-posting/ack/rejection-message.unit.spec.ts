/**
 * RT-410 — sanitizeRejectionMessage (AD-POSTING-001 D-2; contract
 * `reconciliation.yaml` 1.3.0-draft `PostingBacklogItem.reason`).
 *
 * Before the Connector's rejection message is stored: C0 and C1 control
 * characters are removed and the result trimmed; credential values (`Bearer …`
 * and keys ending an identifier: token, password, passwd, pwd, secret,
 * api_key, authorization) become `[redacted]`; the result is cut to 1000
 * characters AFTER redaction; nothing left is null. It never throws.
 */
import {
  REJECTION_MESSAGE_MAX,
  sanitizeRejectionMessage,
} from "../../../../src/catalog/erpnext-posting/rejection-message";

describe("sanitizeRejectionMessage — plain text passes through", () => {
  it.each([
    ["an RT-378 representation mismatch", "RepresentationMismatch: representation: rate 12.50 != 12.5"],
    ["a NameError", "NameError: name 'flt' is not defined"],
    ["a word that only contains a key", "tokenizer failed on item ITEM-1; token_count=3"],
    ["an ERPNext name", "Item ACC-SINV-2026-00777 not found in Main Store - KT"],
  ])("%s is stored as sent", (_label, message) => {
    expect(sanitizeRejectionMessage(message)).toBe(message);
  });
});

describe("sanitizeRejectionMessage — control characters and whitespace", () => {
  it("removes C0 and C1 control characters but keeps spaces", () => {
    expect(sanitizeRejectionMessage("line one\nline\ttwo\u0000\u001b[31m red\u0085\u009b end")).toBe(
      "line onelinetwo[31m red end",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeRejectionMessage("   ValidationError: x   ")).toBe("ValidationError: x");
  });

  it.each([
    ["an empty string", ""],
    ["spaces only", "    "],
    ["control characters only", "\u0000\u0007\n\r\u009f"],
    ["undefined", undefined],
    ["null", null],
  ])("%s → null", (_label, message) => {
    expect(sanitizeRejectionMessage(message as string | null | undefined)).toBeNull();
  });
});

describe("sanitizeRejectionMessage — credential values are redacted", () => {
  it.each([
    ["a key ending an identifier", "auth failed: dp2_token=abc123XYZ", "auth failed: dp2_token=[redacted]"],
    ["a bare token key", "token: s3cr3t-v4lue retry", "token: [redacted] retry"],
    ["password / passwd / pwd", "password=a passwd=b PWD=c", "password=[redacted] passwd=[redacted] PWD=[redacted]"],
    ["a secret key", "client_secret=deadbeef;", "client_secret=[redacted];"],
    ["a JSON api_key", '{"api_key": "k-123", "item": "X"}', '{"api_key": "[redacted]", "item": "X"}'],
    ["an Authorization header with Bearer", "Authorization: Bearer eyJ.abc.def", "Authorization: [redacted]"],
    ["a standalone Bearer token", "sent Bearer abc.DEF-123_x= upstream", "sent Bearer [redacted] upstream"],
    ["mixed case keys", "API_KEY=1 Api-Key=2", "API_KEY=[redacted] Api-Key=[redacted]"],
  ])("%s", (_label, message, expected) => {
    expect(sanitizeRejectionMessage(message)).toBe(expected);
  });

  // PR #905 review (gitar): any auth scheme takes its credential with it, and
  // a quoted value is redacted up to its closing quote.
  it.each([
    ["a Frappe API key:secret header", "Authorization: token 1a2b3c:9f8e7d", "Authorization: [redacted]"],
    ["a Basic header", "Authorization: Basic dXNlcjpwYXNz", "Authorization: [redacted]"],
    ["a Digest header", "authorization=Digest abc123", "authorization=[redacted]"],
    ["a double-quoted value with spaces", 'password="hunter two" then', 'password="[redacted]" then'],
    ["a single-quoted value with spaces", "secret: 'a b c' x", "secret: '[redacted]' x"],
    ["an unterminated quoted value", 'api_key="k 1 2', 'api_key="[redacted]'],
    ["a standalone Frappe token", "call failed: token 1a2b3c:9f8e7d (retry)", "call failed: token [redacted] (retry)"],
    ["a standalone Basic credential", "sent Basic dXNlcjpwYXNz= upstream", "sent Basic [redacted] upstream"],
  ])("%s", (_label, message, expected) => {
    expect(sanitizeRejectionMessage(message)).toBe(expected);
  });

  it.each([
    ["the word token in prose", "token expired for item ITEM-1"],
    ["the word Basic in prose", "Basic validation failed on Sales Invoice"],
  ])("%s is not a credential", (_label, message) => {
    expect(sanitizeRejectionMessage(message)).toBe(message);
  });

  it("is idempotent: sanitising a stored message changes nothing", () => {
    const once = sanitizeRejectionMessage(
      'x dp2_token=abc Authorization: Bearer q password="a b" token k:s Basic dXNlcjpwYXNz',
    );
    expect(sanitizeRejectionMessage(once)).toBe(once);
  });
});

describe("sanitizeRejectionMessage — the 1000-character bound", () => {
  it("cuts to 1000 characters AFTER redaction (a replacement can lengthen the text)", () => {
    const message = `${"x".repeat(990)} token=a`;
    expect(message).toHaveLength(998);
    const stored = sanitizeRejectionMessage(message)!;
    expect(Array.from(stored)).toHaveLength(REJECTION_MESSAGE_MAX);
    expect(stored.startsWith(`${"x".repeat(990)} token=[`)).toBe(true);
  });

  it("counts characters as the database does (code points, not UTF-16 units)", () => {
    const stored = sanitizeRejectionMessage("😀".repeat(1200))!;
    expect(Array.from(stored)).toHaveLength(REJECTION_MESSAGE_MAX);
  });
});
