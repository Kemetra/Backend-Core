# Contracts — Spec 037

**No contract surface. No OpenAPI. No new endpoint.**

This feature deliberately authors **zero** API contract artifacts. It is observability wiring on existing seams:

- **Sentry** — outbound SDK egress; no HTTP surface on DP-2.
- **Datadog** — an OTLP exporter registered in the existing `startOtel()` bootstrap; outbound egress, no HTTP surface on DP-2.
- **Synthetics** — Datadog monitors hit **pre-existing** public routes (edge, `/pair`, a read-down route). No route is created, modified, or contractually described here.

Per the DP-2 Constitution **Principle IV (Contract-First POS Integration)** and the orchestrator's no-OpenAPI gate: because this feature introduces no request/response surface, there is nothing to specify contract-first. If any future change to this feature would require a new endpoint (e.g. a dedicated `/healthz` for synthetics), that is **out of scope here** and MUST be raised as a separate, owner-ratified contract decision before implementation — STOP at the OpenAPI boundary.
