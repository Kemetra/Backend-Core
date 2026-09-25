# Tasks: Observability — Sentry Errors + Datadog OTLP/Logs Export

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Branch**: `037-observability-sentry-datadog-export`

## Format: `[ID] [P?] [Story] Description`
- **[P]** = parallelizable (different files, no dependency)
- **[Story]** = US1 (Sentry errors) / US2 (Datadog OTLP) / US3 (logs + synthetics)

> **Execution is owner-gated.** These tasks are NOT started by authoring this file. Each touches DP-2 application code/config and runs only when AD-TOOL-003 Phase 1/2 is separately owner-approved and the env keys exist in 1Password. Tests-first per Constitution VI.

## Path Conventions
- API: `apps/api/src/`, worker: `apps/worker/src/`, shared: `packages/shared/src/`.

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 [P] Add `@sentry/node` to `apps/api` + `apps/worker` deps (gated; the only `package.json` change). Add empty `SENTRY_DSN`, `DD_*`/OTLP keys to each `.env.example`.
- [ ] T002 [P] Confirm 1Password entries + droplet env wiring for the new keys (no key committed). Verify `.env.example` defaults are empty (default-inert).

## Phase 2: Foundational (Blocking Prerequisites)

- [ ] T003 Define the DP-2 Sentry forbidden-key set aligned to `.specify/memory/redaction-matrix.md` (single source of truth; do not fork the matrix).
- [ ] T004 Confirm the `startOtel()` signature/seam in `packages/shared` can accept an optional OTLP exporter without changing existing Prometheus-drain behavior (US2 prerequisite).

## Phase 3: User Story 1 — Sentry backend exceptions (P1) 🎯 MVP

### Tests for US1 ⚠️ (write first)
- [ ] T005 [P] [US1] Unit: `initSentry` is a no-op when DSN empty/whitespace (default-inert, AC-1).
- [ ] T006 [P] [US1] Unit: `beforeSend` strips `request`/`user`/forbidden keys and returns `null` when nothing safe remains (AC-2).
- [ ] T007 [P] [US1] Unit: a throwing `sentryInit` is caught, logged once **without** the DSN, service continues (AC-3).

### Implementation for US1
- [ ] T008 [US1] `apps/api/src/observability/sentry/sentry.ts` — DSN-gated init + `beforeSend` scrub-or-drop, DI-seam'd `sentryInit` (mirror POS-Pulse).
- [ ] T009 [US1] `apps/worker/src/observability/sentry/sentry.ts` — same for the worker.
- [ ] T010 [US1] Wire init at module-eval in `apps/{api,worker}/src/main.ts`/`instrumentation.ts` (after, never blocking, the existing OTel bootstrap).

**Checkpoint**: induce a controlled exception in preprod with DSN set → scrubbed event in the `data-pulse-2` Sentry project; empty DSN → identical-to-today boot.

## Phase 4: User Story 2 — Datadog OTLP metrics/traces (P2)

### Tests for US2 ⚠️
- [ ] T011 [P] [US2] Unit: Datadog exporter is NOT registered when keys empty (existing Prometheus drain intact, AC-1).
- [ ] T012 [P] [US2] Unit: registering the OTLP exporter does not rename/duplicate existing `getMeter` signals (AC-2).

### Implementation for US2
- [ ] T013 [US2] Register the Datadog OTLP exporter as an additional drain in `apps/api/src/instrumentation.ts` `startOtel({…})` (per OD-1 ingest decision).
- [ ] T014 [US2] Same registration in `apps/worker/src/instrumentation.ts`.
- [ ] T015 [US2] Apply conservative trace sampling (env-driven; ~10% head + 100% on error/checkout spans, FR-010).

**Checkpoint**: `signals.md` signals appear in Datadog, no rename, no new endpoint.

## Phase 5: User Story 3 — Redacted logs + synthetics (P3)

### Tests for US3 ⚠️
- [ ] T016 [P] [US3] Assert shipped log fields are redaction-matrix-compliant (AC-1).

### Implementation for US3
- [ ] T017 [US3] Configure Datadog Logs shipping of the already-redacted structured logs (WARN+ default, INFO sampled).
- [ ] T018 [US3] Configure Datadog Synthetics against existing routes only (OD-2 target list) — **no new endpoint** (FR-008).

**Checkpoint**: Datadog Logs redaction audit clean; synthetics hit only pre-existing routes.

## Phase N: Polish & Cross-Cutting

- [ ] T019 [P] Update the orchestrator `CLAUDE.md` allowed-egress confirmation reference (already merged PR #169) — verify, don't re-author.
- [ ] T020 Redaction audit (US1 events + US3 logs): zero forbidden keys / zero business payload (SC-002, SC-004).
- [ ] T021 Set Email + Telegram alerting (Phase 0 OQ-5) in-tool (not code).
- [ ] T022 Record first-pilot-week ingestion volume → propose the budget cap (closes Phase 0 OQ-1 / OD-4 retention input).

## Dependencies & Execution Order

- Phase 1 → Phase 2 → US1 (P1, MVP) → US2 (P2) → US3 (P3) → Polish.
- US1 is independently shippable (the MVP): it needs only Phase 1–2, not US2/US3.
- US2 depends on T004 (the `startOtel()` seam). US3 depends on the Datadog account from US2's setup.

### Parallel Opportunities
- T001/T002 parallel. T005/T006/T007 parallel (separate test files). T011/T012 parallel.

### Gate reminder
Every implementation task (T008+) is real DP-2 code/config and is **owner-gated**; do not begin without explicit per-slice approval. No task adds an endpoint, OpenAPI surface, or migration.
