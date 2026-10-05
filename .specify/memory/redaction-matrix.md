# Redaction Matrix: Platform-Wide Logger Boundary Policy

**Ref**: 004-platform-production-readiness (T440)
**Author**: Track B Observability owner
**Date**: 2026-05-16
**Constitution**: v3.0.0
**Scope**: Cross-cutting redaction policy for **all** log-emitting code paths in
Data-Pulse-2 (API, worker, audit emitter, future outbox drainer, idempotency
interceptor, ingestion adapters). Referenced by every Track of feature 004 and
by every future feature that emits logs.

---

## Changelog

- **2026-10-05** — RT-216 amendment. Classifies four log fields emitted by the
  worker's ERPNext posting-reversal logs (`posting.reversal.deferred`, RT-173;
  `posting.reversal.dead_lettered`, RT-207) as **business** in §3.4: `sale_id`,
  `source_ref_id`, `attempts` and `event`. They are opaque identifiers, a
  retry counter and a fixed event name, with no PII. signals.md §4 requires
  every non-default log field to be classified here. Add-only per FR-B-005;
  no existing field reclassified, no redaction rule removed.
- **2026-05-21** — T565 amendment (004 P7 Track C). Adds `actor_label` to the
  PII §3.2 table (audit job payloads carry it as a free-text identifier
  substitute when no `actor_user_id` is present — same protection level as
  `email` / `phone` / `full_name`). Adds §4.3 "Pino wildcard depth and
  worker outbox envelope paths" documenting the single-segment-`*` limit
  and enumerating the explicit two-segment paths needed to redact
  `payload.metadata.{email,phone,full_name,note}` in outbox log lines.
  Add-only per FR-B-005; no existing field reclassified.
- **2026-05-16** — Initial matrix (004-T440). Source: spec §7.6, plan §3.2.2,
  research §11. Single source of truth for redaction at the logger boundary
  (FR-B-005, FR-B-011). Authored as planning artifact; no instrumentation
  enabled by this entry.

> **Add-only by default (FR-B-005, Principle XIV).** Adding a sensitive
> field or a new redaction class to this matrix is a documentation change
> reviewable as a single artifact. **Removing** a redaction rule (i.e.,
> "this field is now safe to log") is a change-proposal PR per Constitution
> §VIII (Reproducible & Versioned Releases) — it requires explicit reviewer
> approval, a written justification, and a sweep of existing dashboards /
> alerts that may depend on the redacted field's absence. Silent removal is
> a review-blocking defect. "I'll remember to redact at the call site" is
> not a substitute for an entry here (FR-B-005, §7.6).

---

## 1. Constitution alignment

This matrix operationalizes:

- **Principle VII — Observable Systems**: structured logs MUST NOT contain
  secrets, tokens, PII, or full payloads (constitution v3.0.0 §VII).
- **Principle XIV — PII & Data Lifecycle Discipline**: logger-boundary
  redaction is mandatory; classification drives logging, retention, export,
  and right-to-erasure (constitution v3.0.0 §XIV).
- **FR-B-005**: logs MUST honor every redaction constraint in spec §7.6.
- **FR-B-011**: redaction policy MUST be documented in a single reviewable
  artifact and MUST be the single source of truth.

---

## 2. Scope

This artifact governs every log line emitted by every process in the
Data-Pulse-2 monorepo (API, workers, scheduled jobs, future outbox drainer,
future idempotency interceptor, future POS ingestion adapters). Logger
boundaries include `pino` transports, OpenTelemetry log exporters, and any
future log shipper. **Call-site redaction is not permitted as the primary
control** (spec §7.6, FR-B-005).

Out of scope for *this* artifact: response-body shaping (handled by the
uniform error envelope per Constitution §III), audit-record contents
(handled by the audit pipeline's own classification rules, which defer to
this matrix for any field whose classification appears below).

---

## 3. Data Classification

Every field that may be encountered in a log statement falls into one of:

**PII** · **payment** · **business** · **public** · **credential** ·
**PII-suspect** (treat as PII until field-level review reclassifies it).

### 3.1 Credentials (MUST NOT log, ever)

| Field / property | Classification | Rationale |
|---|---|---|
| `password` (raw) | credential | User secret; never crosses the logger boundary regardless of transport. |
| `password_hash` | credential | Hash exposure enables offline attack; treated as a secret per spec §7.6. |
| `access_token`, `bearer_token`, `Authorization` header value | credential | Bearer credential for the API and POS surfaces. |
| `refresh_token` | credential | Long-lived; refresh-token leak is account takeover. |
| `api_key`, `x-api-key` header value | credential | Service-to-service credential. |
| `Cookie` header (session cookie values), `session_id` cookie value | credential | Session bearer; equivalent to a bearer token at the cookie boundary. |
| Database credentials (`DATABASE_URL`, password fragment of any DSN) | credential | Operational secret. |
| Redis credentials (`REDIS_URL`, password fragment) | credential | Operational secret. |
| Queue credentials (BullMQ Redis URL with password, AMQP DSN if introduced) | credential | Operational secret. |
| Webhook signing keys (`WEBHOOK_SIGNING_KEY`, HMAC secret) | credential | Forgery key for inbound/outbound webhooks. |
| `invitation_token`, `password_reset_token`, `email_verification_token` | credential | One-time secrets. |
| `idempotency_key` (raw client-supplied value) | credential | Client correlator that, combined with payload guesses, allows replay probing — log a fingerprint, never the raw key. |

### 3.2 PII (MUST NOT log without field-level review)

| Field / property | Classification | Rationale |
|---|---|---|
| `email`, `email_address`, `user_email` | PII | Direct identifier (spec §7.6). |
| `phone`, `phone_number`, `mobile`, `whatsapp_number` | PII | Direct identifier. |
| `address`, `street`, `city`, `postal_code`, `region`, `country` (when tied to a natural person) | PII | Location-tied identifier. |
| `full_name`, `name`, `given_name`, `family_name`, `middle_name`, `display_name` | PII | Direct identifier. |
| `date_of_birth`, `dob` | PII | Quasi-identifier (combines to direct ID). |
| `national_id`, `passport_number`, `tax_id` | PII | Government identifier; treat as PII-credential hybrid. |
| `ip_address`, `client_ip`, `x-forwarded-for` value | PII | Identifier under most privacy regimes; log only at the gateway boundary and only with documented retention. |
| Customer payment card metadata (`pan_last4`, `card_brand`) | payment · PII | Payment-class field; masking required at the call site is **not** sufficient — defer to the field-level redaction column below. |
| `actor_label` | PII | Human-readable identifier substitute on audit job payloads (used when no `actor_user_id` exists — see `apps/api/src/audit/audit-job.types.ts` and the audit schema's `actor_label` column). May carry email, phone, or full name verbatim; treated at the same level as direct PII identifiers. Added by T565 (P7 Track C) amendment. |

### 3.3 PII-suspect (treat as PII by default)

| Field / property | Classification | Rationale |
|---|---|---|
| Full request body (any HTTP method body) | PII-suspect | A request body may contain any PII field above (spec §7.6); the logger MUST NOT serialize full request bodies by default. Structured field-by-field logging is allowed **only after** explicit field-level redaction review. |
| Full response body | PII-suspect | Same rationale — response bodies often include the user's profile, membership list, etc. |
| Free-text fields supplied by users (`note`, `comment`, `description`, `feedback`) | PII-suspect | May contain incidental PII; log length / hash only, never raw content, until reclassified. |
| Outbox event `payload` field (future, Track C) | PII-suspect | Per FR-C-008, payloads may not be logged in full; consumers redact at the logger boundary using this matrix. |
| Validation error context (the rejected value) | PII-suspect | "Why this body failed validation" must NOT echo the raw rejected value; log the field path and rule, not the value. |

### 3.4 Business (safe to log)

| Field / property | Classification | Rationale |
|---|---|---|
| `tenant_id` | business | Not a secret; required for support and debugging (FR-B-004). Note: never a **metric label** (FR-B-006), but always a **log field** when established. |
| `store_id` | business | Same rationale as `tenant_id`. |
| `correlation_id` | business | End-to-end trace identifier; required field per FR-B-004. |
| `request_id` | business | Per-request identifier; required field per FR-B-004. |
| `actor_id`, `user_id` (the **subject** identifier, not the human's email) | business | Internal identifier; not a metric label, but loggable. |
| `event_id` (outbox / audit) | business | Stable dedup key; safe. |
| `route`, `method`, `status_class` | business | HTTP shape; safe. |
| `job_name`, `queue_name`, `event_type` | business | Operational; safe. |
| `error_class` (the *class* name, not the message) | business | Safe; message may be PII-suspect and is redacted separately. |
| `sale_id` | business | Opaque sale identifier (UUID); no PII. Log field only, never a metric label. Added by RT-216. |
| `source_ref_id` | business | Opaque identifier of the source record a posting row comes from (the sale, or the void / refund / return for a reversal); UUID, no PII. Log field only, never a metric label. Added by RT-216. |
| `attempts` | business | Delivery-attempt counter of an outbox event or job; an integer, no PII. Added by RT-216. |
| `event` | business | Fixed, code-defined log event name (e.g. `posting.reversal.deferred`); never user input, no PII. Added by RT-216. |

### 3.5 Public

| Field / property | Classification | Rationale |
|---|---|---|
| Public marketing copy, documented status pages, OpenAPI `info` block | public | No constraint. |

### 3.6 Reclassification rule

A field cannot move **down** the sensitivity ladder (credential → PII →
PII-suspect → business → public) without a change-proposal PR per the
add-only rule above. A field MAY move **up** the ladder at any time —
that's the safe direction.

---

## 4. Log Boundary Rules (Principle VII)

Redaction is enforced **at the logger boundary** — at the pino transport
serializer and at the OpenTelemetry log exporter — **not at call sites**
(FR-B-005, spec §7.6). A call-site redaction pattern (`logger.info({ password: '***' })`)
is a review-blocking defect, even when correct, because it's not
auditable, not testable in aggregate, and not enforceable as policy.

The redaction method below names a **serializer path placeholder** — the
actual import target lives in the (future, gated) `apps/api` and
`apps/worker` observability modules. This matrix does not author those
modules; it specifies the policy they must implement.

| Log / emit site | Fields emitted (allowed) | Fields redacted (MUST NOT emit) | Redaction method |
|---|---|---|---|
| Auth failure handler | `request_id`, `tenant_id` (when known), `actor_id` (when known), `cause` (`bad_password`/`bad_token`/`expired`/`missing`/`rate_limited`), `route`, `method`, error class | password (raw + hashed), bearer token, refresh token, session cookie value, full request body, raw `Authorization` header, raw `Cookie` header, the email being attempted (log a hashed `email_fingerprint` only if needed for rate-limiting correlation) | pino serializer `[redactPath: req.headers.authorization → redacted]`; pino serializer `[redactPath: req.headers.cookie → redacted]`; custom `auth-failure.serializer.ts` (future, gated) — applies the matrix |
| Worker failure handler | `correlation_id`, `tenant_id`, `store_id`, `job_name`, `queue_name`, `attempt`, `error_class`, `error_code` | full job payload (PII-suspect), credentials, PII fields from the payload, raw exception message if it could contain PII (use error class + sanitized summary) | pino serializer `[redactPath: job.data → fingerprintOnly]`; `worker-failure.serializer.ts` (future, gated) |
| Audit event emitter | `actor_id` (or anonymous-actor sentinel per Principle XIII), `tenant_id`, `store_id`, `operation`, `target_type`, `target_id`, `outcome`, `correlation_id`, `occurred_at` | PII beyond the actor identifier (email, name, phone), credentials, tokens, full request body, full target object | `audit-event.serializer.ts` (future, gated) — emits only the documented audit record shape |
| RLS context failure handler | `request_id`, `route`, `method`, `tenant_id` (if any was attempted), `query_class` (parameterized SHA, no values) | raw query text, raw query parameters (PII-suspect), full request body, credentials | pino serializer + `rls-failure.serializer.ts` (future, gated) — alertable signal per FR-B-009 |
| Validation failure handler | `request_id`, `tenant_id` (when established), `route`, `method`, `field_path` (e.g., `body.user.email` as a **path**, not value), `rule` (e.g., `email_format`/`required`/`max_length`) | the rejected value itself (PII-suspect), credentials, full request body | pino serializer `[redactPath: validation.value → redacted]`; `validation-failure.serializer.ts` (future, gated) |
| Idempotency conflict handler (Track D, future) | `request_id`, `tenant_id`, `store_id`, `route`, `client_id`, `key_fingerprint` (SHA of the key, never raw key), `fingerprint_mismatch: true/false`, `outcome` (`replay`/`409`/`425`) | raw `Idempotency-Key` value, raw request body, raw original response body, credentials | `idempotency.serializer.ts` (future, gated) |

### 4.1 Hard rules at every log site

1. **No raw secrets.** Any field in §3.1 is unconditionally redacted at the
   serializer; a code path emitting one is a defect even if the
   serializer catches it.
2. **No full request/response bodies by default.** Section §3.3 fields are
   redacted unless a field-level review has been recorded as a redaction-matrix
   amendment.
3. **No PII in metric labels.** Cardinality discipline (FR-B-006) is enforced
   in `docs/observability/signals.md`; this matrix governs *logs*, not
   metrics, but the labels list there is consistent with the classification
   here.
4. **Errors are summaries, not stack-traces with payload echoes.** Stack
   traces are allowed; the *frame's local-variable values* are not (most
   logger libraries default this off — we keep it off).
5. **Logger boundary is the only redactor.** A future code review that
   spots `logger.info({ password: hash })` MUST be rejected even though
   the serializer would have redacted it — the call site is itself a
   policy violation (FR-B-005).

### 4.2 Anonymous-actor pattern (Principle XIII)

Where an audit or log event has no authenticated actor (e.g., login
attempts, pre-auth probes), use the sentinel `anonymous` or `system` as
the `actor_id`. Never emit a placeholder containing the attempted
credential (e.g., `actor_id: "attempted: admin@example.com"`).

### 4.3 Pino wildcard depth and worker outbox envelope paths

The shared pino logger's `redact.paths` matcher (configured in
`packages/shared/src/logger/pino.ts` via `DEFAULT_REDACT_PATHS`) supports
two path syntaxes:

- a literal dotted path matches that exact nesting (`payload.metadata.email`
  matches the three-segment field), and
- the `*` wildcard matches **exactly one** path segment (`*.email` matches
  `payload.email` and `event.email`, but **not** `payload.metadata.email`
  — `*` does not recurse).

The matrix amendment for T565 (2026-05-21) adds the following paths to
`DEFAULT_REDACT_PATHS` so worker outbox log lines that bind the audit
envelope (`{ payload: { metadata: { email, phone, full_name, note } } }`)
redact the matrix-protected PII at the boundary regardless of how deeply
the call site binds the envelope:

| Path | Class | Why |
|---|---|---|
| `actor_label` | PII (§3.2) | Top-level binding (e.g., `logger.info({ actor_label }, ...)`). |
| `*.actor_label` | PII (§3.2) | One-segment-nested binding (e.g., `payload.actor_label`). |
| `payload.metadata.email` | PII (§3.2) | Audit envelope's `metadata` block can carry an email captured at the call site. |
| `payload.metadata.phone` | PII (§3.2) | Same nesting; phone. |
| `payload.metadata.full_name` | PII (§3.2) | Same nesting; name. |
| `payload.metadata.note` | PII-suspect (§3.3) | Free-text user-supplied note nested under metadata. |
| `*.metadata.email` | PII (§3.2) | Defensive: matches `event.metadata.email`, `row.metadata.email`, etc. (any one-segment prefix). |
| `*.metadata.phone` | PII (§3.2) | Same defensive pattern. |
| `*.metadata.full_name` | PII (§3.2) | Same. |
| `*.metadata.note` | PII-suspect (§3.3) | Same. |

If a future call site binds the envelope under a deeper nesting (e.g.,
`{ outer: { payload: { metadata: { email } } } }`, three levels above
`metadata`), an additional explicit path is required — `**` is not
available in pino. Add the literal path here AND in
`DEFAULT_REDACT_PATHS`; do not rely on call-site redaction (FR-B-005).

---

## 5. Retention Windows (Principle XIV)

Logs are operational signals, not records of truth. Their retention is
operational, distinct from audit retention (which is governed by the
audit pipeline) and outbox retention (governed by spec §8.2.6).

| Classification | Retention window (logs only) | Sweep mechanism |
|---|---|---|
| Credential (should never appear; if accidentally captured) | **Purge on detection** — incident response | Logger-side detection alert; manual purge from the log store; rotate the affected secret immediately |
| PII (allowed fields per §3.2 that survived field-level review) | **30 days** default; tenant override permitted per future feature | Log-store retention policy (vendor-side); no application-layer sweep |
| PII-suspect (must not be persisted in logs at all) | **n/a** — never reaches the log store | Logger boundary blocks it |
| Business / operational (request_id, tenant_id, correlation_id) | **90 days** default | Log-store retention policy |
| Public | No constraint | — |

> Audit-record retention is **not** governed by this matrix — the audit
> pipeline keeps audit records indefinitely with PII fields tombstoned on
> erasure (per spec / Principle XIII).

---

## 6. Right-to-Erasure Posture (Principle XIV)

- **Erasure flow documented**: deferred to a dedicated PII/erasure feature
  (not 004). 004 establishes the redaction policy at the logger boundary
  so erasure has a stable surface to operate on.
- **Logs**: PII fields in logs are subject to log-store retention (§5);
  erasure of a subject MUST cause subsequent log entries to redact that
  subject's PII via the standard serializers. Historical log entries
  within retention are operationally erasable via log-store tooling
  (vendor-side) — the platform does not retain PII in logs beyond the
  documented window.
- **Audit immutability preserved by**: tombstoning PII fields in audit
  rows (Principle XIII pattern; not implemented by this matrix).
- **Outbox payloads** (Track C, future): payload redacted in place on
  erasure; event-occurred fact retained (spec §8.2.6 / §12.12). This
  matrix governs the payload's redaction at the logger boundary; the
  outbox table's own erasure is a Track C concern.
- **Cross-border / data-residency posture**: single region (Data-Pulse-2
  current default). Multi-region MUST revisit this section before
  shipping.

---

## 7. How tracks reference this matrix

Every Track of feature 004 (and every future feature) that emits logs
references this artifact:

- **Track A** (k6 load testing): synthetic-tenant fixtures must use PII
  values from a **canary domain** (`@example.test`) so a redaction
  failure produces a detectable canary string in log output (per spec
  test plan §7.2).
- **Track B** (observability instrumentation, future / gated): the pino
  transport in `apps/api/src/observability/logger.ts` and the worker
  equivalent MUST import a `redactionMatrix.ts` module whose serializer
  registrations correspond row-for-row with §4 above.
- **Track C** (outbox, future / gated): the outbox drainer worker's
  failure logs MUST honor §4 row "Worker failure handler"; FR-C-008
  defers full-payload logging to this matrix.
- **Track D** (idempotency, future / gated): the idempotency interceptor
  MUST honor §4 row "Idempotency conflict handler"; FR-D-006 defers PII
  in replay bodies to the PII lifecycle and to this matrix.
- **Track E** (SDK generation, future): n/a — Track E is contract-driven
  and does not emit logs in this repo.

---

## 8. Open Questions

Each must be resolved before the redaction policy ships PII-bearing
fields to production. Until resolved, the safer default applies (treat
as redacted).

1. **Log-store retention vendor binding** — single-region default
   confirmed, but log-store retention policy (30 days PII / 90 days
   business) requires the chosen vendor or self-hosted Loki / OTel
   Collector pipeline to enforce TTLs. Owner: ops at slice 4 (Track B
   instrumentation). Until set, application emits short retention hints
   in log payload metadata (`retention_hint: "pii_30d"`).
2. **`ip_address` retention exception** — anti-abuse and rate-limiting
   may require longer retention than 30 days. Owner: security review at
   the per-track first-slice PR for Track B instrumentation. Until set,
   `ip_address` follows §3.2 default (PII, 30 days).
3. **`email_fingerprint` algorithm** — for cases where auth-failure
   correlation needs a deterministic hash of `email` without storing the
   email itself, the salting strategy (per-tenant salt vs platform-wide
   salt) is unresolved. Owner: Track B instrumentation slice.
4. **Anonymous-actor sentinel format** — exact string (`"anonymous"`,
   `"system"`, `null`?) deferred to audit pipeline conventions; this
   matrix accepts whatever the audit emitter standardizes on, provided
   it never contains attempted-credential material.

---

## 9. Validation against spec §7.6

This matrix exists to satisfy every constraint in spec §7.6. Each is
mapped to the §3 / §4 entry that implements it.

| Spec §7.6 constraint | Implemented at | Status |
|---|---|---|
| MUST NOT log passwords (raw or hashed) | §3.1 (credential), §4 "Auth failure handler" | covered |
| MUST NOT log bearer tokens, API keys, session cookie values, refresh tokens | §3.1, §4 "Auth failure handler" | covered |
| MUST NOT log DB / Redis / queue credentials, webhook signing keys | §3.1 | covered |
| MUST NOT log PII payload dumps (names, emails, phones, addresses) | §3.2, §3.3, §4 all rows | covered |
| MUST NOT log full request bodies by default | §3.3 "Full request body", §4 (every row's "redacted" column) | covered |
| MUST NOT log full response bodies by default | §3.3 "Full response body" | covered |
| MUST redact at the logger boundary, not at call sites | §4 prologue, §4.1 rule 5, FR-B-005 | covered |
| MUST treat policy as add-only by default | §1 changelog block, §3.6 reclassification rule | covered |

---

## 10. Validation against constitution

- **§VII Observable Systems**: §4 enforces no secrets/tokens/PII/payloads
  in logs. ✅
- **§XIV PII & Data Lifecycle Discipline**: §3 establishes classification
  (PII / payment / business / public / credential / PII-suspect); §5
  sets retention windows; §6 documents right-to-erasure posture; logger-
  boundary redaction is mandatory per §4. ✅
- **§XIII Auditability & Provenance**: §4.2 establishes anonymous-actor
  pattern; audit emitter row constrains audit-record contents. ✅
- **§VIII Reproducible & Versioned Releases**: §1 changelog + add-only
  rule preserves auditability of policy changes. ✅

---

*End of redaction matrix.*
