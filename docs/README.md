# Retail Tower OS Backend-Core Documentation

This directory is the public documentation entrypoint for the Retail Tower OS
backend foundation. It is organized for product review, engineering onboarding,
security review, and integration planning.

## Start Here

| Audience | Best first reads |
| --- | --- |
| Product and business reviewers | [README](../README.md), [Architecture](ARCHITECTURE.md), [Foundation spec](../specs/001-foundation-auth-tenant-store/spec.md) |
| Engineering reviewers | [Architecture](ARCHITECTURE.md), [Contributing](../CONTRIBUTING.md), [Foundation plan](../specs/001-foundation-auth-tenant-store/plan.md), [Tasks](../specs/001-foundation-auth-tenant-store/tasks.md) |
| Security reviewers | [Security](../SECURITY.md), [Constitution](../.specify/memory/constitution.md), [Tenant isolation matrix](../specs/001-foundation-auth-tenant-store/tenant-isolation-matrix.md) |
| Integration reviewers | [Contracts package](../packages/contracts/README.md), [OpenAPI contracts](../packages/contracts/openapi), [Foundation quickstart](../specs/001-foundation-auth-tenant-store/quickstart.md) |

## Documentation Map

| Document | Purpose |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | Runtime shape, package boundaries, request flow, worker flow, deployment view, and current intentional gaps. |
| [Live architecture map](architecture/retail-tower-live-map.html) | Interactive Three.js control surface backed by local topology JSON. |
| [Asset guide](assets/README.md) | Visual asset naming, usage, and style guidance for README and docs diagrams. |
| [Contributing](../CONTRIBUTING.md) | Working agreement, local workflow, and contribution expectations. |
| [Security](../SECURITY.md) | Security reporting and project security posture. |
| [Foundation quickstart](../specs/001-foundation-auth-tenant-store/quickstart.md) | Setup and validation guidance for the active foundation feature. |
| [Foundation data model](../specs/001-foundation-auth-tenant-store/data-model.md) | Active feature entities and relationships. |
| [Contracts README](../specs/001-foundation-auth-tenant-store/contracts/README.md) | Feature-level contract documentation. |

## Governance and Project Rules

Project governance artifacts live in `.specify/` — they are process and
decision records, not product runtime code.

| Artifact | Purpose |
| --- | --- |
| [Constitution](../.specify/memory/constitution.md) | Binding architectural and operating principles for the entire repo (v3.0.0). |
| [Architecture impact rule](../.specify/memory/architecture-impact.md) | Pre-flight discipline for architecture-affecting changes. |
| [Decisions](../.specify/memory/decisions/) | Architecture decision records for significant cross-cutting choices. |

## Visual System

The README and architecture docs use GitHub-renderable SVG and Mermaid:

- SVG assets provide a polished product-grade first impression.
- The live architecture map uses a standalone HTML page so GitHub README
  rendering remains static and safe.
- Mermaid diagrams keep technical flows maintainable in Markdown.
- Icons live under `assets/icons/` and share a restrained enterprise SaaS
  style.

## Documentation Rules

- Keep product language truthful to the current backend-first scope.
- Do not imply the dashboard frontend or POS application is implemented in this
  repository.
- Treat `packages/contracts/openapi` as the contract source of truth.
- Keep tenant isolation, auditability, and data integrity visible in
  documentation for any platform behavior.
