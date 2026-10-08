<div align="center">

<h1 align="center">
  <img src="docs/assets/readme/hero.svg" alt="Retail Tower OS, Backend-Core track: one product, four development tracks, with AI woven through all of them" width="100%"/>
</h1>

<p align="center">
  <a href="docs/brand/retail-tower-os.md"><img alt="Retail Tower OS" src="https://img.shields.io/badge/Retail%20Tower-OS-0f766e?labelColor=0a0f24&style=flat-square"></a>
  <a href="#-ai-is-native-to-the-architecture-and-the-design"><img alt="AI embedded by design" src="https://img.shields.io/badge/AI-embedded%20by%20design-a78bfa?labelColor=0a0f24&style=flat-square"></a>
  <a href=".specify/memory/constitution.md"><img alt="Tenant isolation: RLS enforced" src="https://img.shields.io/badge/tenant%20isolation-RLS-14b8a6?labelColor=0a0f24&style=flat-square"></a>
  <a href="packages/contracts"><img alt="API: contract-first" src="https://img.shields.io/badge/API-contract--first-60a5fa?labelColor=0a0f24&style=flat-square"></a>
  <a href="SECURITY.md"><img alt="Security: default deny" src="https://img.shields.io/badge/security-default--deny-f87171?labelColor=0a0f24&style=flat-square"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-34d399?labelColor=0a0f24&style=flat-square"></a>
</p>

<p align="center">
  <a href=".nvmrc"><img alt="Node.js 20+" src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white&labelColor=0a0f24&style=flat-square"></a>
  <a href="package.json"><img alt="pnpm 9.15" src="https://img.shields.io/badge/pnpm-9.15-f69220?logo=pnpm&logoColor=white&labelColor=0a0f24&style=flat-square"></a>
  <a href="tsconfig.base.json"><img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white&labelColor=0a0f24&style=flat-square"></a>
  <a href="apps/api"><img alt="NestJS 11" src="https://img.shields.io/badge/NestJS-11-e0234e?logo=nestjs&logoColor=white&labelColor=0a0f24&style=flat-square"></a>
  <a href="packages/contracts/openapi"><img alt="OpenAPI 3.1" src="https://img.shields.io/badge/OpenAPI-3.1-6ba539?logo=openapiinitiative&logoColor=white&labelColor=0a0f24&style=flat-square"></a>
  <a href="https://github.com/Kemetra/Backend-Core/blob/badges/loc.svg"><img alt="LOC" src="https://raw.githubusercontent.com/Kemetra/Backend-Core/badges/loc.svg"></a>
</p>

<p align="center">
  <a href="#-one-project-four-tracks"><b>Tracks</b></a> &nbsp;·&nbsp;
  <a href="#-ai-is-native-to-the-architecture-and-the-design"><b>AI</b></a> &nbsp;·&nbsp;
  <a href="#current-implementation-status"><b>Status</b></a> &nbsp;·&nbsp;
  <a href="#integration-surfaces"><b>Contracts</b></a> &nbsp;·&nbsp;
  <a href="#getting-started"><b>Get started</b></a> &nbsp;·&nbsp;
  <a href="docs/README.md"><b>Docs</b></a>
</p>

</div>

> **Retail Tower OS** is the product; this repository, [`Kemetra/Backend-Core`](https://github.com/Kemetra/Backend-Core), is its backend track. It contains no POS, frontend or ERPNext code: those live in the sibling tracks below and connect only through the OpenAPI contracts in `packages/contracts/openapi/`. Legacy internal names (`@data-pulse-2/*`, `data_pulse_2`, `dp2-*`) stay stable. Brand record: [`docs/brand/retail-tower-os.md`](docs/brand/retail-tower-os.md).

---

## 🧩 One project, four tracks

<p align="center">
  <img src="docs/assets/readme/tracks.svg" alt="Data flow: POS and Admin-Console talk to Backend-Core, which feeds the ERPNext-Connector, the only path to ERPNext. An AI layer runs through all four tracks." width="100%"/>
</p>

| Track | Repository | Owns |
| --- | --- | --- |
| **Backend-Core** ◀ you are here | [`Kemetra/Backend-Core`](https://github.com/Kemetra/Backend-Core) | APIs · data · workers · tenant/store context · sync operations |
| **POS** | [`Kemetra/POS`](https://github.com/Kemetra/POS) | Windows cashier terminal · offline state · receipts |
| **Admin-Console** | [`Kemetra/Admin-Console`](https://github.com/Kemetra/Admin-Console) | Operator web UI · catalog · inventory views · sync ops |
| **ERPNext-Connector** | [`Kemetra/ERPNext-Connector`](https://github.com/Kemetra/ERPNext-Connector) | The only ERPNext/Frappe adapter · DocType mapping · posting |

<sub>One architecture, one set of contracts, one AI-embedded design. [`Kemetra/Orchestrator`](https://github.com/Kemetra/Orchestrator) is the technical handbook, not a track.</sub>

---

## 🧠 AI is native to the architecture and the design

<p align="center">
  <img src="docs/assets/readme/ai-embedded.svg" alt="AI-integrated: the AI sits outside the boundary and reaches the system through a side channel. AI-embedded: the AI runs through every layer inside the boundary, under the same rules." width="100%"/>
</p>

<table>
<tr>
<td width="25%" valign="top"><b>🔒 Same boundary</b><br/><sub>Same OpenAPI contracts, tenant/store context and idempotency as POS and Console. No side door.</sub></td>
<td width="25%" valign="top"><b>🧾 Auditable</b><br/><sub>Every action keeps its provenance, so AI-driven decisions can be traced, reviewed and reversed.</sub></td>
<td width="25%" valign="top"><b>🏢 Tenant-safe</b><br/><sub>RLS-enforced isolation is a platform invariant (<a href=".specify/memory/constitution.md">constitution</a>). Intelligence never crosses it.</sub></td>
<td width="25%" valign="top"><b>🧑‍⚖️ Human-governed</b><br/><sub>Authority, scope and approval stay with people. AI works inside them.</sub></td>
</tr>
</table>

> AI-embedded describes the architectural and design direction. What is shipped today is tracked in [Current implementation status](#current-implementation-status) and under [`specs/`](specs).

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

> **Source of truth.** GitHub `main` is the technical truth for what is implemented; active work and priorities are tracked in Jira (project **RT**). The `Status:` headers inside individual `specs/*/spec.md` files are written at spec time and often lag the code, so the table below is derived from what exists on `main` (controllers, workers, migrations, OpenAPI contracts), not from those headers.

The backend is well past the foundation slices. As of the baseline below it ships the full retail-to-ERP loop on the Retail Tower side: catalog, POS sale capture, inventory ledger, shifts and cash-up, receivable settlement, and the contracts the ERPNext Connector consumes.

| Capability | State on `main` | Contract (`packages/contracts/openapi`) | Spec |
| --- | --- | --- | --- |
| Auth, tenants, stores, memberships, audit | Implemented | `auth` · `tenants` · `stores` · `memberships` · `context` · `audit` · `health` | [`001`](specs/001-foundation-auth-tenant-store) |
| POS operator identity, terminal pairing, cashier admissions | Implemented | `pos-operators` · `pos-terminal-pairing` · `pos-cashier-admissions` | [`002`](specs/002-pos-operator-identity) · [`027`](specs/027-pos-terminal-pairing-consume) · [`028`](specs/028-pos-auth-boundary-and-operator-lifecycle)–[`034`](specs/034-pos-roster-cashier-user-id) |
| Catalog (tenant, store override, unknown-items review) and POS catalog read-down | Implemented | `catalog/unknown-items` · `catalog/read-down` | [`003`](specs/003-catalog-foundation) · [`005`](specs/005-pos-catalog-sync-reconciliation)–[`007`](specs/007-unknown-items-review-queue-api) · [`010`](specs/010-pos-catalog-read-down-sync) |
| POS sale capture, void / refund / returns, sync status and repair | Implemented | `pos-sales` · `sale-sync-ops` | [`008`](specs/008-sales-transaction-capture) · [`032`](specs/032-pos-sale-capture-sync-status-and-idempotency-contract) |
| Inventory stock ledger, transfers, counts | Implemented | `inventory` | [`009`](specs/009-inventory-stock-ledger) |
| POS shifts, cash-up, stuck-shift handling | Implemented | `pos-shifts` | tracked in Jira RT |
| Sale settlement and receivables (payer accounts, claims, remittance reconciliation) | Implemented | `settlement` | [`035`](specs/035-sale-settlement-and-receivables-model) · [`036`](specs/036-settlement-posting-feed-extension) |
| ERPNext integration: posting feed, stock view, item/warehouse maps, product and stock reconciliation, connector health | Implemented on the Backend-Core side; live cross-system validation against a staging ERPNext is tracked separately | `erpnext-connector` · `erpnext-reconciliation` · `erpnext-sync-ops` · `catalog/erpnext-*` · `connector` | [`011`](specs/011-erpnext-pos-reference-and-integration-foundation)–[`021`](specs/021-product-master-reconciliation-v1) · [`025`](specs/025-console-sync-ops-read-model-v1) |
| Observability (pino, OpenTelemetry, Prometheus) | Implemented | n/a | [`004`](specs/004-platform-production-readiness) · [`docs/observability`](docs/observability) |
| Sentry / Datadog export | Spec only; no implementation on `main` | n/a | [`037`](specs/037-observability-sentry-datadog-export) |
| Sales-posting command contract | Plan only | n/a | [`023`](specs/023-sales-posting-command-contract-v1) |
| Returns / reversal contract to ERP | Open determination, not a build slice | n/a | [`026`](specs/026-returns-reversal-contract) |

Not yet owned or deferred here: tax and fiscal rules for Egypt, and any payment-card capture. See [`docs/production-readiness`](docs/production-readiness) for what was exercised and the documented partials.

**Baseline for this table:** 36 SQL migrations (`packages/db/drizzle`, numbered `0000`–`0036`), 29 OpenAPI contract files, an API with 33 controller files, and a worker with outbox, ERP posting, ERP reconciliation, sale processing, audit, email and cleanup processors. Re-verify against `main` before relying on it.

---

## What you can verify today

| Claim | Repo-backed evidence |
| --- | --- |
| Tenant isolation is a platform invariant | [Constitution](.specify/memory/constitution.md) · [database package](packages/db) |
| API behavior is contract-first | [OpenAPI contracts](packages/contracts/openapi) · [contracts package](packages/contracts/README.md) |
| Audit provenance is first-class | [audit API module](apps/api/src/audit) · [outbox lifecycle](docs/outbox/lifecycle.md) |
| Async work belongs in workers | [worker app](apps/worker) · [queue config](packages/shared/src/queues) |
| Security posture is default-deny | [Security policy](SECURITY.md) · [request pipeline](#request-pipeline) |
| Work is issue-governed; `main` is the technical truth | [Standing rules](docs/agent-os/standing-rules.md) · [Constitution](.specify/memory/constitution.md) (the Maestro slice-dispatch workflow in `docs/agent-os` is historical) |
| Liveness and readiness probes are public and credential-free | [`health.openapi.yaml`](packages/contracts/openapi/health.openapi.yaml) · [`apps/api/src/health`](apps/api/src/health) |

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

**Verify startup.** After starting the API, check the terminal output for a pino log line confirming the server is listening (default port `3000`). Then probe `GET /api/v1/health/live` (process is up) and `GET /api/v1/health/ready` (returns 503 when a required dependency is down); both are unauthenticated. For a full behavior walkthrough, see the [foundation quickstart](specs/001-foundation-auth-tenant-store/quickstart.md).

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

> This table describes **platform scope and product vision**, not a list of implemented UI features. The POS terminal ([`Kemetra/POS`](https://github.com/Kemetra/POS)) and the admin frontend ([`Kemetra/Admin-Console`](https://github.com/Kemetra/Admin-Console)) are separate repositories that consume this backend.

---

## Integration surfaces

Each edge talks to Backend-Core through its own contract family. Nothing else may reach the database or ERPNext.

| Consumer | Path prefix | Contracts |
| --- | --- | --- |
| **POS terminals** (`Kemetra/POS`) | `/api/pos/v1/*` | `pos-terminal-pairing` · `pos-operators` · `pos-cashier-admissions` · `pos-shifts` · `pos-sales` · `catalog/read-down` · `catalog/unknown-items` · `pos-audit-events` |
| **Admin-Console** (`Kemetra/Admin-Console`) | `/api/v1/*` | `auth` · `tenants` · `stores` · `memberships` · `context` · `audit` · `settlement` · `sale-sync-ops` · `erpnext-sync-ops` · `catalog/*` |
| **ERPNext-Connector** (`Kemetra/ERPNext-Connector`) | `/api/connector/v1/erpnext/*` | `erpnext-connector/posting-feed` · `erpnext-connector/stock-view` · `erpnext-connector/connector-health` |

Inventory is exposed under `/api/inventory/v1/*` (`inventory`). The ERPNext boundary is pull-based: the connector fetches the posting feed and reports an outcome per work item, and Backend-Core never calls ERPNext/Frappe directly.

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
  clients["Admin-Console<br/>external repo"]
  pos["POS terminals<br/>external repo"]
  connector["ERPNext-Connector<br/>external repo"]
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
  connector -. posting feed and stock view .-> api
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
| `specs` | Spec Kit artifacts per feature, `001`–`037`: foundation and auth (`001`–`004`), catalog and POS sync (`005`–`010`), ERPNext integration arc (`011`–`026`), POS auth boundary and operator lifecycle (`027`–`034`), settlement and receivables (`035`–`036`), observability export (`037`). Design records, not the authority for current behavior; see [Current implementation status](#current-implementation-status) |
| `apps/api/src/{catalog,inventory,settlement,pos-*,connector*}` | Domain modules: catalog and ERPNext maps/reconciliation, sales capture and sync ops, inventory ledger, settlement, POS operators, shifts, cashier admissions, terminal pairing, connector registration and health |
| `apps/worker/src/{outbox,erpnext-*,sales,inventory,audit,email,cleanup}` | Outbox drainer and consumers · ERP posting and reconciliation runs · sale processing and dead-letter · inventory backfill · audit fan-out and retention · email · soft-delete sweep |
| `docs` | Architecture · live control map · documentation index · brand · agent-os · presentation assets |
| `.specify` | Constitution v3.0.0 · architecture impact · redaction matrix · slice templates · integration manifests |
| `.github` | CI workflows · PR + issue templates |
| `scripts`, `tools`, `loadtests` | LOC badge automation · custom ESLint rules · k6 perf scenarios |

### What this repo owns
Backend and orchestration boundary: APIs and OpenAPI contracts · database schema, migrations and tenant/store context · tenant catalog and store overrides · inventory ledger · sales capture and sync operations · settlement and receivables · ERP posting orchestration and the integration contracts the connector consumes · worker runtime and queue patterns · shared platform primitives for auth, observability, validation, and errors.

### What this repo does **not** own
POS terminal code ([`Kemetra/POS`](https://github.com/Kemetra/POS)) · admin/operator frontend ([`Kemetra/Admin-Console`](https://github.com/Kemetra/Admin-Console)) · any ERPNext/Frappe call or DocType mapping ([`Kemetra/ERPNext-Connector`](https://github.com/Kemetra/ERPNext-Connector) is the only ERPNext adapter) · production infrastructure beyond the deploy assets in `deploy/` · legacy `Data-Pulse` code as source material (reference only, must be re-specified).

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
| Contracts | OpenAPI 3.1 of record · Zod runtime validation · `openapi-breaking` CI check |
| Testing | Jest · ts-jest · Supertest · Testcontainers PostgreSQL · k6 load scenarios · API fuzzing in CI |
| IDs | UUIDv7 with UUIDv4 fallback |

---

## Documentation

The [documentation index](docs/README.md) is the main hub, with audience-based navigation for product, engineering, security, and integration reviewers.

| Audience | First reads |
| --- | --- |
| **Product & brand** | [Brand identity](docs/brand/retail-tower-os.md) · [Icon system](docs/brand/icon-system.md) |
| **Engineering** | [Architecture](docs/ARCHITECTURE.md) · [Foundation quickstart](specs/001-foundation-auth-tenant-store/quickstart.md) · [Contributing](CONTRIBUTING.md) |
| **Security** | [Security policy](SECURITY.md) · [Constitution](.specify/memory/constitution.md) |
| **Integration** | [Contracts package](packages/contracts/README.md) · [Synchronization](docs/architecture/synchronization.md) · [Repo boundaries](docs/architecture/repo-boundaries.md) · [POS operator identity spec](specs/002-pos-operator-identity/spec.md) |
| **Operations** | [Observability signals](docs/observability/signals.md) · [Outbox lifecycle](docs/outbox/lifecycle.md) · [Idempotency strategy](docs/idempotency/strategy.md) · [Database roles](docs/operations/database-roles.md) · [Deploy](deploy/README.md) |

---

## Development agreement

This platform follows the active [Constitution](.specify/memory/constitution.md) and the Spec Kit workflow. The unit of work is a Jira issue (project RT); start from `origin/main`, keep changes to the issue's scope, preserve tenant isolation, and do not change dependency manifests, lockfiles, SQL migrations, OpenAPI contracts or CI workflows without explicit approval. See [standing rules](docs/agent-os/standing-rules.md).

---

## License

MIT. See [LICENSE](LICENSE).
