<div align="center">

<img src="docs/assets/brand/data-pulse-2-logo.svg" alt="Retail Tower OS Backend-Core logo" width="120" height="120"/>

# Retail Tower OS

**The command tower for modern retail. Control every branch from one secure core.**

<p align="center">
  <a href="docs/brand/retail-tower-os.md"><img alt="Product: Retail Tower OS" src="https://img.shields.io/badge/product-Retail%20Tower%20OS-0f766e?style=flat-square"></a>
  <a href="https://github.com/Kemetra/Backend-Core"><img alt="Repo: Backend-Core" src="https://img.shields.io/badge/repo-Backend--Core-181717?style=flat-square&logo=github&logoColor=white"></a>
  <a href="apps/api"><img alt="Platform: backend-first" src="https://img.shields.io/badge/platform-backend--first-334155?style=flat-square"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-059669?style=flat-square"></a>
</p>

<p align="center">
  <a href=".nvmrc"><img alt="Node.js >=20" src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodedotjs&logoColor=white"></a>
  <a href="package.json"><img alt="pnpm 9.15.0" src="https://img.shields.io/badge/pnpm-9.15.0-f69220?style=flat-square&logo=pnpm&logoColor=white"></a>
  <a href="tsconfig.base.json"><img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white"></a>
  <a href="apps/api"><img alt="NestJS 11" src="https://img.shields.io/badge/NestJS-11-e0234e?style=flat-square&logo=nestjs&logoColor=white"></a>
  <a href="packages/contracts/openapi"><img alt="OpenAPI 3.1" src="https://img.shields.io/badge/OpenAPI-3.1-6ba539?style=flat-square&logo=openapiinitiative&logoColor=white"></a>
  <a href="docs/assets/badges/loc.svg"><img alt="LOC" src="docs/assets/badges/loc.svg"></a>
</p>

<p align="center">
  <a href=".specify/memory/constitution.md"><img alt="Tenant isolation: RLS enforced" src="https://img.shields.io/badge/tenant%20isolation-RLS%20enforced-0f766e?style=flat-square"></a>
  <a href="packages/contracts"><img alt="API: contract-first" src="https://img.shields.io/badge/API-contract--first-2563eb?style=flat-square"></a>
  <a href=".specify/memory/constitution.md"><img alt="Audit: provenance first" src="https://img.shields.io/badge/audit-provenance%20first-7c3aed?style=flat-square"></a>
  <a href="SECURITY.md"><img alt="Security: default deny" src="https://img.shields.io/badge/security-default%20deny-dc2626?style=flat-square"></a>
  <a href="docs/agent-os/standing-rules.md"><img alt="Agent OS: slice governed" src="https://img.shields.io/badge/Agent%20OS-slice%20governed-111827?style=flat-square"></a>
</p>

![Retail Tower OS — The command tower for modern retail](docs/assets/brand/exterior/retail-tower-os-exterior-hero.png)

</div>

> **Retail Tower OS** is the external product identity for this platform. The canonical backend repository is [`Kemetra/Backend-Core`](https://github.com/Kemetra/Backend-Core). Legacy internal namespaces such as `@data-pulse-2/*`, `data_pulse_2`, and `dp2-*` remain intentionally stable.
>
> The image above represents **product vision**. It does not imply that a dashboard frontend, POS application, or production operations UI is implemented in this repository. The POS application is a separate repository that integrates through the OpenAPI contracts in `packages/contracts/openapi/`.

See [`docs/brand/retail-tower-os.md`](docs/brand/retail-tower-os.md) for the full brand identity record, approved imagery, scope notes, and usage guidelines.

---

## 🔗 Synchronization — Backend-Core at the Core

Backend-Core is the **single contract boundary** of Retail Tower OS. Every edge (POS-Pulse,
Console) syncs through it; only the ERPNext Connector ever reaches ERPNext. Resolved catalog
flows **down** to the edges; sales & inventory rise **up** toward ERPNext via the connector
posting feed.

<p align="center">
  <img src="docs/assets/architecture/retail-tower-sync-flow.svg" alt="Animated Retail Tower OS synchronization diagram, Backend-Core at the core" width="100%"/>
</p>

```text
POS-Pulse ─┐
           ├─▶  Backend-Core  ─▶  ERPNext Connector  ─▶  ERPNext / Frappe
Console  ──┘        ▲ the only contract boundary
```

### Where Backend-Core sits — the full ecosystem

Zooming out from the sync flow above, the diagram below places **Backend-Core** within the complete five-repository Retail Tower OS ecosystem, governed by the Retail Tower Orchestrator control plane on top.

<p align="center">
  <img src="docs/assets/architecture/retail-tower-ecosystem.svg" alt="Retail Tower OS ecosystem: the Retail Tower Orchestrator control plane governs five repositories; POS and Admin-Console synchronize through Backend-Core, the single contract boundary, which reaches ERPNext only through the ERPNext-Connector" width="100%"/>
</p>

<p align="center"><sub>Backend-Core (the gold <strong>★ THIS REPO</strong> node) is the highlighted contract-boundary hub. Live animated SVG; motion is suppressed under <code>prefers-reduced-motion</code>.</sub></p>

Full detail (flow + sequence + boundary guarantees):
[docs/architecture/synchronization.md](docs/architecture/synchronization.md) ·
Program control plane: [Orchestrator](https://github.com/Kemetra/Orchestrator).

---

## Live architecture control map

[![Retail Tower OS live architecture control map preview](docs/assets/architecture/retail-tower-live-map-preview.svg)](docs/architecture/retail-tower-live-map.html)

Open the [interactive Three.js architecture map](docs/architecture/retail-tower-live-map.html) for a full-screen, repo-backed view of the platform topology. The live map reads [topology JSON](docs/architecture/retail-tower-live-map.json), links every node back to source paths, and keeps the README safe by using a static SVG preview here.

---

## Repository structure flow

Every layer of the platform — from client ingress to durable state — is laid out in a single animated diagram, framed by contracts & governance on the left and observability & ops on the right.

![Retail Tower OS animated repository structure flow](docs/assets/architecture/retail-tower-os-structure-flowchart.svg)

Open [the full-resolution animated view](docs/assets/architecture/retail-tower-os-structure-flowchart.svg). Tokens trace each authenticated path: dashboard cookies and POS bearer tokens into the NestJS API, through auth → tenant → roles → idempotency guards, into the RLS-bound service layer, into PostgreSQL, with outbox events fanning out via Redis to the worker — and live contract, observability, and audit taps illuminated alongside.

---

## Current implementation status

No single feature is currently active in this repository. The backend platform has shipped several foundation slices; dashboard UI and POS app implementation remain separate/deferred surfaces.

| Area | Status | Evidence |
| --- | --- | --- |
| Auth, tenant/store foundation, memberships, audit | Shipped | [`specs/001-foundation-auth-tenant-store`](specs/001-foundation-auth-tenant-store) |
| POS operator identity | Spec and contracts | [`specs/002-pos-operator-identity`](specs/002-pos-operator-identity) |
| Catalog foundation | Shipped | [`specs/003-catalog-foundation`](specs/003-catalog-foundation) |
| Production readiness | PASS for exercised paths; documented partials remain | [`docs/production-readiness/004-closeout-status.md`](docs/production-readiness/004-closeout-status.md) |
| POS catalog sync and reconciliation | Closed on `main` | [`specs/005-pos-catalog-sync-reconciliation`](specs/005-pos-catalog-sync-reconciliation) |
| Unknown items review queue | Docs-only product brief complete | [`specs/006-unknown-items-review-queue`](specs/006-unknown-items-review-queue) |
| Unknown items review queue API | Execution map in place | [`specs/007-unknown-items-review-queue-api`](specs/007-unknown-items-review-queue-api) |

---

## What you can verify today

| Claim | Repo-backed evidence |
| --- | --- |
| Tenant isolation is a platform invariant | [Constitution](.specify/memory/constitution.md) · [database package](packages/db) |
| API behavior is contract-first | [OpenAPI contracts](packages/contracts/openapi) · [contracts package](packages/contracts/README.md) |
| Audit provenance is first-class | [audit API module](apps/api/src/audit) · [outbox lifecycle](docs/outbox/lifecycle.md) |
| Async work belongs in workers | [worker app](apps/worker) · [queue config](packages/shared/src/queues) |
| Security posture is default-deny | [Security policy](SECURITY.md) · [request pipeline](#request-pipeline) |
| Agent work is slice-governed | [Agent OS standing rules](docs/agent-os/standing-rules.md) · [Maestro playbook](docs/agent-os/maestro-playbook.md) |

---

## Getting started

**Prerequisites.** Node.js 20+ · pnpm 9.15.0+ · Docker Desktop (or another Docker-compatible runtime) for local PostgreSQL and Redis.

```bash
pnpm install            # install dependencies
pnpm db:up              # bring local Postgres + Redis up
pnpm build              # build all packages
pnpm test               # run the test suite
pnpm lint               # eslint + prettier --check
```

The development compose stack exposes:

- PostgreSQL: `postgres://dp2:dp2_dev_password@localhost:5432/data_pulse_2` (the password defaults to `dp2_dev_password`; set `POSTGRES_PASSWORD` before `docker compose up` to override it, and use the same value in `DATABASE_URL`)
- Redis: `redis://localhost:6379`

For local API and worker runs, set:

```bash
DATABASE_URL=postgres://dp2:dp2_dev_password@localhost:5432/data_pulse_2
# Production only: distinct, narrowly granted pre-tenant auth lookup role.
AUTH_LOOKUP_DATABASE_URL=postgres://dp2_auth_lookup:replace_me@localhost:5432/data_pulse_2
REDIS_URL=redis://localhost:6379
```

Then start the services:

```bash
pnpm --filter @data-pulse-2/api start
pnpm --filter @data-pulse-2/worker start
```

During development, package-level `start:dev` scripts compile in watch mode where available.

**Verify startup.** After starting the API, check the terminal output for a pino log line confirming the server is listening (default port `3000`). No unauthenticated health endpoint is exposed — a clean startup log is the expected signal. For a full behavior walkthrough, see the [foundation quickstart](specs/001-foundation-auth-tenant-store/quickstart.md).

---

## What Retail Tower OS controls

The platform that stands behind every branch — multi-tenant architecture, catalog authority, POS connectivity, access control, and audit provenance unified under one secure operating core.

<table>
<tr>
<td width="33%" align="center" valign="top">
  <img src="docs/assets/brand/icons/branch-ops.svg" width="56" alt=""/><br/>
  <strong>Branch operations</strong><br/>
  <sub>Multi-tenant isolation and store hierarchy managed from a single command core.</sub>
</td>
<td width="33%" align="center" valign="top">
  <img src="docs/assets/brand/icons/catalog.svg" width="56" alt=""/><br/>
  <strong>Catalog authority</strong><br/>
  <sub>Global product index propagated through tenant and store layers with store-level override.</sub>
</td>
<td width="33%" align="center" valign="top">
  <img src="docs/assets/brand/icons/store-network.svg" width="56" alt=""/><br/>
  <strong>Store network</strong><br/>
  <sub>Connected branch context carried at every API, database, and job boundary.</sub>
</td>
</tr>
<tr>
<td align="center" valign="top">
  <img src="docs/assets/brand/icons/access-control.svg" width="56" alt=""/><br/>
  <strong>Access control</strong><br/>
  <sub>Role-based identity for operators and staff, scoped to tenant and store.</sub>
</td>
<td align="center" valign="top">
  <img src="docs/assets/brand/icons/integrations.svg" width="56" alt=""/><br/>
  <strong>POS connectivity</strong><br/>
  <sub>The API gateway POS applications connect to through authenticated, versioned contracts.</sub>
</td>
<td align="center" valign="top">
  <img src="docs/assets/brand/icons/audit-compliance.svg" width="56" alt=""/><br/>
  <strong>Audit provenance</strong><br/>
  <sub>Every mutation is traceable; sale facts are immutable once committed.</sub>
</td>
</tr>
<tr>
<td colspan="3" align="center" valign="top">
  <img src="docs/assets/brand/icons/security.svg" width="56" alt=""/><br/>
  <strong>Secure core</strong><br/>
  <sub>Multi-layer security — tenant RLS, token auth, and audit trail — built in from the start.</sub>
</td>
</tr>
</table>

> This table describes **platform scope and product vision**, not a list of implemented UI features. The POS application is a separate repository. Dashboard UI is a separate future feature.

---

## Architecture at a glance

![Retail Tower OS animated system map](docs/assets/architecture/retail-tower-os-system-map.svg)

Retail Tower OS is implemented here as the `Backend-Core` backend platform: a NestJS API, BullMQ worker runtime, OpenAPI contracts, PostgreSQL source of truth, Redis coordination, and shared platform packages. The diagram above renders animated data tokens travelling each authenticated path — clients to gateway, gateway to system of record, gateway to queue, queue to async runtime.

See [Architecture](docs/ARCHITECTURE.md) for request flow, tenant boundaries, worker flow, and catalog source-of-truth layers.

---

## Request pipeline

Every authenticated call travels the same guard chain. The animated token below traces one request from ingress to response envelope.

<div align="center">
<img src="docs/assets/architecture/retail-tower-os-request-flow.svg" width="560" alt="Retail Tower OS animated API request flow"/>
</div>

| Step | Guard / stage | Purpose |
| :--: | --- | --- |
| **1** | Ingress | Assign request id · helmet · cookies · body parse |
| **2** | Validation | Zod body validation · uniform error envelope |
| **3** | `AuthGuard` | Session token or bearer · constant-time compare |
| **4** | `TenantContextGuard` | Resolve tenant + store · cross-tenant access → safe 404 |
| **5** | `RolesGuard` | Role · permission · default deny |
| **6** | Service layer | Business logic · tenant-scoped DB access · RLS-enforced |
| **7** | Audit log | Actor · tenant · store · op · outcome · correlationId |
| **8** | Response | Uniform envelope · includes request id |

---

## Platform guarantees

Retail data systems become expensive when tenant boundaries, store ownership, audit trails, and POS integration contracts are treated as afterthoughts. This platform makes those rules explicit from the start.

| Guarantee | What it enforces |
| --- | --- |
| <img src="docs/assets/icons/tenant-isolation.svg" width="32" alt=""> **Tenant isolation** | Tenant and store context are first-class at the API, database, and test layers. |
| <img src="docs/assets/icons/contracts.svg" width="32" alt=""> **Contract-first APIs** | OpenAPI 3.1 contracts are the integration source of truth, not generated side effects. |
| <img src="docs/assets/icons/audit.svg" width="32" alt=""> **Auditability** | Security-sensitive workflows preserve actor, tenant, operation, outcome, and correlation context. |
| <img src="docs/assets/icons/worker.svg" width="32" alt=""> **Worker-owned async jobs** | Email, fanout, retries, and future scheduled work live outside request handlers. |
| <img src="docs/assets/icons/observability.svg" width="32" alt=""> **Operational visibility** | Request IDs, structured logging, and OpenTelemetry primitives are built into the platform layer. |
| <img src="docs/assets/icons/database.svg" width="32" alt=""> **Durable source of truth** | PostgreSQL remains authoritative; Redis-backed state is disposable coordination. |

---

## Platform shape

`Backend-Core` is a pnpm workspace with two deployable services and four internal packages. The API owns synchronous HTTP behavior; the worker owns asynchronous processing; PostgreSQL owns durable state; Redis coordinates queues.

```mermaid
flowchart LR
  clients["Dashboard / API clients<br/>future consumers"]
  pos["POS clients<br/>external repo"]
  api["apps/api<br/>NestJS HTTP API"]
  worker["apps/worker<br/>NestJS worker"]
  contracts["packages/contracts<br/>OpenAPI 3.1"]
  auth["packages/auth<br/>passwords and tokens"]
  db["packages/db<br/>schema and migrations"]
  shared["packages/shared<br/>errors, logs, ids, queues"]
  pg[("PostgreSQL 16<br/>system of record")]
  redis[("Redis 7<br/>BullMQ coordination")]

  clients --> api
  pos -. authenticated contracts .-> api
  api --> contracts
  api --> auth
  api --> db
  api --> shared
  api --> pg
  api -- enqueue jobs --> redis
  worker -- consume jobs --> redis
  worker --> shared
```

---

## Repository map

| Path | Purpose |
| --- | --- |
| `apps/api` | NestJS HTTP API · auth · active context · validation · request IDs · logging · exception envelopes · OpenAPI loading |
| `apps/worker` | Standalone NestJS worker runtime for BullMQ-backed background processing |
| `packages/auth` | Password hashing · token hashing · session types · auth primitives |
| `packages/contracts` | OpenAPI 3.1 YAML contracts of record |
| `packages/db` | Drizzle schema · explicit SQL migrations · tenant helpers · migration CLI |
| `packages/shared` | Shared Zod helpers · error envelopes · logging · observability · IDs · queue config |
| `specs/001-foundation-auth-tenant-store` | Foundation feature artifacts (shipped) |
| `specs/002-pos-operator-identity` | POS operator identity specification and contracts (POS app lives in a separate repo) |
| `specs/003-catalog-foundation` | Catalog foundation feature (shipped) |
| `specs/004-platform-production-readiness` | Production readiness artifacts; exercised API/worker/outbox paths passed with documented partials |
| `specs/005-pos-catalog-sync-reconciliation` | POS catalog sync and reconciliation feature (closed on `main`) |
| `specs/006-unknown-items-review-queue` | Unknown items review queue product brief (docs-only scope complete) |
| `specs/007-unknown-items-review-queue-api` | Unknown items review queue API execution map and coordination artifacts |
| `docs` | Architecture · live control map · documentation index · brand · agent-os · presentation assets |
| `.specify` | Constitution v3.0.0 · architecture impact · redaction matrix · slice templates · integration manifests |
| `.github` | CI workflows · PR + issue templates |
| `scripts`, `tools`, `loadtests` | LOC badge automation · custom ESLint rules · k6 perf scenarios |

### What this repo owns
Multi-tenant SaaS backend foundation · admin/dashboard backend APIs and shared contracts · worker runtime and queue integration patterns · PostgreSQL schema, migrations, and tenant helpers · shared platform primitives for auth, observability, validation, and errors.

### What this repo does **not** own
POS application code · dashboard frontend implementation · production infrastructure manifests beyond local development support · legacy `Data-Pulse` code as source material (reference only, must be re-specified).

---

## Tech stack

| Layer | Stack |
| --- | --- |
| Runtime | Node.js 20 LTS · pnpm 9.15 · TypeScript 5 strict mode |
| API | NestJS 11 · Express platform · Helmet · cookie-parser · Zod validation |
| Data | PostgreSQL 16 · Drizzle schema · explicit SQL migrations |
| Jobs | Redis 7 · BullMQ |
| Observability | pino · OpenTelemetry SDK · HTTP/Postgres/Redis instrumentation · Prometheus exporter |
| Auth | argon2id · opaque revocable bearer tokens · httpOnly cookie sessions |
| Testing | Jest · ts-jest · Supertest · Testcontainers PostgreSQL |
| IDs | UUIDv7 with UUIDv4 fallback |

---

## Documentation

The [documentation index](docs/README.md) is the main hub, with audience-based navigation for product, engineering, security, and integration reviewers.

| Audience | First reads |
| --- | --- |
| **Product & brand** | [Brand identity](docs/brand/retail-tower-os.md) · [Icon system](docs/brand/icon-system.md) |
| **Engineering** | [Architecture](docs/ARCHITECTURE.md) · [Foundation quickstart](specs/001-foundation-auth-tenant-store/quickstart.md) · [Contributing](CONTRIBUTING.md) |
| **Security** | [Security policy](SECURITY.md) · [Constitution](.specify/memory/constitution.md) |
| **Integration** | [Contracts package](packages/contracts/README.md) · [POS operator identity spec](specs/002-pos-operator-identity/spec.md) |
| **Operations** | [Observability signals](docs/observability/signals.md) · [Outbox lifecycle](docs/outbox/lifecycle.md) · [Idempotency strategy](docs/idempotency/strategy.md) |

---

## Development agreement

This platform follows the active Constitution and Spec Kit workflow. Start from the current spec, keep changes thin, preserve tenant isolation, and do not change dependency manifests, lockfiles, SQL migrations, or database schema without explicit approval.

---

## License

MIT. See [LICENSE](LICENSE).
