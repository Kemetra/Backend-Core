/**
 * Sentry error export — pure, SDK-free parts (spec 037 US1).
 *
 * This module never imports `@sentry/node`. The apps (`api`, `worker`) own the
 * SDK dependency and inject `Sentry.init` here, so DSN gating, option shaping
 * and the `beforeSend` scrubber are unit-testable without a live SDK
 * (mirrors POS-Pulse's injectable `sentryInit`).
 *
 * Posture (Constitution VII / XIV):
 *  - Default-inert: no valid `SENTRY_DSN` means no SDK call and zero egress.
 *  - Errors only: no tracing, no breadcrumbs. Traces and metrics go through the
 *    existing OpenTelemetry layer, so the SDK is never asked to set up OTel.
 *  - Allowlist scrubbing: the outgoing event is rebuilt from a short list of
 *    safe fields. Request data, users, extras, contexts and breadcrumbs are
 *    dropped wholesale. Redaction keys come from the logger's
 *    `DEFAULT_REDACT_PATHS` (redaction-matrix single source of truth), not a
 *    forked list. Tags are allowlisted too (OBS-1 §1, RT-631): only contract
 *    keys survive, and the correlation ids must match their exact format.
 */
import { DEFAULT_REDACT_PATHS } from "../logger/pino";
import { getActiveTraceId } from "./correlation";
import { resolveReleaseVersion } from "./release-version";

/** Max length of an exception message that leaves the process. */
const MAX_MESSAGE_LENGTH = 300;

/** Leaf key of every logger redact path, lower-cased (e.g. `headers.cookie` -> `cookie`). */
export const SENTRY_FORBIDDEN_KEYS: ReadonlySet<string> = new Set(
  DEFAULT_REDACT_PATHS.map((path) => {
    const leaf = path.split(".").pop() ?? path;
    return leaf.replace(/^\[?["']?/, "").replace(/["']?\]?$/, "").toLowerCase();
  }).filter((key) => key !== "*" && key.length > 0),
);

/**
 * The only tag keys an event may carry (OBS-1 §1 and §2): the contract tags,
 * the bounded extras, and the two correlation ids. Never tenant, store, user,
 * device or sale ids, and no free text.
 */
export const SENTRY_ALLOWED_TAG_KEYS: ReadonlySet<string> = new Set([
  "env",
  "service",
  "version",
  "route",
  "method",
  "status",
  "status_class",
  "queue",
  "job_name",
  "error_class",
  "outcome",
  "request_id",
  "trace_id",
]);

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const INVALID_TRACE_ID = "0".repeat(32);

/** Correlation ids are kept only in their exact format, never as free text. */
const TAG_VALUE_CHECKS: Readonly<Record<string, (value: string) => boolean>> = {
  request_id: (value) => REQUEST_ID_PATTERN.test(value),
  trace_id: (value) => TRACE_ID_PATTERN.test(value) && value !== INVALID_TRACE_ID,
};

export interface SentryFrameLike {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  module?: string;
  in_app?: boolean;
  [key: string]: unknown;
}

export interface SentryExceptionValueLike {
  type?: string;
  value?: string;
  mechanism?: { type?: string; handled?: boolean; [key: string]: unknown };
  stacktrace?: { frames?: SentryFrameLike[]; [key: string]: unknown };
  [key: string]: unknown;
}

/** Structural subset of a Sentry event; only what the scrubber reads or emits. */
export interface SentryEventLike {
  event_id?: string;
  timestamp?: number;
  platform?: string;
  level?: string;
  environment?: string;
  release?: string;
  server_name?: string;
  fingerprint?: string[];
  tags?: Record<string, unknown>;
  exception?: { values?: SentryExceptionValueLike[] };
  [key: string]: unknown;
}

const SAFE_TOP_LEVEL = [
  "event_id",
  "timestamp",
  "platform",
  "level",
  "environment",
  "release",
  "server_name",
] as const;

// Bounds the work done on untrusted input before any scanning runs.
const MAX_SCAN_LENGTH = 2000;
// Postgres echoes row values after these markers ("Key (email)=(a@b.c) already
// exists.", "Failing row contains (1, a@b.c, ...)"). Values may contain
// parentheses, so everything from the marker on is masked (indexOf, no regex).
const POSTGRES_ROW_MARKERS = [
  { marker: "Key (", mask: "Key (...)=(...)" },
  { marker: "Failing row contains (", mask: "Failing row contains (...)" },
] as const;
const SCHEME_CHAR = /^[a-z0-9+.-]$/i;
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([`"`, "'", ")", "]", ",", ";", ".", ">"]);
const REDACTED = "[redacted]";
// OBS-1 §3.2 (RT-682, RT-694): characters ignored around `Bearer` and an auth-scheme word.
const WORD_WRAPPERS = `"'{[(,:)]}`;
const QUOTES = `"'`;
const IDENTIFIER_CHAR = /^[a-z0-9_-]$/i;
const ASCII_ALNUM = /^[a-z0-9]$/i;
const ASCII_DIGIT = /^\d$/;
const AUTHORIZATION_KEY = "authorization";
// After `Authorization:`, a scheme word means the credential is the word after it.
const AUTH_SCHEMES: ReadonlySet<string> = new Set(["bearer", "basic", "digest", "token", "apikey", "negotiate", "ntlm"]);
// Egyptian mobile `1[0125]` + 8 digits behind a national (`0`) or country (`20`, `0020`) prefix.
const EGYPT_MOBILE_PREFIX_BY_LENGTH: ReadonlyMap<number, string> = new Map([
  [11, "0"],
  [12, "20"],
  [14, "0020"],
]);
const EGYPT_MOBILE_OPERATORS: readonly string[] = ["10", "11", "12", "15"];
const E164_MIN_DIGITS = 8;
const E164_MAX_DIGITS = 15;
const FRAME_KEYS = ["filename", "function", "lineno", "colno", "module", "in_app"] as const;
const MECHANISM_KEYS = ["type", "handled"] as const;

/** Copy only the listed keys whose value is defined. */
function pickDefined<K extends string>(
  source: Partial<Record<K, unknown>>,
  keys: readonly K[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function maskPostgresRowValues(value: string): string {
  let out = value;
  for (const { marker, mask } of POSTGRES_ROW_MARKERS) {
    const at = out.indexOf(marker);
    if (at !== -1) out = `${out.slice(0, at)}${mask}`;
  }
  return out;
}

/** A span `[start, end)` inside one word. */
interface Span {
  start: number;
  end: number;
}

/**
 * Phone masking for one word (OBS-1 §3.2, RT-682). A maximal ASCII digit run
 * with no letter or digit on either side becomes `[phone]` when it is E.164
 * (`+` and 8-15 digits, not starting with 0; the `+` is masked too) or an
 * Egyptian mobile. One pass over the word.
 */
class PhoneMasker {
  private readonly word: string;

  constructor(word: string) {
    this.word = word;
  }

  masked(): string {
    const out: string[] = [];
    let at = 0;
    while (at < this.word.length) {
      const run = this.digitRun({ start: at, end: at });
      if (run.end === at) {
        out.push(this.word.charAt(at++));
        continue;
      }
      const kind = this.phoneKind(run);
      if (kind === "e164") out.pop();
      out.push(kind === null ? this.word.slice(run.start, run.end) : "[phone]");
      at = run.end;
    }
    return out.join("");
  }

  /** `from` grown over the maximal digit run at its end; unchanged when no digit is there. */
  private digitRun(from: Span): Span {
    let end = from.end;
    while (ASCII_DIGIT.test(this.word.charAt(end))) end++;
    return { start: from.start, end };
  }

  /** Verdict for one digit run: `e164`, `national` or not a phone. */
  private phoneKind(run: Span): "e164" | "national" | null {
    const before = this.word.charAt(run.start - 1);
    const plusBefore = this.word.charAt(run.start - 2);
    if (ASCII_ALNUM.test(this.word.charAt(run.end))) return null;
    if (before === "+" && !ASCII_ALNUM.test(plusBefore) && this.isE164(run)) return "e164";
    return !ASCII_ALNUM.test(before) && this.isEgyptianMobile(run) ? "national" : null;
  }

  /** 8-15 digits, not starting with 0 (the `+` is checked by the caller). */
  private isE164({ start, end }: Span): boolean {
    const digits = end - start;
    return this.word.charAt(start) !== "0" && digits >= E164_MIN_DIGITS && digits <= E164_MAX_DIGITS;
  }

  /** `0`, `20` or `0020`, then `1[0125]` and 8 more digits. */
  private isEgyptianMobile({ start, end }: Span): boolean {
    const run = this.word.slice(start, end);
    const prefix = EGYPT_MOBILE_PREFIX_BY_LENGTH.get(run.length);
    if (prefix === undefined || !run.startsWith(prefix)) return false;
    return EGYPT_MOBILE_OPERATORS.includes(run.slice(prefix.length, prefix.length + 2));
  }
}

/**
 * How to treat the word after this one (OBS-1 §3.2): scrub it as usual, mask it
 * as a credential, or (after a bare `Authorization` key, RT-694) take a leading
 * `:`/`=` in it as that key's separator.
 */
type NextWord = "scrub" | "mask" | "authorizationSeparator";

/** A scrubbed word, and how to treat the word after it. */
interface ScrubbedWord {
  text: string;
  next: NextWord;
}

/**
 * One whitespace-delimited token of an exception message. Secrets are masked
 * wherever they sit in it (`token=eyJ…`, `"https://u:p@host/x?api_key=…"`):
 * `Bearer` first, then URLs (userinfo and query), `Authorization` values,
 * JWTs, emails and phones. Index scans only, so the work stays linear on
 * untrusted input.
 */
class MessageToken {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  scrubbed(): ScrubbedWord {
    if (this.unwrapped() === "bearer") return { text: REDACTED, next: "mask" };
    const url = this.withoutUrl();
    const authorization = url.maskedAuthorization();
    // The rest of the word (the part before `authorization=`) still gets the JWT/email/phone masks.
    const masked = (authorization ? new MessageToken(authorization.text) : url).withoutJwt();
    const text = masked.isEmailLike() ? "[email]" : new PhoneMasker(masked.text).masked();
    return { text, next: authorization?.next ?? this.nextAfterKey() };
  }

  /**
   * The word after a bare `Authorization` key (`Authorization : Basic x`,
   * RT-694): a leading `:` or `=` is that key's separator, so the rest of the
   * word is its value. `null` when the word does not start with one.
   */
  separatedValue(): ScrubbedWord | null {
    const first = { start: 0, end: 1 };
    return this.isSeparator(first) ? this.valueAfter(first) : null;
  }

  /** A word ending in an `Authorization` key, quotes ignored, waits for a separator word. */
  private nextAfterKey(): NextWord {
    const key = this.keyBefore({ start: this.text.length, end: this.text.length });
    return key.endsWith(AUTHORIZATION_KEY) ? "authorizationSeparator" : "scrub";
  }

  /**
   * `Authorization:<value>` / `"authorization":` / `headers.authorization=`:
   * the value is masked, or the next word when the value is empty. A scheme
   * value (`Bearer`) means the credential is the next word.
   */
  private maskedAuthorization(): ScrubbedWord | null {
    for (let sep = 0; sep < this.text.length; sep++) {
      const at = { start: sep, end: sep + 1 };
      if (this.isAuthorizationSeparator(at)) return this.valueAfter(at);
    }
    return null;
  }

  /** The value after the separator `sep` masked, or the next word when it is empty. */
  private valueAfter(sep: Span): ScrubbedWord {
    const value = new MessageToken(this.text.slice(sep.end));
    if (value.text === "") return { text: this.text, next: "mask" };
    return { text: `${this.text.slice(0, sep.end)}${REDACTED}`, next: value.isAuthScheme() ? "mask" : "scrub" };
  }

  /** An auth-scheme word (`Bearer`, `'Basic`), which means the credential is the next word. */
  isAuthScheme(): boolean {
    return AUTH_SCHEMES.has(this.unwrapped());
  }

  /** Lower-cased, without the wrapper characters around it (`'Bearer` -> `bearer`). */
  private unwrapped(): string {
    let start = 0;
    let end = this.text.length;
    while (start < end && WORD_WRAPPERS.includes(this.text.charAt(start))) start++;
    while (end > start && WORD_WRAPPERS.includes(this.text.charAt(end - 1))) end--;
    return this.text.slice(start, end).toLowerCase();
  }

  /** A `:` or `=` whose key ends in `authorization` (`Proxy-Authorization:`, `"authorization":`). */
  private isAuthorizationSeparator(sep: Span): boolean {
    return this.isSeparator(sep) && this.keyBefore(sep).endsWith(AUTHORIZATION_KEY);
  }

  private isSeparator(sep: Span): boolean {
    const char = this.text.charAt(sep.start);
    return char === ":" || char === "=";
  }

  /** Lower-cased identifier ending at `sep`, skipping quotes. Stops at the previous separator. */
  private keyBefore(sep: Span): string {
    let end = sep.start;
    while (end > 0 && QUOTES.includes(this.text.charAt(end - 1))) end--;
    let start = end;
    while (start > 0 && IDENTIFIER_CHAR.test(this.text.charAt(start - 1))) start--;
    return this.text.slice(start, end).toLowerCase();
  }

  /** Keep scheme + host + path; drop userinfo, query, fragment. Unparsable -> `[url]`. */
  private withoutUrl(): MessageToken {
    const sep = this.text.indexOf("://");
    const start = sep > 0 ? this.schemeStart(sep) : sep;
    if (start < 0 || start === sep) return this;
    const raw = this.text.slice(start);
    const end = new MessageToken(raw).bodyLength();
    const url = parseUrl(raw.slice(0, end));
    const safe = url ? `${url.protocol}//${url.host}${url.pathname}` : "[url]";
    return new MessageToken(`${this.text.slice(0, start)}${safe}${raw.slice(end)}`);
  }

  /** Mask a JWT (Clerk session/operator token) and everything after it. */
  private withoutJwt(): MessageToken {
    const at = this.text.indexOf("eyJ");
    if (at === -1 || this.text.slice(at).split(".").length < 3) return this;
    return new MessageToken(`${this.text.slice(0, at)}[jwt]`);
  }

  private isEmailLike(): boolean {
    const at = this.text.indexOf("@");
    return at > 0 && this.text.includes(".", at);
  }

  /** Index where the URL scheme ending at `sep` (the `://`) starts. */
  private schemeStart(sep: number): number {
    let start = sep;
    while (start > 0 && SCHEME_CHAR.test(this.text.charAt(start - 1))) start--;
    return start;
  }

  /** Length without trailing quotes/brackets/punctuation. */
  private bodyLength(): number {
    let end = this.text.length;
    while (end > 0 && TRAILING_PUNCTUATION.has(this.text.charAt(end - 1))) end--;
    return end;
  }
}

const NEXT_WORD_RANK: Readonly<Record<NextWord, number>> = { scrub: 0, authorizationSeparator: 1, mask: 2 };

/** The stricter of two next-word states (mask, then separator, then scrub). */
function stricter(a: NextWord, b: NextWord): NextWord {
  return NEXT_WORD_RANK[a] >= NEXT_WORD_RANK[b] ? a : b;
}

/**
 * One word, scrubbed as the word before it asks (`next`). A word masked or read
 * as a separator value still passes on its own signal (`[Bearer] Authorization: x`,
 * `Authorization :a,authorization= x`), so nothing is masked less than before.
 */
function scrubWord(token: MessageToken, next: NextWord): ScrubbedWord {
  if (next === "mask") return { text: REDACTED, next: token.isAuthScheme() ? "mask" : token.scrubbed().next };
  const separated = next === "authorizationSeparator" ? token.separatedValue() : null;
  if (separated === null) return token.scrubbed();
  return { text: separated.text, next: stricter(separated.next, token.scrubbed().next) };
}

/**
 * Scrub each word, carrying one "next word" state across words (`Bearer <x>`,
 * `Authorization: Basic <x>`, `Authorization : <x>`). Whitespace passes through.
 */
function scrubWords(parts: readonly string[]): string {
  let next: NextWord = "scrub";
  const out: string[] = [];
  for (const part of parts) {
    if (part.trim() === "") {
      out.push(part);
    } else {
      const word = scrubWord(new MessageToken(part), next);
      next = word.next;
      out.push(word.text);
    }
  }
  return out.join("");
}

function sanitizeMessage(value: string): string {
  const cleaned = scrubWords(maskPostgresRowValues(value.slice(0, MAX_SCAN_LENGTH)).split(/(\s+)/));
  return cleaned.length > MAX_MESSAGE_LENGTH
    ? `${cleaned.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
    : cleaned;
}

function scrubException(entry: SentryExceptionValueLike): SentryExceptionValueLike {
  const out: SentryExceptionValueLike = pickDefined(entry, ["type"]);
  if (typeof entry.value === "string") out.value = sanitizeMessage(entry.value);
  if (entry.mechanism !== undefined) out.mechanism = pickDefined(entry.mechanism, MECHANISM_KEYS);
  const frames = entry.stacktrace?.frames;
  if (Array.isArray(frames)) {
    out.stacktrace = { frames: frames.map((frame) => pickDefined(frame, FRAME_KEYS)) };
  }
  return out;
}

function isAllowedTag(key: string, value: unknown): value is string {
  if (typeof value !== "string" || !SENTRY_ALLOWED_TAG_KEYS.has(key)) return false;
  return TAG_VALUE_CHECKS[key]?.(value) ?? true;
}

function scrubTags(tags: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (isAllowedTag(key, value)) out[key] = value;
  }
  return out;
}

/**
 * Correlation tags for one captured error (OBS-1 §2): the caller's
 * `request_id` (when well-formed) and the active OTel `trace_id` (when a
 * span is active). Read at the capture site, so they belong to the request
 * that failed, then re-checked by the scrubber.
 */
export function sentryCorrelationTags(requestId: string | undefined): Record<string, string> {
  const tags: Record<string, string> = {};
  if (requestId !== undefined && isAllowedTag("request_id", requestId)) {
    tags["request_id"] = requestId;
  }
  const traceId = getActiveTraceId();
  if (traceId !== undefined) tags["trace_id"] = traceId;
  return tags;
}

/**
 * `beforeSend` hook: rebuild the event from allowlisted fields only, or return
 * `null` (drop) when it carries no exception. Pure; does not mutate its input.
 */
export function scrubSentryEvent(event: SentryEventLike): SentryEventLike | null {
  const values = event.exception?.values;
  if (!Array.isArray(values) || values.length === 0) return null;

  const out = pickDefined(event, SAFE_TOP_LEVEL);
  const tags = scrubTags(event.tags);
  if (Object.keys(tags).length > 0) out["tags"] = tags;
  out["exception"] = { values: values.map(scrubException) };
  return out as SentryEventLike;
}

export interface SentryConfig {
  dsn: string;
  environment: string;
  release?: string;
}

const DSN_PROTOCOLS: ReadonlySet<string> = new Set(["https:", "http:"]);

/** A DSN carries a public key (username) and ends in a numeric project id. */
function hasDsnShape(url: URL): boolean {
  const projectId = url.pathname.split("/").pop() ?? "";
  return url.username.length > 0 && /^\d+$/.test(projectId);
}

function isUsableDsn(dsn: string): boolean {
  const url = parseUrl(dsn);
  return url !== null && DSN_PROTOCOLS.has(url.protocol) && hasDsnShape(url);
}

/** First env value, among `keys`, that is non-blank after trimming. */
function firstEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Read Sentry settings from the environment. Returns `null` (inert) when the
 * DSN is unset, blank or malformed. Never logs or returns a bad DSN.
 */
export function resolveSentryConfig(env: NodeJS.ProcessEnv): SentryConfig | null {
  const dsn = firstEnv(env, ["SENTRY_DSN"]);
  if (!dsn || !isUsableDsn(dsn)) return null;
  const release = resolveReleaseVersion(env);
  return {
    dsn,
    environment: firstEnv(env, ["SENTRY_ENVIRONMENT", "DEPLOYMENT_ENVIRONMENT"]) ?? "unknown",
    ...(release ? { release } : {}),
  };
}

export type SentryInitResult = "disabled" | "initialized" | "failed";

export interface SentryInitDeps {
  /** `Sentry.init` from `@sentry/node`, injected by the app. */
  sentryInit: (options: Record<string, unknown>) => unknown;
  /** One-line diagnostics; must never receive the DSN. */
  warn: (message: string) => void;
  /** Contract `service` tag (OBS-1 §1): `backend-api` or `backend-worker`. */
  service: string;
}

function buildInitOptions(config: SentryConfig, service: string): Record<string, unknown> {
  const tags: Record<string, string> = { service };
  if (config.release) tags["version"] = config.release;
  return {
    ...config,
    initialScope: { tags },
    // Errors only. Traces/metrics are exported by the OpenTelemetry layer, so
    // the SDK must not set up its own OTel provider (it would fight NodeSDK)
    // nor rewrite modules at load time for span/breadcrumb integrations.
    enableOpenTelemetrySetup: false,
    enableRuntimeChannelInjection: false,
    maxBreadcrumbs: 0,
    beforeSend: scrubSentryEvent,
  };
}

/**
 * Initialise Sentry for errors only. Never throws and never blocks boot:
 * a missing/blank DSN is silent, a malformed DSN or SDK failure logs one warn.
 */
export function initSentry(env: NodeJS.ProcessEnv, deps: SentryInitDeps): SentryInitResult {
  const raw = env["SENTRY_DSN"]?.trim();
  if (!raw) return "disabled";

  const config = resolveSentryConfig(env);
  if (!config) {
    deps.warn("sentry disabled: SENTRY_DSN is not a valid DSN");
    return "disabled";
  }

  try {
    deps.sentryInit(buildInitOptions(config, deps.service));
    return "initialized";
  } catch {
    deps.warn("sentry disabled: SDK initialisation failed");
    return "failed";
  }
}
