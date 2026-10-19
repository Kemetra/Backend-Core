# Observability Signal Catalogue

**Ref**: 004-platform-production-readiness (T444–T449)
**Author**: Track B Observability owner
**Date**: 2026-05-16
**Constitution**: v3.0.0 (Principle VII — Observable Systems)
**Spec**: [`../../specs/004-platform-production-readiness/spec.md`](../../specs/004-platform-production-readiness/spec.md) §7.3–§7.7
**Plan**: [`../../specs/004-platform-production-readiness/plan.md`](../../specs/004-platform-production-readiness/plan.md) §3.2.1
**Redaction policy**: [`../../.specify/memory/redaction-matrix.md`](../../.specify/memory/redaction-matrix.md) — single source of truth for all log-boundary redaction

> **Documentation-only artifact.** This file enumerates the named signals
> the platform MUST emit once Track B's instrumentation slice (P4) is
> approved. No instrumentation is enabled by this document. Per plan §3.2.1
> every metric/log/trace listed here is OTel-native and vendor-neutral
> (FR-B-007). Signal names follow Prometheus naming conventions
> (`_total`, `_seconds`) for documentation clarity — the runtime exporter
> is the OpenTelemetry SDK, and the Prometheus exporter is one drain
> among several.

---

## Conventions

- **Type**: `counter` (monotonic), `gauge` (instantaneous), `histogram`
  (latency / size distribution with bucketed quantiles).
- **Labels**: low-cardinality only. See §6 "Rejected labels".
- **Naming**: OTel-native semantic-convention style where applicable
  (`http.server.duration` family); Prometheus-flavoured names for direct
  scraping. Drift between the two MUST be documented at instrumentation
  time, not invented here.
- **Quantiles**: p50, p95, p99 reported from histograms; never as
  separate per-quantile metrics.

---

## 1. API signals (T444)

Per spec §7.3 and plan §3.2.1. All counters are monotonic. Histograms
emit `_bucket`, `_sum`, `_count` per Prometheus convention; quantiles
are recovered via `histogram_quantile()` or equivalent at the query
layer.

| Signal | Type | Labels (low-cardinality only) | Source FR |
|---|---|---|---|
| `http_request_count` | counter | `route`, `method`, `status_class` (`2xx`/`3xx`/`4xx`/`5xx`) | FR-B-001, spec §7.3 |
| `http_request_duration_seconds` | histogram | `route`, `method` | FR-B-001, spec §7.3 (p95+p99) |
| `http_error_4xx_total` | counter | `route`, `status` (e.g., `400`/`401`/`403`/`404`/`409`/`422`/`425`) | FR-B-001 |
| `http_error_5xx_total` | counter | `route`, `status` (e.g., `500`/`502`/`503`/`504`) | FR-B-001 |
| `auth_failure_total` | counter | `cause` ∈ {`bad_password`, `bad_token`, `expired`, `missing`, `rate_limited`} | FR-B-001, spec §7.3 |
| `tenant_context_failure_total` | counter | `reason` ∈ {`missing`, `invalid`, `cross_tenant`} | FR-B-001, FR-B-008, spec §7.3 |
| `validation_failure_total` | counter | `route` (NOT `field_name` — that's PII-suspect) | FR-B-001, spec §7.3 |
| `suspicious_login_total` | counter | `reason` ∈ {`rapid_retry`, `geo_anomaly`, `unknown_device`} | FR-B-001, spec §7.3 |
| `cross_tenant_rejection_total` | counter | `route` | FR-B-008, spec §7.3 |
| `idempotency_replay_total` | counter | `route` | FR-D-010, Track D, spec §7.3 |
| `idempotency_conflict_total` | counter | `route` (status 409) | FR-D-010, Track D |
| `idempotency_in_progress_total` | counter | `route` (status 425) | FR-D-010, Track D |

### Notes
- `validation_failure_total` deliberately omits the rejected field's
  **value** and the field's **name** — see redaction matrix §3.3 row
  "Validation error context".
- `cross_tenant_rejection_total` and `tenant_context_failure_total{reason="cross_tenant"}`
  are separate signals: the first is the boundary rejection (the request
  reached an endpoint and was refused), the second is the context layer's
  failure to establish a tenant scope at all. Both increment together for
  the same incident; they are not duplicates.
- **`route="unknown"` on error-path metrics.** For samples emitted from
  `GlobalExceptionFilter` (`http_error_4xx_total`, `http_error_5xx_total`,
  `validation_failure_total`), the `route` label is resolved in this
  order: (1) Nest controller/handler Reflect metadata, (2) Express's
  matched-route record `request.route.path`, (3) the bounded literal
  `"unknown"`. Resolution (3) applies only to genuine unmatched 404s —
  i.e., requests for paths Express never bound a route to. In that case
  no per-route metric breakdown is meaningful (the path does not exist
  in the catalogue), and `route="unknown"` is the correct, bounded
  label. Matched-route error samples always carry the real template
  (e.g., `route="/api/v1/auth/signin"`).

---

## 1.1 Catalog domain signals (005 Wave 1)

**Ref**: `specs/005-pos-catalog-sync-reconciliation/spec.md` §6 FR-080 / FR-081 / FR-082; tasks.md T501 / T533 / T552 / T553.
**Owner**: 005 (POS Catalog Sync & Unknown Item Reconciliation).
**Slice that registered them**: `005-WAVE1-METRICS-ALLOWLIST` (schema-only).
**Slice that emits them**: `005-WAVE1-SETUP` (T501 — instrument creation in `api.metrics.ts`) plus the emission sites in `005-WAVE1-CAPTURE-HAPPY`, `005-WAVE1-DISMISS`, and `005-WAVE1-IDEMP-MISMATCH`.

These three signals are domain extensions added by feature 005. They are
API-layer counters (emitted from controller / exception-filter call sites
in `apps/api/src/catalog/unknown-items/`) and follow the same naming +
cardinality rules as §1. Listed in their own subsection so it is obvious
they are not part of the original T444 platform catalogue.

| Signal | Type | Labels (low-cardinality only) | Source FR / spec |
|---|---|---|---|
| `unknown_item_captured_total` | counter | (none) | 005 FR-081, plan §3.4 — successful POS capture into `unknown_items` table |
| `unknown_item_resolved_total` | counter | `action` ∈ {`linked`, `created`, `dismissed`} | 005 FR-081, plan §3.4 — terminal-state transition out of `pending`. Wave 1 only emits `dismissed`; `linked` and `created` are Wave 2 (blocked on 003 PHASE3_RED_WAVE) |
| `idempotency_token_mismatch_total` | counter | (none) | 005 FR-021c, FR-082 — POS replay with same `Idempotency-Key` but a different payload. Increments alongside the existing platform-level `idempotency_conflict_total{route}` (§1) — the platform counter is route-bucketed; this one is catalog-domain bucketed |
| `catalog_duplicate_alias_conflict_total` | counter | (none) | 005 FR-043 / 003 §9 canonical — increments on every reconciliation rejection caused by an alias unique-index violation (link or create-new). Registered by `005-WAVE2-METRICS-ALLOWLIST`, emitted at the conflict catch site by `005-WAVE2-METRICS` (T651). Unlabeled: the FR-043 principal + correlation-id attribution is carried by the `unknown_item.reconciliation_conflict_rejected` audit event, not metric labels (FR-B-006) |

### Notes

- **No `route` label** on `unknown_item_captured_total` / `unknown_item_resolved_total`.
  These counters are *domain-keyed*, not *route-keyed*. The HTTP route is
  already captured by §1's `http_request_count{route,method,status_class}`;
  duplicating it on the domain counter would not add information and would
  forbid future emission from non-route surfaces (e.g., a worker repair
  job that resolves a stale pending row).
- **`action` cardinality is closed at three values** — explicitly enumerated
  above. The set is owned by 005's spec §6 (FR-002 resolution states); any
  expansion requires an FR change. Cardinality review (FR-B-012) passes
  trivially (bounded, not forbidden, not PII-adjacent).
- **`idempotency_token_mismatch_total` is *not* redundant with `idempotency_conflict_total`.**
  The platform counter (`idempotency_conflict_total{route}`) is owned by
  the platform-level interceptor and increments on *every* 409 emitted from
  it. The catalog-domain counter increments specifically when the offending
  route is the unknown-items capture route AND the catalog-domain audit
  subject `unknown_item.idempotency_mismatch_rejected` was emitted. They
  always co-increment for a catalog-route mismatch; they diverge when the
  platform interceptor returns 409 on a non-catalog route (only the
  platform counter increments). Both are intentional.
- **Naming convention.** `unknown_item_*` and `idempotency_token_mismatch_total`
  follow snake_case + `_total` per Prometheus naming. `unknown_item_*`
  uses the singular form because each increment is one item; the
  collection is `unknown_items` (plural in the DB table name only).

## 1.2 POS shift signals (RT-17)

| Signal | Type | Labels (low-cardinality only) | Source |
|---|---|---|---|
| `shift_close_approver_unverified_total` | counter | `reason` ∈ {`approver_is_closer`, `inactive_membership`, `not_manager`, `no_store_access`, `check_unavailable`} — one increment when a shift close is first recorded (201, never a replay) with a `varianceApprovedByUserId` that is the closer, has no active membership, holds no `owner` / `tenant_admin` / `store_manager` role, has no access to the store, or could not be looked up. The close is recorded regardless (detect, never refuse). Paired with one `shift.close.approver_unverified` warning carrying the same `reason` and no ids | Jira RT-17 comment 10955, option A |

## 1.3 Console rate-limit signals (RT-619)

Emitted by `ConsoleRateLimitGuard` only when `CONSOLE_RATE_LIMIT_MODE` is `report` or `enforce` (default `off`: no emission, no Redis call). Decision record: `docs/decisions/rt-574-console-rate-limiting.md` D6.

| Signal | Type | Labels (low-cardinality only) | Source |
|---|---|---|---|
| `console_rate_limit_total` | counter | `class` ∈ {`cheapRead`, `expensiveRead`, `write`, `jobOrPreview`, `onboarding`, `incidentControl`, `exempt`}; `outcome` ∈ {`allowed` (under 50% of budget), `near_limit` (allowed, 50% or more), `would_limit` (over budget, report mode), `limited` (over budget, enforce mode: 429), `fail_open` (limiter error, timeout or open breaker)}; `route` (route template, the same bounded label as `http_error_4xx_total`). One increment per console request the guard evaluates. No user, tenant or IP label | RT-574 D6 / RT-619 |
| `console_rate_limit_utilisation` | histogram | `class`, `route` as above. Value = count / limit of the caller's bucket at each successful check (above 1 = over budget); buckets 0.1, 0.25, 0.5, 0.75, 0.9, 1, 2 | RT-574 D6 / RT-619 |

## 1.4 AI gateway signals (RT-655)

Emitted by `AiGateway.run` (apps/api/src/ai). No vendor adapter exists yet: with the default wiring the gateway denies before any provider request, so `ai_gateway_provider_call_total` stays at zero until an approved route is allowlisted. Per-tenant cost and usage are NOT metrics; they live in the usage ledger owned by RT-663 (AD-AI-PROV-001 D-6).

| Signal | Type | Labels (low-cardinality only) | Source |
|---|---|---|---|
| `ai_gateway_run_total` | counter | `feature` (a code-owned feature id; an unregistered id is labelled `unknown`); `outcome` ∈ {`ok`, or a fallback reason from the closed set: `not_authorized`, `store_out_of_scope`, `unknown_feature`, `tenant_inactive`, `not_entitled`, `trial_expired`, `grace_read_only`, `feature_disabled_tenant`, `entitlement_unavailable`, `feature_disabled_system`, `quota_exhausted`, `spend_cap_reached`, `free_credit_exhausted`, `evidence_unavailable`, `route_not_allowlisted`, `unsupported_capability`, `context_too_large`, `provider_timeout`, `provider_unavailable`, `provider_refused`, `provider_truncated`, `provider_rejected_input`, `provider_error`, `output_schema_invalid`, `output_unknown_evidence_ref`}. One increment per run. No tenant, store, user or correlation label | RT-655 / RT-643 §5 |
| `ai_gateway_provider_call_total` | counter | `provider`, `route` (both from the static route allowlist); `outcome` ∈ {`ok`, `refused`, `truncated`, `rejected_input`, `unavailable_timeout`, `unavailable_rate_limited`, `unavailable_provider_5xx`, `unavailable_network`, `unavailable_auth`, `unavailable_disabled`, `error`}. One increment per provider request actually sent. No model id, token count or cost label | RT-655 / RT-643 §9.1 |

---

## 2. Database signals (T445)

Per spec §7.4 and plan §3.2.1. All emitted at the Drizzle/pg layer.

| Signal | Type | Labels (low-cardinality only) | Source FR |
|---|---|---|---|
| `db_pool_in_use` | gauge | (none) | FR-B-002, spec §7.4 |
| `db_pool_waiters` | gauge | (none) | FR-B-002, spec §7.4 |
| `db_slow_query_total` | counter | `query_class` (parameterized-statement SHA prefix — NEVER the raw query, NEVER the parameter values) | FR-B-002, spec §7.4 |
| `db_rls_context_failure_total` | counter | (none — **alertable, NEVER per-tenant**) | FR-B-002, FR-B-009, spec §7.4 |
| `db_migration_status` | gauge | `state` ∈ {`pending`, `applied`, `failed`} | FR-B-002, spec §7.4 |

### Notes
- `db_slow_query_total{query_class}` uses a hash of the *parameterized*
  statement template (the SQL with `$1`/`$2` placeholders intact), not
  the rendered query. Parameter values are PII-suspect (redaction matrix
  §3.3) and never appear in metric labels.
- `db_rls_context_failure_total` has **no labels** by design. It is
  alertable on any non-zero increment (per `alerts/README.md` future
  alert list) and `tenant_id` is forbidden as a metric label
  (FR-B-006). Tenant-scoped breakdowns belong in **traces** and **logs**,
  not metrics.

---

## 3. Redis / BullMQ / Worker signals (T446)

Per spec §7.5 and plan §3.2.1. The Track C outbox signals appear here
because they share the async observability surface; they are emitted
only after the Track C first slice (P7) ships.

### 3.1 Redis

| Signal | Type | Labels | Source FR |
|---|---|---|---|
| `redis_command_duration_seconds` | histogram | `command` (`get`/`set`/`del`/`hget`/`hset`/etc.) — the Redis command verb, never the key | FR-B-003, spec §7.5 |

### 3.2 BullMQ / queues

| Signal | Type | Labels | Source FR |
|---|---|---|---|
| `queue_lag_seconds` | gauge | `queue` (queue name; bounded set) | FR-B-003, spec §7.5 |
| `queue_failed_total` | counter | `queue`, `error_class` (sanitized class name, not message) | FR-B-003, spec §7.5 |
| `queue_dead_letter_total` | counter | `queue` | FR-B-003, spec §7.5 |
| `queue_retry_total` | counter | `queue` | FR-B-003, spec §7.5 |

`queue` values (RT-125). The lag gauge observes the queues the worker
consumes, taken from the shared `QUEUE_NAMES`: `email`, `audit`,
`audit-retention`, `sale-processing`, `outbox-retention`,
`erpnext-stock-reconciliation-sweep` (RT-179),
`cashier-admission-replay-purge` (RT-209), `sale-redrive` (RT-457). The three delivery
counters also carry `outbox-drainer`, which is the outbox drainer's own
retries and dead-letters. The drainer is not a BullMQ queue, so it has no lag.
Before RT-125, the drainer reported as `audit-fanout`, which is a job name,
and the gauge observed `audit-fanout`, `session-revoke` and `soft-delete-sweep`,
none of which is a consumed queue.

### 3.3 Workers

| Signal | Type | Labels | Source FR |
|---|---|---|---|
| `worker_job_duration_seconds` | histogram | `job_name` (bounded set; one per declared job type) | FR-B-003, spec §7.5 |
| `worker_processing_failure_total` | counter | `job_name`, `error_class` — RT-457: every failed `sale-processing` attempt counts under `job_name="sale-processing"` | FR-B-003, spec §7.5 |
| `erpnext_stock_reconciliation_sweep_total` | counter | `outcome` (`created` / `skipped_running` / `skipped_period` / `skipped_ineligible`) — one increment per store the scheduled stock reconciliation sweep considers; the tenant and store are in the sweep log, never a label | RT-179 |
| `erpnext_stock_run_stranded` | gauge | `outcome` (`report_incomplete` / `report_complete`) — `kind='stock'` runs still `running` 2 h after `started_at`, sampled once per scheduled sweep tick after the expiry pass (a tick where any tenant's expiry pass failed keeps the last complete sample). `report_incomplete` is what the sweep expires, so it reads zero after a healthy sweep; `report_complete` is never expired and means the reconciliation worker has not processed a completed report | RT-688 |
| `erpnext_stock_run_expired_total` | counter | none — stock runs the sweep moved `running → failed` past the 2 h TTL without a complete Bin report (`summary.failure.reason = bin_view_not_completed`, one `erpnext_reconciliation.run.failed` audit row each); the tenant, store and run are in the sweep log | RT-688 |

### 3.4 Track C outbox (future, emitted after P7)

| Signal | Type | Labels | Source FR |
|---|---|---|---|
| `outbox_pending_total` | gauge | `event_type` (bounded set of declared event types) | FR-C-001 / Track C; via Track B catalogue |
| `outbox_dead_letter_total` | counter | `event_type` | FR-C-005 / Track C |
| `outbox_drain_duration_seconds` | histogram | `event_type` | FR-C-001 / Track C |
| `erpnext_posting_reversal_deferred_dead_letter_total` | counter | none — one increment when an `erpnext.posting.requested` reversal dead-letters while still awaiting its sale's `sale_post` row (the RT-173 deferral ran out of attempts). The tenant, sale and outbox event id are fields of the `posting.reversal.dead_lettered` error log, never labels. The deferral itself counts in `queue_failed_total` as `error_class="ReversalAwaitingSalePostError"` | RT-207 |
| `sale_redrive_total` | counter | `reason` (`sale_processing` / `sale_post_intent` / `reversal_intent`) — added per tick with the number of items the scheduled sale re-drive sweep recovered: a sale left unprocessed inside the age window (`SALE_REDRIVE_MIN_AGE_MS`, default 15 min, to `SALE_REDRIVE_MAX_AGE_MS`, default 7 days) was processed, or a `sale_post` / `reversal` `erpnext.posting.requested` event that dead-lettered with no posting row was re-emitted (at most until 3 of its events have dead-lettered). Any value above zero means a hop of the sale pipeline lost work. The tenant and sale are in the sweep log, never labels | RT-457 |

### Notes
- `queue` and `job_name` are intentionally bounded by the platform — new
  queue or job names are review-time additions (FR-B-012 cardinality
  review).
- `error_class` is the exception class name (e.g.,
  `TenantContextMissingError`), never the message text — error messages
  may contain PII or stack-derived data (redaction matrix §4.1 rule 4).

---

## 4. Structured-log field requirements (T448)

Every log line emitted by every process in the monorepo MUST include
the following structured fields **when available** (FR-B-004). These
are **log fields**, not metric labels — metrics never carry these
(see §6).

| Field | When emitted | Notes |
|---|---|---|
| `request_id` | Always (HTTP layer) or always (worker, per-job) | Required at every log site (FR-B-004). For workers, this is the job's unique id. |
| `tenant_id` | When tenant context has been established | Once established, MUST appear on every subsequent log line for the request/job (FR-B-010 for workers). |
| `store_id` | When store context has been established | Same constraint as `tenant_id`. |
| `actor_id` | When the request is authenticated | Subject identifier, not the human's email (redaction matrix §3.4). Use `anonymous` / `system` sentinel pre-auth (matrix §4.2). |
| `correlation_id` | For all async work | End-to-end trace identifier; inherited from the originating request through the queue boundary into the worker, then onward into any downstream service call. |
| `route` | HTTP requests | Route template (`/v1/memberships/:id`), never the rendered path with identifiers. |
| `method` | HTTP requests | HTTP verb. |
| `status` | HTTP responses | Numeric status code. |
| `outcome` | Audit / worker events | `success` / `failure` / `partial` — short bounded enum. |

### Field source-of-truth
- These are the **only** fields a log statement may emit *by default*.
- Any other field added to a log call site MUST appear in the redaction
  matrix at the appropriate classification, or it MUST NOT be emitted.

---

## 5. Slow-query threshold (T449)

Per research §4 / spec §15.2:

- **Default threshold**: **500 ms** per query.
- **Rationale**: foundation endpoint queries are all under 50 ms in 001
  baselines; 500 ms is a 10x signal, not a noise floor.
- **Alert condition** (paired with `alerts/README.md`): sustained
  `> 5/min` over a **5-minute** window — single slow queries don't page,
  patterns do.
- **Configurability**: exposed as a runtime config (no code constant);
  tunable per environment without redeploy.
- **What counts as one "slow query"**: a single `pg` operation whose
  measured duration exceeded the threshold, attributed to the
  parameterized statement hash (`query_class` label on
  `db_slow_query_total`). Connection-acquisition wait is reported
  separately via `db_pool_waiters`, not folded into query duration.

---

## 6. Cardinality discipline — Rejected labels (T447)

> **FR-B-006 / spec §7.7 (non-negotiable).** The following are **NEVER**
> permitted as metric labels in this platform. Any signal proposal that
> includes them MUST be rejected at review.

| Forbidden label | Reason | Where it does live |
|---|---|---|
| `tenant_id` | Unbounded cardinality (every tenant explodes every metric); also a structured-log field that already provides per-tenant breakdowns at query time without metric explosion. | Logs (§4); traces. |
| `store_id` | Same — store count multiplies tenant count. | Logs; traces. |
| `user_id` | Same — user count is orders of magnitude higher than tenant count; also PII-adjacent (a user_id leak combined with an external lookup yields identity). | Logs; traces. |
| `actor_id` | Same as `user_id`. | Logs; traces. |
| Raw email, phone, address, name | PII (redaction matrix §3.2). | Nowhere — never logged in full either. |
| Raw `Idempotency-Key` value | PII-suspect / credential (redaction matrix §3.1). | Log only the SHA fingerprint. |
| Raw query text or query parameters | PII-suspect; cardinality explosion. | `query_class` (parameterized hash) on `db_slow_query_total`. |
| `error.message` text | PII-suspect; high cardinality. | `error_class` (the exception class name) is the safe substitute. |
| `field_name` on validation failures | PII-suspect (validation errors echo user input). | `route` on `validation_failure_total`. |
| Date/time strings as labels | Cardinality explosion. | Use built-in time-series timestamp. |

### Cardinality review (FR-B-012)
Any new signal that introduces a label not already attested in this
file MUST go through a cardinality review at the per-track first-slice
PR. The reviewer's job is to confirm:
1. The label's value space is **bounded** at the platform level.
2. The label is **not** in the forbidden list above.
3. The label is **not** PII or PII-adjacent per the redaction matrix.

A label fails the review if any of those three are violated.

---

## 7. Vendor neutrality (FR-B-007)

Every signal in this document is:
- Emitted by the **OpenTelemetry SDK** (the runtime instrumentation
  library is OTel-native).
- Drained to an **OpenTelemetry Collector** (recommended; research §4)
  via OTLP/gRPC, **or** scraped by Prometheus directly from an OTel
  Prometheus exporter, **or** forwarded to a managed vendor (Datadog,
  New Relic, Honeycomb) that consumes OTel.
- Free of vendor-specific tag dimensions. No signal here uses Datadog
  `dd.*`, New Relic `nr.*`, or Honeycomb-only widely-cardinal fields.

If a vendor-specific feature would simplify a signal at the cost of
neutrality, the simpler approach is **rejected** (FR-B-007).

---

## 8. Drift contract with plan and spec (validation)

Every signal name in this file is the canonical name. Plan §3.2.1 and
spec §7.3–§7.5 are the source documents. Any deviation MUST be
reconciled in this file *and* in those documents; silent drift in either
direction is a defect.

See "Validation log" at the end of this file for the drift check.

---

## 9. What's NOT in this catalogue

To keep the surface honest, this section enumerates signals that are
**out of scope** for the first slice. Each is owned by a separate
future feature.

- **Reconciliation mismatch rate** (Constitution §VII bullet 3): partially
  addressed for the POS-capture surface by 005's `unknown_item_resolved_total`
  + `idempotency_token_mismatch_total` (see §1.1). The full
  reconciliation pipeline (link / create-new across stores, alias
  conflict resolution) is still future work — when it lands, additional
  signals will extend §1.1 with the corresponding `action` values and
  any new conflict-class counters.
- **Duplicate event rate at consumer** (separate from `idempotency_replay_total`):
  emitted once Track C's idempotent consumer projection (per-consumer
  `processed_events`) is built; counter name will be defined at that
  slice.
- **POS-specific signals**: POS app is a separate repository; its
  contract-driven signals follow this catalogue's naming rules but live
  in the POS repo's observability docs.
- **Business KPIs** (revenue per tenant, etc.): not platform-observability
  signals — they belong to the analytics / reports surface.

---

## Validation log

### T452 — file-scope validation (run at PR open)

The following git checks MUST be empty for this slice:

```
git status --short
# Expected: only the four files for this slice (M/A in
#   .specify/memory/redaction-matrix.md
#   docs/observability/signals.md
#   docs/observability/dashboards/README.md
#   docs/observability/alerts/README.md)

git diff -- apps packages package.json pnpm-lock.yaml \
            .github/workflows packages/contracts/openapi packages/db
# Expected: empty (no source/contract/package/CI changes)

git diff -- .specify/templates
# Expected: empty (templates are not modified by this slice)
```

The reviewer MUST run these three commands and reject the PR if any
emits output beyond the four allowlisted files.

### T453 — drift check against plan §3.2.1 and spec §7.3–§7.5

Each signal name in this file (§1, §2, §3) was checked against the
canonical sources. Findings:

| Signal | Plan §3.2.1 | Spec §7.3–§7.5 | This file (§) | Match |
|---|---|---|---|---|
| `http_request_count` | yes | implied ("request count") | §1 | OK |
| `http_request_duration_seconds` | yes | implied ("request duration p95/p99") | §1 | OK |
| `http_error_4xx_total` | yes | implied ("4xx and 5xx rate") | §1 | OK |
| `http_error_5xx_total` | yes | implied | §1 | OK |
| `auth_failure_total` | yes | yes (auth failures by cause) | §1 | OK |
| `tenant_context_failure_total` | yes | yes (tenant context failures) | §1 | OK |
| `validation_failure_total` | yes | yes (validation failures) | §1 | OK |
| `suspicious_login_total` | yes | yes (suspicious login attempts) | §1 | OK |
| `cross_tenant_rejection_total` | yes | yes (cross-tenant rejection count) | §1 | OK |
| `idempotency_replay_total` | yes | yes (Track D replay count) | §1 | OK |
| `idempotency_conflict_total` | yes | yes (Track D conflict 409 count) | §1 | OK |
| `idempotency_in_progress_total` | yes | yes (Track D in-progress 425 count) | §1 | OK |
| `db_pool_in_use` | yes | yes (pool pressure) | §2 | OK |
| `db_pool_waiters` | yes | yes (pool waiters) | §2 | OK |
| `db_slow_query_total` | yes | yes (slow-query indicator) | §2 | OK |
| `db_rls_context_failure_total` | yes | yes (RLS context failures) | §2 | OK |
| `db_migration_status` | yes | yes (migration status) | §2 | OK |
| `redis_command_duration_seconds` | yes | yes (Redis latency, implied) | §3.1 | OK |
| `queue_lag_seconds` | yes | yes (queue lag per queue) | §3.2 | OK |
| `queue_failed_total` | yes | yes (failed jobs per queue) | §3.2 | OK |
| `queue_dead_letter_total` | yes | yes (dead-letter count) | §3.2 | OK |
| `queue_retry_total` | yes | yes (retry count per queue) | §3.2 | OK |
| `worker_job_duration_seconds` | yes | yes (job duration p50/p95 per job type) | §3.3 | OK |
| `worker_processing_failure_total` | yes | yes (worker processing failures) | §3.3 | OK |
| `outbox_pending_total` | yes (Track C row) | n/a — Track C signal | §3.4 | OK |
| `outbox_dead_letter_total` | yes (Track C row) | n/a — Track C signal | §3.4 | OK |
| `outbox_drain_duration_seconds` | yes (Track C row) | n/a — Track C signal | §3.4 | OK |

**Drift findings (reported only, not fixed in this slice)**:

1. **Plan §3.2.1 label drift — minor.** Plan §3.2.1 lists
   `tenant_context_failure_total` with label name `cause` (values
   `missing`/`invalid`/`cross_tenant`), but the task brief and spec §7.3
   describe it more naturally as `reason`. This file uses `reason` to
   match the task brief; the plan can be updated independently to align
   on `reason`. **No source spec edit performed in this slice.**
2. **Plan §3.2.1 label drift — minor.** Plan §3.2.1 lists
   `validation_failure_total` with both `route` and `field_class` (no
   field name PII). This file emits **only** `route`, because
   `field_class` is not defined anywhere as a bounded set and risks
   becoming a backdoor for PII (validation errors often echo user input
   field paths). If `field_class` is to be added later, it MUST be a
   pre-declared bounded enum reviewed under FR-B-012. **No source spec
   edit performed in this slice.**
3. **Plan §3.2.1 label drift — minor.** Plan §3.2.1 lists
   `queue_failed_total` with `queue, error_class` and
   `worker_processing_failure_total` with `job_type, error_class`. This
   file matches that (queue_failed_total has `queue, error_class`;
   worker uses `job_name` rather than `job_type` for naming consistency
   with BullMQ conventions). The job-naming label diverges from the plan
   text by one identifier (`job_name` vs `job_type`); the runtime
   instrumentation slice should reconcile. **No source spec edit
   performed in this slice.**
4. **Plan §3.2.1 `suspicious_login_total`** lists labels `pattern`
   (`rapid_retry`, `geo_anomaly`); this file uses `reason` with values
   `rapid_retry`/`geo_anomaly`/`unknown_device` to align with
   `tenant_context_failure_total{reason=...}` for label-name
   consistency. **No source spec edit performed in this slice.**
5. **Spec §7.5 mentions "p50 and p95 per job type" for job duration**;
   this file emits a histogram and reports p50/p95/p99 at the query
   layer. No drift — the histogram subsumes the spec's intent.

Net: signal **names** are consistent across plan / spec / this file.
Minor **label-name** drift in four places (`reason` vs `cause`,
`reason` vs `pattern`, `job_name` vs `job_type`, omission of
`field_class`) is documented above and is for the runtime
instrumentation slice (P4) to reconcile in the plan / spec. **This
slice does not edit the spec or the plan.**

### T454 — redaction matrix coverage of spec §7.6

Confirmed via redaction-matrix §9 ("Validation against spec §7.6") that
all 8 constraints from spec §7.6 are mapped to specific sections of the
matrix:

- passwords (raw and hashed) → matrix §3.1, §4 "Auth failure handler"
- bearer tokens, API keys, session cookies, refresh tokens → matrix §3.1
- DB / Redis / queue credentials, webhook signing keys → matrix §3.1
- PII payload dumps (names, emails, phones, addresses) → matrix §3.2, §3.3
- no full request bodies by default → matrix §3.3, §4 every row
- no full response bodies by default → matrix §3.3
- redact at the logger boundary, not at call sites → matrix §4 prologue,
  §4.1 rule 5, FR-B-005 reference
- add-only by default → matrix §1 changelog block, §3.6 reclassification
  rule

All 8 constraints covered.

---

*End of signals catalogue.*
