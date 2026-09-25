# Research & Clarifications — Spec 037

**Phase**: `/clarify`. Resolves scoping ambiguities; routes mechanism detail to `plan.md`/execution. Does not re-decide any owner decision (OD-1..OD-4).

## Resolved

### R1 — Does this add a metrics/health endpoint for Datadog synthetics?
**No.** DP-2 already exposes a Prometheus scrape drain and the OTel layer; synthetics target **existing** public routes (edge, `/pair`, a read-down route). A new endpoint would be contract surface and is excluded. Exact target list → OD-2.

### R2 — Does Datadog metrics export re-instrument code or rename signals?
**No.** It registers a Datadog OTLP `MetricReader`/exporter against the **existing** `getMeter` instruments via `startOtel()`. `signals.md` names are unchanged. Datadog is added as a drain — "the Prometheus exporter is one drain among several" (signals.md). FR-B-007 vendor-neutrality preserved.

### R3 — Where does log redaction for Datadog Logs come from?
The **existing** `.specify/memory/redaction-matrix.md` — single source of truth. Datadog Logs ship already-redacted structured logs. No new redaction policy authored. (Constitution VII/XIV satisfied by reuse.)

### R4 — Sentry scrubbing approach?
Port POS-Pulse's proven posture: `sendDefaultPii: false`, `integrations: []` (review each before enabling), `beforeSend` scrub-or-drop over a forbidden-key set aligned to the redaction matrix, DSN-gated default-inert, DI-seam'd init, init-failure-is-not-launch-halt.

### R5 — How is "default-inert" enforced for both tools?
Empty/missing/whitespace key → the SDK/exporter is never constructed (no-op). This is the committed default (`.env.example` carries empty keys). Mirrors the verified POS-Pulse `SENTRY_DSN=` default.

## Deferred to owner (NOT decided here)

| OD | Question |
|---|---|
| OD-1 | Datadog ingest path: direct OTLP exporter vs droplet Datadog Agent as OTLP collector. |
| OD-2 | Exact synthetics target route list. |
| OD-3 | Worker (BullMQ) trace export now vs later slice. |
| OD-4 | Retention windows per data class (Constitution XIV / Phase 0 OQ-2). |

## Risks

- **Cost (no budget cap yet, Phase 0 OQ-1):** mitigated by conservative default sampling (FR-010); first pilot week's ingestion sets the eventual cap.
- **PII leakage via replay/logs:** N/A for DP-2 logs (matrix-enforced); the replay risk is Console-only (spec 020).
- **Exporter failure blocking requests:** mitigated by FR — telemetry export is non-blocking; failure drops/buffers.
