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

// Bounds regex work on untrusted input before any pattern runs.
const MAX_SCAN_LENGTH = 2000;
// `[^()]` (not `[^)]`) keeps each match attempt from rescanning past the next
// `(`, so a string full of `Key (` stays linear.
const POSTGRES_KEY_DETAIL = /Key \([^()]*\)=\([^()]*\)/g;
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

/** Keep scheme + host + path of a URL token; drop userinfo, query and fragment. */
function stripUrlSecrets(token: string): string | null {
  if (!token.includes("://")) return null;
  const url = parseUrl(token);
  return url ? `${url.protocol}//${url.host}${url.pathname}` : null;
}

function isJwtLike(token: string): boolean {
  return token.startsWith("eyJ") && token.split(".").length >= 3;
}

function isEmailLike(token: string): boolean {
  const at = token.indexOf("@");
  return at > 0 && token.includes(".", at);
}

/**
 * Mask one whitespace-delimited token: a JWT (Clerk session/operator tokens),
 * a URL carrying userinfo or a query string (e.g. a failed ERPNext call), or an
 * email. Token-wise checks avoid backtracking-heavy patterns on library input.
 */
function scrubToken(token: string): string {
  if (isJwtLike(token)) return "[jwt]";
  const url = stripUrlSecrets(token);
  if (url !== null) return url;
  return isEmailLike(token) ? "[email]" : token;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function sanitizeMessage(value: string): string {
  const cleaned = value
    .slice(0, MAX_SCAN_LENGTH)
    .replace(POSTGRES_KEY_DETAIL, "Key (...)=(...)")
    .split(/(\s+)/)
    .map(scrubToken)
    .join("");
  return truncate(cleaned, MAX_MESSAGE_LENGTH);
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
