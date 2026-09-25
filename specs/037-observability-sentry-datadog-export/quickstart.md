# Quickstart — Validating Spec 037 (reviewer guide)

How a reviewer confirms the slice is correct once implemented. **No step here is run by authoring the spec chain** — this is the execution-time validation guide.

## 1. Default-inert check (no keys)
- Leave `SENTRY_DSN` and all `DD_*`/OTLP keys empty.
- Boot api + worker. Expect: identical-to-today behavior, existing Prometheus drain intact, **zero** Sentry/Datadog egress. (SC-001)

## 2. Sentry error capture (US1, P1 — the MVP)
- Set `SENTRY_DSN` to the `data-pulse-2` Sentry project (preprod).
- Trigger a controlled unhandled exception on a non-production route.
- Expect: a Sentry event appears, **scrubbed** — no Clerk token/JWT, no operator/patient PII, no business/catalog/inventory/sales payload. (SC-002)
- Set a deliberately malformed DSN → service still boots; one warn line, no DSN echoed. (AC-3)

## 3. Datadog metrics/traces (US2)
- Set Datadog keys; register the OTLP exporter.
- Expect: the named signals from `docs/observability/signals.md` appear in Datadog, **no rename**, **no new endpoint**. (SC-003)
- Run a sale-capture request → its spans appear in APM (100% on the checkout path).

## 4. Datadog logs + synthetics (US3)
- Enable log shipping; audit fields against `.specify/memory/redaction-matrix.md`. Expect: **zero** non-compliant fields. (SC-004)
- Confirm synthetics monitors target only pre-existing routes (edge, `/pair`, read-down). (FR-008)

## 5. Redaction audit (gating)
- Across US1 events + US3 logs: confirm zero forbidden keys / zero business payload before pointing any DSN/key at real preprod traffic. This is the privacy gate — do it **before** enabling replay/log shipping on live data.

## Rollback
- Unset the keys → all egress stops immediately (default-inert). No schema/migration to revert (data-model.md: none).
