# Retail Tower OS — Future Repository Split Criteria

**Status**: Proposed
**Date**: 2026-05-27
**Owner**: Ahmed Shaaban
**Constitution version**: v3.0.0
**Scope**: Documentation only. Defines *when* a capability earns its own
repository, and names the candidate future repositories.

> Read with [retail-tower-operating-model.md](retail-tower-operating-model.md)
> and [feature-placement-rules.md](feature-placement-rules.md).

---

## The four boundary tests

A capability stays a **module** in its owning repository until **at least one**
of these tests is *clearly* met. When one is, open an ADR proposing the split
before creating the repository.

1. **Deployment** — it must ship on a cadence, runtime, or release pipeline that
   is genuinely independent from its host.
2. **Data lifecycle** — its data has a distinct storage, retention, backup, or
   processing lifecycle (e.g. a warehouse, not the OLTP database).
3. **Security boundary** — it requires an isolation, credential, or blast-radius
   boundary that a module cannot provide.
4. **Team ownership** — a distinct team owns it end-to-end with its own roadmap
   and on-call.

If you cannot point to a concrete instance of one of these, the answer is "keep
it a module". See the *do-not-split-too-early* warning in the operating model.

---

## Candidate future repositories

### Retail-Tower-Infra

**Create only when** deployment, secrets, environments, backups, monitoring,
infrastructure-as-code, or disaster recovery need an independent lifecycle from
the application code.

- Until then, infra/deployment config lives in Backend-Core (Constitution
  §Repository Scope lists deployment/infrastructure configuration as owned here).
- Triggering boundary: **deployment** and/or **security**.
- Governing decision: [ADR 0007](../../.specify/memory/decisions/0007-infra-repo-split-conditions.md).

### Retail-Tower-Analytics

**Create only when** reporting moves beyond API queries into a warehouse, dbt,
ClickHouse, Dagster, heavy pipelines, forecasting, or scheduled analytical
workloads.

- Until then, Analytics v1 is a lightweight backend module (API-query reporting).
- Triggering boundary: **data lifecycle** (warehouse ≠ OLTP) and often
  **deployment** (scheduled pipelines).
- Constitution §Analytics and Data Pipeline Standards already prescribes the
  layering/naming/testing rules these workloads must follow.
- Governing decision: [ADR 0006](../../.specify/memory/decisions/0006-analytics-module-before-analytics-repo.md).

### Retail-Tower-Integrations

**Create only when** webhooks, API keys, ERP/accounting connectors, retry/DLQ
handling, external credentials, and connector lifecycle become substantial.

- Until then, integrations/webhooks are a backend module.
- Triggering boundary: **security** (external credentials, blast radius) and
  **team ownership** (connector roadmap).

### Retail-Tower-Mobile

**Defer** until manager mobile workflows are validated. Do not create on
speculation.

- Triggering boundary: **team ownership** + validated demand. Until validated,
  manager workflows are served by Retail-Tower-Console (responsive web).

### Retail-Tower-Docs

**Create only when** external customer or developer documentation needs an
independent publishing lifecycle (its own site, release cadence, and
contributors).

- Until then, docs live in-repo under `docs/`.
- Triggering boundary: **deployment** (independent publishing) + **team
  ownership** (docs/devrel).

---

## Process for a split

1. Confirm at least one boundary test is clearly met (not speculative).
2. Open an ADR under `.specify/memory/decisions/` proposing the split, its
   contract surface, and its data ownership.
3. Get the decision accepted (Constitution §Governance / standing rules).
4. Only then create the repository and migrate the module — preserving the
   OpenAPI contract boundary with Backend-Core.

No split happens by drift. If a module is quietly growing, that is a prompt to
*evaluate* against these criteria — not a reason to split automatically.
