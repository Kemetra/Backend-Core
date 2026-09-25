# Feature Specification: Observability — Sentry Errors + Datadog OTLP/Logs Export

**Feature Branch**: `037-observability-sentry-datadog-export`

**Created**: 2026-06-17

**Status**: Draft (Spec Kit chain — `/specify`)

**Input**: Orchestrator [AD-TOOL-003](https://github.com/ahmed-shaaban-94/Retail-Tower-Orchestrator/blob/main/docs/decisions/AD-TOOL-003-observability-layer-sentry-datadog.md) (Accepted 2026-06-17) + [Phase 0 inventory](https://github.com/ahmed-shaaban-94/Retail-Tower-Orchestrator/blob/main/docs/tooling/observability-phase-0-inventory.md). Adopt Sentry (app errors) + Datadog (platform telemetry) on top of DP-2's existing Spec-004/Track-B OpenTelemetry layer.

> **Boundary banner.** This feature adds **no HTTP endpoint, no OpenAPI/contract surface, no migration, and no new signal name.** It wires two drains onto existing seams: Sentry (`@sentry/node`) for unhandled exceptions, and a Datadog OTLP exporter registered in the existing `startOtel()` bootstrap. Every vendor target is DSN/key-gated and default-inert. Authorized as a new egress target by the orchestrator `CLAUDE.md` allowed-egress set (PR #169) per AD-TOOL-003 D5.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Backend exceptions reach a human triage surface (Priority: P1) 🎯 MVP

As the **on-call owner**, when DP-2's API or worker throws an unhandled exception in preprod/prod, I want it captured in Sentry — **scrubbed of all PII/tokens/business data** — so I learn about the failure without an operator having to report a stuck terminal.

**Why this priority**: This is the genuinely-missing layer today (DP-2 has metrics but no error-triage surface). It is the highest-value, lowest-risk slice: it reuses the existing redaction matrix and adds no contract surface.

**Independent Test**: Set `SENTRY_DSN` in a preprod env, induce a controlled unhandled exception on a non-production route, confirm a scrubbed event appears in the `data-pulse-2` Sentry project and the service does not crash.

**Acceptance Scenarios**:

1. **Given** `SENTRY_DSN` is empty, **When** the API/worker boots, **Then** Sentry never initializes and the service behaves exactly as today (default-inert).
2. **Given** `SENTRY_DSN` is set, **When** an unhandled exception occurs, **Then** a Sentry event is recorded with `request`, `user`, and any forbidden-key-matching field stripped (scrub-or-drop), carrying no Clerk token/JWT, operator/patient PII, or business/catalog/inventory/sales payload.
3. **Given** Sentry `init` throws (e.g. malformed DSN), **When** the service boots, **Then** the error is caught, a single warn line is logged (without echoing the DSN), and the service continues (Sentry failure is never a launch-halt).

---

### User Story 2 — Existing OTel metrics & traces drain to Datadog (Priority: P2)

As the **on-call owner**, I want DP-2's already-emitted OTel signals (`docs/observability/signals.md`) to appear in Datadog so I can see request/error rate, latency p50/p95/p99, queue depth, and the cross-hop sale trace — without re-instrumenting anything.

**Why this priority**: High operational value, but depends on the Datadog account/host existing and is more involved than P1. Builds on the explicit `startOtel()` exporter seam.

**Independent Test**: With Datadog keys set, register the Datadog OTLP exporter, then assert the existing named signals from `signals.md` appear in Datadog with no signal-name drift and no new endpoint added.

**Acceptance Scenarios**:

1. **Given** Datadog keys are empty, **When** the service boots, **Then** the existing Prometheus drain is unaffected and no Datadog egress occurs.
2. **Given** Datadog keys are set, **When** the OTLP exporter is registered in `startOtel()`, **Then** the existing `getMeter` signals export to Datadog unchanged (no rename, no re-instrumentation).
3. **Given** trace export is enabled, **When** a sale-capture request flows, **Then** its spans appear in Datadog APM sampled per §Sampling (100% on error/checkout spans).

---

### User Story 3 — Redacted logs & uptime visibility in Datadog (Priority: P3)

As the **on-call owner**, I want DP-2's structured logs (already redacted via the redaction matrix) shipped to Datadog Logs, and uptime synthetics hitting existing public routes, so I can correlate errors with logs and know when the edge is down.

**Why this priority**: Valuable but the most exposure-sensitive (logs) and dependent on P2's account setup; sequenced last.

**Independent Test**: Confirm Datadog Logs show only redaction-matrix-compliant fields; confirm synthetics monitors target only pre-existing routes.

**Acceptance Scenarios**:

1. **Given** log shipping is enabled, **When** logs reach Datadog, **Then** every field complies with `.specify/memory/redaction-matrix.md` (no tokens, payment data, raw POS payloads, or PII beyond the actor).
2. **Given** synthetics are configured, **When** monitors run, **Then** they target only existing routes (edge, `/pair`, a read-down route) — no new endpoint exists.

### Edge Cases

- What happens when the Datadog exporter endpoint is unreachable? → exporter buffers/drops per SDK policy; the API request path is never blocked by telemetry export failure.
- What happens if a future call site adds a high-cardinality label (e.g. `tenant_id`)? → the existing label-policy enforcement rejects it at compile-time + load-time; Datadog inherits this unchanged.
- What happens if Sentry and the Datadog exporter are both inert (all keys empty)? → identical to today's behavior; this is the default committed state.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST capture DP-2 API and worker **unhandled exceptions** in Sentry when `SENTRY_DSN` is set.
- **FR-002**: Sentry initialization MUST be **DSN-gated default-inert** — empty/missing/whitespace DSN → no init, no egress.
- **FR-003**: The system MUST apply a `beforeSend` scrub-or-drop aligned to `.specify/memory/redaction-matrix.md`, stripping `request`/`user`/forbidden-key fields and dropping the event if nothing safe remains.
- **FR-004**: A failing Sentry `init` MUST NOT halt service launch; it MUST be caught and logged once without echoing the DSN.
- **FR-005**: The system MUST register a **Datadog OTLP exporter as an additional drain** in the existing `startOtel()` seam, leaving the existing Prometheus drain and signal names unchanged.
- **FR-006**: Datadog export MUST be **key-gated default-inert** — empty keys → no Datadog egress.
- **FR-007**: The system MUST ship structured logs to Datadog Logs **only after** redaction-matrix compliance, carrying no secrets/tokens/payment/raw-POS/PII.
- **FR-008**: Synthetics/uptime monitors MUST target **only pre-existing routes**; the feature MUST NOT add any HTTP endpoint.
- **FR-009**: Telemetry MUST carry **no business/catalog/inventory/sales payload** (architecture egress invariant; AD-TOOL-003 D5).
- **FR-010**: Sampling MUST be config-driven (env), defaulting conservative (errors 100%, traces ~10% + 100% on error/checkout spans, logs WARN+).
- **FR-011**: All DSNs/keys MUST come from env vars sourced from 1Password; `.env.example` carries empty values; nothing committed.

### Key Entities

- **Telemetry event (Sentry)**: a scrubbed unhandled-exception record — stack + safe context only; no PII/token/business payload.
- **OTel signal (existing)**: the `getMeter`-registered metrics/traces from `signals.md`; this feature adds a drain, not a signal.
- **Structured log (existing)**: redaction-matrix-compliant log lines; this feature adds a Datadog destination.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With all keys empty, API + worker boot behavior is byte-identical to pre-feature (no new egress, Prometheus drain intact).
- **SC-002**: 100% of induced unhandled exceptions appear in Sentry **with zero forbidden keys / zero business payload** in a redaction audit of the events.
- **SC-003**: 100% of the named signals in `signals.md` appear in Datadog with **no signal-name drift** and **no new endpoint** added.
- **SC-004**: A redaction audit of Datadog Logs finds **zero** non-compliant fields.
- **SC-005**: Mean time-to-awareness of a backend failure drops from "operator reports a stuck terminal" to "Sentry alert within minutes" (Email + Telegram per Phase 0 OQ-5).

## Assumptions

- DP-2's existing Spec-004/Track-B OTel layer (`startOtel()`, `getMeter`, Prometheus drain, redaction matrix) is in place and unchanged by this feature.
- The Sentry projects + Datadog account/host are created externally (Phase 0 prerequisites) and keys are available via 1Password before activation.
- Datadog ingests OTLP (direct or via a droplet Agent acting as an OTLP collector — `plan.md` OD-1).
- Preprod (fra1) is the pilot environment; prod promotion follows after the pilot (AD-TOOL-003 Phase 4 / R-2).
- ERPNext/Frappe core is never instrumented (adapter-observed at the Connector — a separate spec).

## Constitution Alignment

- **Principle VII (Observable Systems):** this feature *completes* VII — it routes the mandated structured logs + metrics (error rate, latency p50/p95/p99, queue depth, sync lag) to the chosen vendors and adds the traceable-failure surface (Sentry). Redaction "at the logger boundary, not optional at call sites" is honored via the existing redaction matrix.
- **Principle XIV (PII & Data Lifecycle):** telemetry redaction is mandatory and reuses the classification already in the redaction matrix; observability tags MUST NOT carry PII (existing label-policy enforcement); retention windows are an owner decision (OQ-2).
- **Principle I (Reference, not source of truth):** observability output never overrides `origin/main`/kernel evidence (AD-TOOL-003 Gates).

---

## Setup Reconciliation (2026-06-17) — verified tool state vs. spec assumptions

> **Append-only planning note.** Records the actual Sentry/Datadog onboarding state the owner reported on 2026-06-17 and reconciles it against this spec's original assumptions. **No secret/DSN/key is recorded here or anywhere in git.** This note re-scopes the user stories; it authors no code and changes no FR/SC text above.

### Verified setup state (owner-reported, not yet exercised against live traffic)

- **Sentry:** four projects created — `pos-pulse`, `data-pulse-2`, `rt-console`, `rt-erpnext-connector`. (This spec uses **`data-pulse-2`**.) DSNs are held outside git (1Password); none pasted into chat or committed.
- **Datadog:** onboarding done with **Infrastructure Monitoring ONLY**. **APM = OFF · RUM = OFF · DDOT (OTLP) Collector = OFF · Agent actions/remediation = OFF.** Environment tag currently **`staging`** (onboarding default; some surfaces may show `dev` until renamed).

### Impact on the user stories

| Story | Original assumption | Reconciled status |
|---|---|---|
| **US1 — Sentry backend errors (P1)** | `data-pulse-2` Sentry project exists | ✅ **Unblocked** — project now exists. Still gated on per-slice owner approval + DSN-in-1Password before any code. No change to US1 scope. |
| **US2 — Datadog OTLP metrics/traces (P2)** | Datadog ingests OTLP; APM on for the cross-hop sale trace | ⚠️ **BLOCKED / re-scoped.** With **APM OFF + DDOT/OTLP Collector OFF**, the `startOtel()` OTLP-exporter path and APM tracing are **not available**. US2 reduces to **Datadog Infrastructure Monitoring only** (host/CPU/mem/disk/container/Postgres via the Datadog Agent) until APM + an OTLP collector are turned on. The cross-hop sale **trace** (and SC-003's "named signals appear in Datadog via OTLP") is deferred until then. |
| **US3 — Redacted logs + synthetics (P3)** | Datadog Logs + Synthetics | ⚠️ **Partially blocked.** Log shipping/synthetics depend on enabling the corresponding Datadog products (not part of Infra-only onboarding). Deferred until enabled. |

### Environment-naming note (planning only)

- Specs/AD-TOOL-003 assumed **`preprod`** as the pilot env tag; Datadog onboarding currently uses **`staging`/`dev`**. **Preferred future naming = `preprod`.** This is a reconciliation note, not a blocker — align the `env` tag at activation time; do not invent a rename here.

### Net effect

- **US1 (Sentry, P1) is the only currently-actionable slice** and remains the MVP. Its tasks (T005–T010) are unchanged.
- **US2/US3 are gated on owner enabling Datadog APM / OTLP collector / Logs / Synthetics** — captured as new owner decisions below; until then, Datadog contributes **infra metrics only**.

### New owner decisions (from this reconciliation)

| OD | Question | Status |
|---|---|---|
| OD-5 | Enable Datadog **APM** (+ a DDOT/OTLP collector) so the OTel layer can drain to Datadog (US2 full scope + the cross-hop sale trace)? | OPEN — owner. Until YES, US2 = infra-metrics-only. |
| OD-6 | Enable Datadog **Logs** + **Synthetics** for US3? | OPEN — owner. |
| OD-7 | Rename the Datadog environment tag `staging`/`dev` → `preprod` to match the program naming, or accept the current tag? | OPEN — owner (cosmetic, non-blocking). |
