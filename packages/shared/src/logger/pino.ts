import { pino, type Logger, type LoggerOptions } from "pino";

// Re-export so consumers (e.g. apps/api) can type their handles to a Logger
// without taking a direct dependency on pino. The shared package is the
// canonical facade for logging.
export type { Logger } from "pino";

export const LOG_SCHEMA_VERSION = "1";

/**
 * Logger-boundary redaction list — single source of truth.
 *
 * Mirrors `.specify/memory/redaction-matrix.md` (P3 / T440) and is wired
 * by P4 / T473. Add-only by default (FR-B-005): a field cannot move
 * `down` the sensitivity ladder without an explicit matrix amendment.
 *
 * Three classes contribute paths here:
 *  1. Credentials (matrix §3.1) — passwords, tokens, cookies, API keys,
 *     DB/Redis/queue DSNs, webhook keys, idempotency keys.
 *  2. PII (matrix §3.2) — direct identifiers tied to a natural person.
 *  3. PII-suspect (matrix §3.3) — full request/response bodies and free-
 *     text user-supplied fields are dropped wholesale by the per-emit-site
 *     serializers in `redaction.serializers.ts`; we do not list every
 *     possible body shape here.
 *
 * Pino's `redact.paths` matcher supports `*` as a single-segment wildcard
 * and dotted notation; bracketed paths quote keys with non-identifier
 * characters (e.g. `headers["set-cookie"]`).
 */
export const DEFAULT_REDACT_PATHS: readonly string[] = [
  // ---- Credentials (matrix §3.1) ----
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  'headers["x-api-key"]',
  "password",
  "password_hash",
  "passwordHash",
  "token",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "session_token",
  "sessionToken",
  "api_key",
  "apiKey",
  "secret",
  "credential",
  "credentials",
  "invitation_token",
  "invitationToken",
  "password_reset_token",
  "passwordResetToken",
  "email_verification_token",
  "emailVerificationToken",
  "idempotency_key",
  "idempotencyKey",
  "device_token_attestation",
  "deviceTokenAttestation",
  "pairing_code",
  "pairingCode",
  "device_token",
  "deviceToken",
  "webhook_signing_key",
  "webhookSigningKey",
  "database_url",
  "DATABASE_URL",
  "redis_url",
  "REDIS_URL",
  "*.password",
  "*.password_hash",
  "*.passwordHash",
  "*.token",
  "*.access_token",
  "*.accessToken",
  "*.refresh_token",
  "*.refreshToken",
  "*.secret",
  "*.credential",
  "*.credentials",
  "*.api_key",
  "*.apiKey",
  "*.idempotency_key",
  "*.idempotencyKey",
  "*.device_token_attestation",
  "*.deviceTokenAttestation",
  "*.pairing_code",
  "*.pairingCode",
  "*.device_token",
  "*.deviceToken",
  // ---- PII (matrix §3.2) ----
  "email",
  "email_address",
  "emailAddress",
  "user_email",
  "userEmail",
  "phone",
  "phone_number",
  "phoneNumber",
  "mobile",
  "whatsapp_number",
  "whatsappNumber",
  "full_name",
  "fullName",
  "given_name",
  "givenName",
  "family_name",
  "familyName",
  "display_name",
  "displayName",
  "date_of_birth",
  "dateOfBirth",
  "dob",
  "national_id",
  "nationalId",
  "passport_number",
  "passportNumber",
  "tax_id",
  "taxId",
  "ip_address",
  "ipAddress",
  "client_ip",
  "clientIp",
  "pan_last4",
  "panLast4",
  "card_brand",
  "cardBrand",
  "*.email",
  "*.phone",
  "*.full_name",
  "*.fullName",
  "*.given_name",
  "*.givenName",
  "*.family_name",
  "*.familyName",
  "*.display_name",
  "*.displayName",
  "*.date_of_birth",
  "*.dateOfBirth",
  "*.national_id",
  "*.nationalId",
  "*.ip_address",
  "*.ipAddress",
  // ---- PII nested deeper than one segment (T565 / matrix §4.3 amendment) ----
  // Pino's `*` wildcard matches exactly one path segment — so `*.email`
  // covers `payload.email` but NOT `payload.metadata.email`. These explicit
  // two-segment paths close the audit-envelope gap surfaced by
  // apps/worker/test/outbox/redaction.spec.ts (suite RD-4). The `*.X.Y`
  // forms are defensive — they catch the case where a future call site
  // binds the envelope under a different one-segment-prefix key
  // (e.g., `{ event: { metadata: { email } } }`).
  "actor_label",
  "*.actor_label",
  "payload.metadata.email",
  "payload.metadata.phone",
  "payload.metadata.full_name",
  "payload.metadata.note",
  "*.metadata.email",
  "*.metadata.phone",
  "*.metadata.full_name",
  "*.metadata.note",
  // ---- PII-suspect (matrix §3.3) ----
  // Full request/response bodies are dropped by the per-emit-site
  // serializer for `req`/`res`/`err`, not redacted path-by-path here.
  // We additionally redact `body` and `payload.body` at common binding
  // points so a future call site logging `{ payload: { body } }` cannot
  // bypass the serializer. (Pino's `*` matches one segment only; we
  // enumerate the common shapes explicitly.)
  "body",
  "req.body",
  "res.body",
  "request.body",
  "response.body",
  "payload.body",
  "payload.request",
  "payload.response",
  "*.body",
  // Free-text PII-suspect fields — matrix §3.3. Enumerated at top level
  // and via single-segment wildcards; the wildcard matches `event.note`
  // but not `event.user.note` — deeper free-text emissions should reach
  // the boundary via a `req`/`res`/`err` serializer or be added here.
  "note",
  "comment",
  "description",
  "feedback",
  "*.note",
  "*.comment",
  "*.description",
  "*.feedback",
];

export interface CreateLoggerOptions {
  /** Service / app name written into every line as `service`. */
  service: string;
  /** Defaults to `process.env.LOG_LEVEL` or `"info"`. */
  level?: LoggerOptions["level"];
  /** Additional redact paths merged with the defaults. */
  redactPaths?: readonly string[];
  /** Pretty-print to a TTY (dev only); ignored in production. */
  pretty?: boolean;
  /** Bindings to attach to the root logger. */
  bindings?: Record<string, unknown>;
  /**
   * Optional stream destination. Tests pass a memory stream here to capture
   * rendered output; production calls leave it undefined and pino writes to
   * `process.stdout`. Accepts pino's standard `DestinationStream` shape
   * (an object with a `write(msg: string): void` method).
   */
  destination?: { write(msg: string): void };
}

/**
 * Per-emit-site object serializers — logger-boundary redaction for the
 * commonly-bound keys `req`, `res`, and `err`. Pino runs these whenever
 * a log call binds the corresponding key (e.g., `logger.info({ req }, ...)`)
 * and replaces the value with the serializer's return shape BEFORE the
 * `redact` paths are applied.
 *
 * Why both serializers AND `redact.paths`:
 *   - Serializers shape complex objects into safe envelopes (drop bodies,
 *     keep route+method+status, etc.). They are the WHOLESALE redactor.
 *   - `redact.paths` catches stray PII / credentials that survive a
 *     serializer (e.g., a custom binding like `{ user: { email } }`). They
 *     are the SCATTERED-FIELD redactor.
 * Together they implement FR-B-005 ("redact at the logger boundary").
 */
const BOUNDARY_SERIALIZERS: NonNullable<LoggerOptions["serializers"]> = {
  req: (req: unknown): unknown => {
    if (req === null || typeof req !== "object") return req;
    const r = req as Record<string, unknown>;
    const headers = r["headers"] as Record<string, unknown> | undefined;
    return {
      method: r["method"] ?? null,
      // Prefer the route TEMPLATE (`/v1/tenants/:tenant_id`) over the
      // rendered URL when Nest has populated it; rendered URLs carry
      // tenant IDs and are PII-adjacent (FR-B-006 forbids them as labels;
      // matrix §3.4 keeps them out of logs by default too).
      route: r["route"] ?? r["originalUrl"] ?? r["url"] ?? null,
      // Headers are summarized to a single safe count — never emitted in
      // full. The redact.paths catches the named credential headers in
      // case any consumer overrides this serializer (defense in depth).
      headers_count: headers ? Object.keys(headers).length : 0,
      // Bodies are NEVER serialized. The redact.paths above also covers
      // `req.body` as a tripwire.
    };
  },
  res: (res: unknown): unknown => {
    if (res === null || typeof res !== "object") return res;
    const r = res as Record<string, unknown>;
    return {
      status: r["statusCode"] ?? r["status"] ?? null,
      // No body. Ever.
    };
  },
  err: (err: unknown): unknown => {
    if (err === null || typeof err !== "object") return err;
    const e = err as Record<string, unknown>;
    // Default pino err serializer behavior, minus any payload echo. We
    // emit the class name, a sanitized message, and the stack — but NOT
    // any custom enumerable properties (which might hold PII attached
    // to a thrown error).
    return {
      type: e["name"] ?? (e["constructor"] as { name?: string } | undefined)?.name ?? "Error",
      message: typeof e["message"] === "string" ? e["message"] : "[non-string message redacted]",
      stack: e["stack"] ?? null,
    };
  },
};

export function createLogger(opts: CreateLoggerOptions): Logger {
  const redactPaths = mergeRedactPaths(DEFAULT_REDACT_PATHS, opts.redactPaths);
  const level = opts.level ?? process.env["LOG_LEVEL"] ?? "info";

  const baseBindings: Record<string, unknown> = {
    service: opts.service,
    log_schema_version: LOG_SCHEMA_VERSION,
    ...(opts.bindings ?? {}),
  };

  const options: LoggerOptions = {
    level,
    base: baseBindings,
    redact: {
      paths: [...redactPaths],
      censor: "[REDACTED]",
      remove: false,
    },
    serializers: BOUNDARY_SERIALIZERS,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    messageKey: "message",
  };

  if (opts.pretty && process.stdout.isTTY) {
    options.transport = {
      target: "pino-pretty",
      options: { colorize: true, singleLine: true },
    };
  }

  // pino's first arg can be options OR (options, destination). When tests
  // pass a destination, route logs through it for capture.
  return opts.destination ? pino(options, opts.destination) : pino(options);
}

export interface RequestContext {
  request_id: string;
  tenant_id?: string | null;
  user_id?: string | null;
  store_id?: string | null;
  /**
   * Subject identifier when the request is authenticated. Distinct from
   * `user_id` only by audit/auth conventions (matrix §3.4) — both fields
   * are sourced from `request.principal?.userId` and may be populated
   * simultaneously by audit-relevant code paths. Optional; null when
   * absent (pre-auth, anonymous).
   */
  actor_id?: string | null;
  /**
   * End-to-end trace identifier. For HTTP requests this defaults to the
   * `request_id` when no OTel trace context is active; for worker jobs
   * it carries the W3C `traceparent.traceId` extracted from the BullMQ
   * job carrier. Required field per FR-B-004 — `withRequestContext`
   * always emits it (falling back to `request_id` if the caller omits it).
   */
  correlation_id?: string | null;
}

/**
 * Per-request child logger. Every log line emitted from the returned logger
 * carries the FR-B-004 structured-log fields:
 *   - `request_id` (always)
 *   - `tenant_id` (null when not established)
 *   - `store_id`  (null when not established)
 *   - `user_id`   (null when unauthenticated)
 *   - `actor_id`  (null when unauthenticated; defaults to `user_id` when
 *                  the caller hasn't set it explicitly so audit-style
 *                  logging sees a populated field)
 *   - `correlation_id` (defaults to `request_id` when no async trace
 *                       context is available)
 */
export function withRequestContext(
  logger: Logger,
  ctx: RequestContext,
): Logger {
  const userId = ctx.user_id ?? null;
  return logger.child({
    request_id: ctx.request_id,
    tenant_id: ctx.tenant_id ?? null,
    user_id: userId,
    store_id: ctx.store_id ?? null,
    actor_id: ctx.actor_id !== undefined ? ctx.actor_id : userId,
    correlation_id:
      ctx.correlation_id !== undefined && ctx.correlation_id !== null
        ? ctx.correlation_id
        : ctx.request_id,
  });
}

function mergeRedactPaths(
  defaults: readonly string[],
  extra: readonly string[] | undefined,
): readonly string[] {
  if (!extra || extra.length === 0) return defaults;
  const seen = new Set<string>(defaults);
  for (const p of extra) seen.add(p);
  return Array.from(seen);
}
