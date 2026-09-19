# Retail Tower OS — Product Operating Model

**Status**: Proposed
**Date**: 2026-05-27
**Owner**: Ahmed Shaaban
**Constitution version**: v3.0.0
**Scope**: Documentation only. Defines how capabilities are placed across repositories. Implements nothing.

> Companion documents:
> [product-capability-map.md](product-capability-map.md) ·
> [repo-boundaries.md](repo-boundaries.md) ·
> [feature-placement-rules.md](feature-placement-rules.md) ·
> [future-repo-split-criteria.md](future-repo-split-criteria.md).
> System topology lives in [../ARCHITECTURE.md](../ARCHITECTURE.md); this document
> does not duplicate it.

---

## Executive summary

Retail Tower OS is a multi-tenant retail platform delivered through a small set
of repositories, each with a distinct lifecycle. The single most important
operating rule is:

> **A feature is not a repository.** Every capability starts as a *module* inside
> the repository that already owns its domain. A capability earns its own
> repository only when **deployment cadence, data lifecycle, security boundary,
> or team ownership** clearly diverge from its host — never merely because it is
> "big" or "new".

This keeps the surface area small while the product is still being shaped, avoids
premature distributed-systems cost (cross-repo contracts, duplicated CI, version
skew), and preserves the option to split later when a real boundary appears.

Today the product spans three repositories:

| Repository | Role | Owns |
|---|---|---|
| **Backend-Core** | Backend / source-of-truth | APIs, PostgreSQL schema, RLS/tenancy/security, OpenAPI contracts, workers, outbox/event model, billing & usage backend, analytics v1 APIs, POS sync APIs |
| **POS-Pulse** | Cashier terminal | Cashier UI, local-first/offline behavior, local SQLite state, offline queue, receipt/printer/cash-drawer integration, terminal health client |
| **Retail-Tower-Console** | Admin / management UI | Tenant/store/user management, catalog/inventory/billing/reports/support/demo-tenant screens, terminal-health dashboard |

> **Note on sibling repos.** This document is authored from inside Backend-Core,
> whose evidence (the [Constitution §Repository Scope](../../.specify/memory/constitution.md),
> [README](../../README.md), and specs `001`–`006`) is authoritative for the
> backend boundary. The POS-Pulse and Retail-Tower-Console boundaries below are
> the *intended* division of responsibility; lines that could not be verified
> against those repositories are marked **(unverified — sibling repo not
> inspected)** in [repo-boundaries.md](repo-boundaries.md).

---

## Current repo model

### Backend-Core — backend and source of truth

The authoritative core. Constitution §Repository Scope already designates this
repository as owner of the SaaS backend API, central PostgreSQL database
(source of truth), tenant/store/user/role management, product catalog,
inventory, central sales records, background workers, billing/subscriptions,
reports and analytics, POS sync APIs, webhooks/integrations, and deployment
configuration. All cross-repo communication terminates here through documented,
versioned, authenticated API contracts (Constitution §IV, §The trust boundary).

### POS-Pulse — cashier terminal

The till. Owns everything that must keep working when the network does not: the
cashier UI, the local cart/tender/receipt flow, local device storage, the
offline queue and its sync client, and physical hardware (receipt printer, cash
drawer). It owns terminal-side health reporting but not the authoritative record
of any of it. It holds **no** authoritative catalog, pricing, tenancy, billing,
or authorization truth — those are resolved against Backend-Core contracts.

### Retail-Tower-Console — admin / management UI

The management surface for humans. Owns the operator-facing screens for managing
tenants, stores, users, catalog, inventory, billing, reports, support, the
terminal-health dashboard, and demo-tenant management. It is a **client** of
Backend-Core APIs; it owns presentation and workflow, never business logic, DB
schema, workers, or the OpenAPI source.

---

## Core principle: feature ≠ repo

A capability lives along a lifecycle:

```
module in owning repo  ──(boundary pressure)──▶  separate repository
```

Default placement is a **module** in the repository that owns the capability's
domain (see [feature-placement-rules.md](feature-placement-rules.md)). Splitting
into a new repository is a deliberate, justified step gated on the four boundary
tests in [future-repo-split-criteria.md](future-repo-split-criteria.md). Until
one of those tests is clearly met, the answer is "module, not repo".

---

## Production vs Business definitions

These two words are used throughout the capability map and should mean the same
thing everywhere:

- **Production capability** — required to *run a store safely in production*.
  Failure degrades or halts real retail operations: auth/RBAC, tenant isolation,
  catalog/inventory/sales source-of-truth, audit, observability, and the
  offline-safe POS sale flow. Production capabilities are held to the
  Constitution's non-negotiables (§II RLS, §III backend authority, §XII object
  safety).

- **Business capability** — *monetizes or administers the SaaS* rather than
  running the till. Failure affects the commercial relationship or operator
  experience, not the safety of a sale: billing/subscriptions, usage metering,
  support console, demo/sandbox tenant. Business capabilities are important but
  may degrade more gracefully than Production ones.

(The capability map adds two more axes — **Domain** for retail functionality that
is neither core plumbing nor commercial, and **Future** for explicitly deferred
work. See [product-capability-map.md](product-capability-map.md).)

---

## Recommended operating model

1. **Place by domain owner, not by size.** New work lands as a module in the repo
   that owns its domain. Backend/data/security/contract work → Backend-Core;
   cashier/terminal/hardware/offline work → POS-Pulse; admin/manager/support/
   reporting UI → Retail-Tower-Console.
2. **One contract of record.** OpenAPI in `packages/contracts/openapi/` is the
   only integration surface between repos (Constitution §IV). Sibling repos
   consume generated clients; they never reach into the database or undocumented
   endpoints.
3. **Backend holds the truth.** Authorization, tenancy, pricing, catalog,
   inventory, billing, and audit truth live in Backend-Core (Constitution §III).
   UIs and terminals render and request; they do not decide.
4. **Split only on a real boundary.** Extract a repository only when deployment,
   data lifecycle, security, or team ownership genuinely diverge — and record the
   decision as an ADR before the split.
5. **Record decisions as ADRs.** Architecturally significant choices live in
   `.specify/memory/decisions/`. This operating model is backed by ADRs
   `0002`–`0007`.

---

## Do not split too early

Premature repository splits are expensive and hard to reverse. A split adds a
cross-repo contract to version, a second CI/release pipeline to maintain, a new
permission/ownership surface, and a standing source of version skew — all before
the capability is even validated. The cost is paid immediately and forever; the
benefit is hypothetical until a real boundary exists.

**Rule of thumb:** if you cannot point to a concrete divergence in deployment
cadence, data lifecycle, security boundary, or team ownership, the capability
stays a module. "It feels big" and "it might grow" are not boundaries. When in
doubt, keep it in the owning repo and revisit against
[future-repo-split-criteria.md](future-repo-split-criteria.md).
