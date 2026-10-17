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
 *    forked list.
 */
import { DEFAULT_REDACT_PATHS } from "../logger/pino";

/** Max length of an exception message that leaves the process. */
const MAX_MESSAGE_LENGTH = 300;

/** Leaf key of every logger redact path, lower-cased (e.g. `headers.cookie` -> `cookie`). */
export const SENTRY_FORBIDDEN_KEYS: ReadonlySet<string> = new Set(
  DEFAULT_REDACT_PATHS.map((path) => {
    const leaf = path.split(".").pop() ?? path;
    return leaf.replace(/^\[?["']?/, "").replace(/["']?\]?$/, "").toLowerCase();
  }).filter((key) => key !== "*" && key.length > 0),
);

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

/**
 * One whitespace-delimited token of an exception message. Secrets are masked
 * wherever they sit in it (`token=eyJ…`, `"https://u:p@host/x?api_key=…"`):
 * URLs first (userinfo and query), then JWTs, then emails. Index scans only,
 * so the work stays linear on untrusted input.
 */
class MessageToken {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  scrubbed(): string {
    const masked = this.withoutUrl().withoutJwt();
    return masked.isEmailLike() ? "[email]" : masked.text;
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

function sanitizeMessage(value: string): string {
  const cleaned = maskPostgresRowValues(value.slice(0, MAX_SCAN_LENGTH))
    .split(/(\s+)/)
    .map((token) => new MessageToken(token).scrubbed())
    .join("");
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

function scrubTags(tags: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (typeof value === "string" && !SENTRY_FORBIDDEN_KEYS.has(key.toLowerCase())) {
      out[key] = value;
    }
  }
  return out;
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
  const release = firstEnv(env, ["SENTRY_RELEASE"]);
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
}

function buildInitOptions(config: SentryConfig): Record<string, unknown> {
  return {
    ...config,
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
    deps.sentryInit(buildInitOptions(config));
    return "initialized";
  } catch {
    deps.warn("sentry disabled: SDK initialisation failed");
    return "failed";
  }
}
