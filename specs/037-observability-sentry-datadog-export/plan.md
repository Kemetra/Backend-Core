# Implementation Plan: Observability — Sentry Errors + Datadog OTLP/Logs Export

**Branch**: `037-observability-sentry-datadog-export` | **Date**: 2026-06-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/037-observability-sentry-datadog-export/spec.md`

> **Planning artifact only.** This plan describes wiring tasks against existing seams. No code, SDK install, DSN/key, or contract is authored by this plan. Execution is a separate DP-2 slice, owner-gated per AD-TOOL-003 D6.

## Summary

Add two telemetry drains to DP-2 on top of the existing OTel layer: **Sentry** for unhandled exceptions (the missing error-triage surface) and a **Datadog OTLP exporter** registered in the existing `startOtel()` bootstrap (metrics + traces), plus redacted-log shipping and synthetics on existing routes. Default-inert, key-gated, conservative sampling, no new endpoint, no contract change.

## Technical Context

**Language/Version**: TypeScript / Node (NestJS api + worker), pnpm monorepo.

**Primary Dependencies**: existing `@data-pulse-2/shared` (`startOtel`, `getMeter`), `@opentelemetry/*`, `@opentelemetry/exporter-prometheus` (existing). **New (gated, added at execution):** `@sentry/node`; a Datadog OTLP exporter (`@opentelemetry/exporter-*-otlp-*` or the Datadog Agent as OTLP collector — OD-1).

**Storage**: N/A (no schema/migration; telemetry is egress-only).

**Testing**: existing Vitest/Jest suites; DI seams (mirror POS-Pulse's `sentryInit` injectable) so tests assert init WITH/WITHOUT a live SDK.

**Target Platform**: fra1 DigitalOcean droplet (preprod first), Docker stack.

**Project Type**: web-service (api) + worker.

**Performance Goals**: telemetry export MUST NOT block the request path; exporter failure degrades to drop/buffer, never a request error.

**Constraints**: no new endpoint; no OpenAPI/contract change; no migration; no committed secret; conservative default sampling (the compensating control for the no-budget-cap decision, Phase 0 OQ-1).

**Scale/Scope**: single host pilot; 2 runtimes (api + worker); 0 new endpoints; 0 schema changes.

## Constitution Check

| Principle | Check | Verdict |
|---|---|---|
| **VII Observable Systems** | Routes the mandated logs/metrics to vendors + adds traceable-failure surface (Sentry). Redaction at logger boundary via existing matrix. | ✅ PASS — completes VII |
| **XIV PII & Data Lifecycle** | Redaction reuses the matrix; tags carry no PII (existing label policy); retention = OQ-2 (owner). | ✅ PASS (retention deferred to owner, documented) |
| **I Reference, not SoT** | Observability never overrides `origin/main`/kernel. | ✅ PASS |
| **III Backend Authority** | No change to authority/data-integrity surfaces. | ✅ PASS (N/A) |
| **IV Contract-First POS** | **No contract surface touched** — adds no endpoint/OpenAPI. | ✅ PASS (no contract) |
| **XII Authorization & Object Safety** | No new route → no new auth surface. | ✅ PASS (N/A) |

**No Constitution violation. No Complexity-Tracking entry required.**

## Project Structure

### Documentation (this feature)

```
specs/037-observability-sentry-datadog-export/
├── spec.md          # /specify — done
├── plan.md          # this file — /plan
├── research.md      # /clarify resolutions
├── data-model.md    # = "no persisted entities"
├── contracts/
│   └── README.md    # = "no contract surface" (explicit)
├── tasks.md         # /tasks
└── quickstart.md    # how a reviewer validates the slice
```

### Source Code (repository root) — touched at EXECUTION (not now)

```
apps/api/src/
├── instrumentation.ts                 # register Datadog OTLP exporter in startOtel() (US2)
├── observability/
│   └── sentry/sentry.ts               # NEW — Sentry init + beforeSend scrub (US1), DI-seam'd
└── main.ts                            # ensure instrumentation imported first (existing pattern)
apps/worker/src/
├── instrumentation.ts                 # same Datadog exporter registration (US2)
└── observability/sentry/sentry.ts     # NEW — worker Sentry init (US1)
packages/shared/src/observability/     # startOtel() may gain an optional otlpExporter arg (US2)
```

**Structure Decision**: extend the existing `observability/` trees and the `startOtel()` seam; add a `sentry/` submodule mirroring POS-Pulse's main/renderer split (here: api/worker). No new top-level module, no controller, no route.

## Complexity Tracking

None. No new endpoint, schema, or contract; no principle requires a justification entry.

## Open Decisions (route to owner / execution)

- **OD-1** — Datadog ingest: direct OTLP exporter from the app vs Datadog Agent on the droplet as an OTLP collector (ops trade-off).
- **OD-2** — exact synthetics target route list.
- **OD-3** — worker (BullMQ) trace export in this slice vs a later one.
- **OD-4** — retention windows (Constitution XIV / OQ-2) — owner.
