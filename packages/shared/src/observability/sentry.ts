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

const POSTGRES_KEY_DETAIL = /Key \([^)]*\)=\([^)]*\)/g;
// URLs may carry userinfo or a query string (e.g. an ERPNext call that failed);
// keep scheme + host + path, drop the rest. Runs before the email pass so
// `user:pass@host` is not left half-masked.
const URL_WITH_SECRETS = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@]*@)?([^\s/?#]+)([^\s?#]*)(?:[?#]\S*)?/gi;
// Three base64url segments, header starting `eyJ` — a JWT (Clerk session/operator tokens).
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const EMAIL_LIKE = /[^\s@()]+@[^\s@()]+\.[^\s@()]+/g;

function sanitizeMessage(value: string): string {
  const cleaned = value
    .replace(POSTGRES_KEY_DETAIL, "Key (...)=(...)")
    .replace(JWT_LIKE, "[jwt]")
    .replace(URL_WITH_SECRETS, "$1$2$3")
    .replace(EMAIL_LIKE, "[email]");
  return cleaned.length > MAX_MESSAGE_LENGTH
    ? `${cleaned.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
    : cleaned;
}

function scrubFrame(frame: SentryFrameLike): SentryFrameLike {
  const out: SentryFrameLike = {};
  if (frame.filename !== undefined) out.filename = frame.filename;
  if (frame.function !== undefined) out.function = frame.function;
  if (frame.lineno !== undefined) out.lineno = frame.lineno;
  if (frame.colno !== undefined) out.colno = frame.colno;
  if (frame.module !== undefined) out.module = frame.module;
  if (frame.in_app !== undefined) out.in_app = frame.in_app;
  return out;
}

function scrubException(entry: SentryExceptionValueLike): SentryExceptionValueLike {
  const out: SentryExceptionValueLike = {};
  if (entry.type !== undefined) out.type = entry.type;
  if (typeof entry.value === "string") out.value = sanitizeMessage(entry.value);
  if (entry.mechanism !== undefined) {
    out.mechanism = {
      ...(entry.mechanism.type !== undefined ? { type: entry.mechanism.type } : {}),
      ...(entry.mechanism.handled !== undefined ? { handled: entry.mechanism.handled } : {}),
    };
  }
  const frames = entry.stacktrace?.frames;
  if (Array.isArray(frames)) out.stacktrace = { frames: frames.map(scrubFrame) };
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

  const out: Record<string, unknown> = {};
  for (const key of SAFE_TOP_LEVEL) {
    const value = event[key];
    if (value !== undefined) out[key] = value;
  }
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

function isUsableDsn(dsn: string): boolean {
  try {
    const url = new URL(dsn);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username.length > 0 &&
      /^\/(?:.*\/)?\d+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Read Sentry settings from the environment. Returns `null` (inert) when the
 * DSN is unset, blank or malformed. Never logs or returns a bad DSN.
 */
export function resolveSentryConfig(env: NodeJS.ProcessEnv): SentryConfig | null {
  const dsn = env["SENTRY_DSN"]?.trim();
  if (!dsn || !isUsableDsn(dsn)) return null;
  const release = env["SENTRY_RELEASE"]?.trim();
  return {
    dsn,
    environment:
      env["SENTRY_ENVIRONMENT"]?.trim() || env["DEPLOYMENT_ENVIRONMENT"]?.trim() || "unknown",
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
    deps.sentryInit({
      dsn: config.dsn,
      environment: config.environment,
      ...(config.release ? { release: config.release } : {}),
      // Errors only. Traces/metrics are exported by the OpenTelemetry layer, so
      // the SDK must not set up its own OTel provider (it would fight NodeSDK)
      // nor rewrite modules at load time for span/breadcrumb integrations.
      enableOpenTelemetrySetup: false,
      enableRuntimeChannelInjection: false,
      maxBreadcrumbs: 0,
      beforeSend: scrubSentryEvent,
    });
    return "initialized";
  } catch {
    deps.warn("sentry disabled: SDK initialisation failed");
    return "failed";
  }
}
