# Data Model — Spec 037

**No persisted entities. No schema change. No migration.**

This feature is **egress-only**: it sends telemetry (errors, OTel metrics/traces, logs) to external services. It creates no database table, column, index, or migration, and reads no business data for persistence.

The only "entities" are transient, in-flight telemetry records, all of which are **scrubbed/redacted before egress** and never stored by DP-2:

| Transient record | Origin (existing) | Egress target | Redaction |
|---|---|---|---|
| Unhandled-exception event | thrown error in api/worker | Sentry | `beforeSend` scrub-or-drop, aligned to redaction-matrix |
| OTel metric/trace | existing `getMeter` instruments | Datadog (OTLP) | existing label-policy enforcement (no PII labels) |
| Structured log line | existing logger | Datadog Logs | existing `.specify/memory/redaction-matrix.md` |

**Constitution XIV note:** no new persisted field → no new data classification, retention sweep, or erasure flow is introduced by this feature. Retention of telemetry *in the vendor* is an account-side owner decision (OD-4 / Phase 0 OQ-2), not a DP-2 schema concern.
