# Data Pulse Architecture

Data Pulse (`Data-Pulse-2`) is the backend-first implementation of **Retail Tower OS** — the
command layer for multi-branch retail operations. This repository owns the API, worker runtime,
contracts, database schema, and shared platform primitives. Dashboard UI work is deferred to a
separate feature, and POS applications remain external repositories.

![Data Pulse architecture](assets/architecture-isometric.svg)

## Executive Summary

Data Pulse separates synchronous platform behavior from asynchronous processing.
`apps/api` handles authenticated HTTP requests, tenant/store context selection,
validation, logging, contract loading, and database access. `apps/worker`
handles background jobs through Redis and BullMQ. Internal packages hold the
shared contracts, database schema, auth primitives, and cross-cutting platform
utilities.

PostgreSQL is the durable source of truth. Redis is runtime coordination, never
domain truth. OpenAPI YAML in `packages/contracts/openapi` is the integration
contract of record.

## System Shape

> **Visual map** — presentation-grade platform topology.

![Retail Tower OS System Map](assets/architecture/retail-tower-os-system-map.svg)

For the full-screen interactive view, open the
[Retail Tower OS live architecture map](architecture/retail-tower-live-map.html).
It renders the same backend-first platform as a Three.js control surface backed
by [topology JSON](architecture/retail-tower-live-map.json).

> **Reviewable Mermaid source** — technical diagram kept for diffability and
> tooling compatibility.

```mermaid
flowchart TB
  subgraph clients["Clients and consumers"]
    dashboard["Dashboard UI<br/>future feature"]
    apiClients["API consumers"]
    pos["POS clients<br/>external repository"]
  end

  subgraph apps["Deployable apps"]
    api["apps/api<br/>NestJS HTTP API"]
    worker["apps/worker<br/>NestJS worker"]
  end

  subgraph packages["Workspace packages"]
    contracts["packages/contracts<br/>OpenAPI 3.1 YAML"]
    auth["packages/auth<br/>passwords, token hashes, auth types"]
    db["packages/db<br/>schema, migrations, tenant helpers"]
    shared["packages/shared<br/>zod, errors, logger, otel, queues"]
  end

  postgres[("PostgreSQL 16<br/>system of record")]
  redis[("Redis 7<br/>BullMQ coordination")]

  dashboard --> api
  apiClients --> api
  pos -. reserved authenticated contracts .-> api

  api --> contracts
  api --> auth
  api --> db
  api --> shared
  api --> postgres
  api --> redis

  api -- enqueue async jobs --> redis
  worker -- consume jobs --> redis
  worker --> shared
  worker -. future processors .-> postgres
```

## Runtime Responsibilities

| Runtime | Owns | Does not own |
| --- | --- | --- |
| `apps/api` | HTTP bootstrap, auth endpoints, active tenant/store context, validation, exception envelopes, request IDs, logging, OpenAPI contract loading, PostgreSQL access, queue production. | Background processing, dashboard UI, POS app code. |
| `apps/worker` | Standalone Nest application context, BullMQ worker factory, email queue consumption, provider-adapter seams, graceful shutdown. | HTTP routing, tenant context selection, frontend behavior. |
| PostgreSQL | Durable source of truth, constraints, migrations, tenant isolation policy support. | Cache semantics or queue delivery. |
| Redis | BullMQ transport and runtime coordination. | Durable domain truth. |

## Package Boundaries

```mermaid
flowchart LR
  api["apps/api"]
  worker["apps/worker"]
  auth["packages/auth"]
  contracts["packages/contracts"]
  db["packages/db"]
  shared["packages/shared"]

  api --> auth
  api --> contracts
  api --> db
  api --> shared
  worker --> shared

  auth -. no app imports .-> shared
  db -. no app imports .-> shared
```

Boundary rules:

- Apps may depend on packages.
- Packages must not import from `apps/*`.
- `apps/api` and `apps/worker` do not import from each other.
- OpenAPI YAML in `packages/contracts/openapi` is the contract source of truth.
- SQL migrations under `packages/db/drizzle` are versioned review artifacts.

## API Request Flow

> **Visual map** — request pipeline through the guard chain to service layer
> and response.

![Retail Tower OS Request Flow](assets/architecture/retail-tower-os-request-flow.svg)

> **Reviewable Mermaid source** — technical sequence diagram.

```mermaid
sequenceDiagram
  participant Client
  participant API as apps/api
  participant Auth as AuthModule
  participant Context as ContextModule
  participant DB as PostgreSQL
  participant Queue as Redis/BullMQ

  Client->>API: HTTP request
  API->>API: assign request id, log, helmet, cookies
  API->>API: validate body and normalize exception envelope
  API->>Auth: validate session or token
  Auth->>DB: session/token lookup
  API->>Context: resolve tenant/store context
  Context->>DB: membership and store access lookup
  API->>DB: tenant-scoped read/write
  API-->>Queue: enqueue async email job when needed
  API-->>Client: response with request id
```

## Worker Flow

```mermaid
sequenceDiagram
  participant API as apps/api
  participant Redis as Redis/BullMQ
  participant Worker as apps/worker
  participant Adapter as EmailAdapter

  API->>Redis: add email job
  Worker->>Redis: subscribe to email queue
  Redis-->>Worker: deliver job
  Worker->>Worker: validate payload and apply defaults
  Worker->>Adapter: send or no-op through provider seam
  Worker-->>Redis: complete or fail job
```

## Data Model Themes

- Tenant, store, membership, role, permission, session, token, invitation,
  audit, and idempotency tables live in `packages/db/src/schema`.
- `packages/db/drizzle/0000_initial.sql` is the initial migration artifact.
- Tenant-scoped access should move through helpers such as `withTenant` and
  request DB context middleware rather than ad hoc SQL filtering.
- Cross-tenant and cross-store tests are required for behavior that touches
  tenant-owned data.

## Catalog Source-of-Truth Layers

The catalog model follows a four-layer authority hierarchy. Each layer is owned
by a distinct actor and may override the layer above it for its scope.

```mermaid
flowchart TD
  gpi["Global Product Index<br/>platform authority<br/><i>canonical product definitions</i>"]
  tc["Tenant Catalog<br/>ownership group truth<br/><i>per-tenant product selection and pricing</i>"]
  so["Store Override<br/>branch truth<br/><i>per-store price and availability adjustments</i>"]
  sl["SaleLine Snapshot<br/>invoice truth<br/><i>immutable at transaction time</i>"]

  gpi -->|propagated to| tc
  tc -->|overridden at| so
  so -->|captured in| sl

  gpi -. "spec/003-catalog-foundation" .-> gpi
```

Layer ownership rules:

| Layer | Owner | Can override | Immutable after |
| --- | --- | --- | --- |
| Global Product Index | Platform admin | — | Product deactivation |
| Tenant Catalog | Tenant admin | GPI defaults | — |
| Store Override | Store manager | Tenant price/availability | — |
| SaleLine Snapshot | System (at sale time) | — | Commit |

Historical sale facts must not be silently rewritten by catalog changes.
A SaleLine Snapshot carries the price and product description as they were
at transaction time, not as they are today.

## Tenant Boundary and Data Ownership

> **Visual map** — tenant isolation zones, RLS boundary, and tenantId
> propagation through API and worker.

![Retail Tower OS Tenant Boundary](assets/architecture/retail-tower-os-tenant-boundary.svg)

> **Reviewable Mermaid source** — technical diagram.

Every piece of domain data is owned by exactly one tenant. Tenant context is
established at the API boundary and propagated through every subsequent
database access, worker job, and audit record.

```mermaid
flowchart LR
  subgraph tenantA["Tenant A"]
    storeA1["Store A-1"]
    storeA2["Store A-2"]
    membersA["Members / Roles"]
  end

  subgraph tenantB["Tenant B"]
    storeB1["Store B-1"]
    membersB["Members / Roles"]
  end

  api["apps/api<br/>resolves tenant context<br/>from session / token"]
  pg[("PostgreSQL<br/>RLS enforced")]
  worker["apps/worker<br/>carries tenantId<br/>in every job payload"]

  api --> pg
  api -->|tenantId in job| worker
  worker --> pg

  tenantA -. RLS row filter .-> pg
  tenantB -. RLS row filter .-> pg
```

Isolation rules:

- Runtime DB role must not bypass RLS.
- Cross-tenant access returns a safe 404 — never a permission error that leaks
  tenant existence.
- Workers establish tenant context before any DB access.
- Audit records carry `tenantId`, `storeId`, `actorId`, and `correlationId`.

## Deployment View

```mermaid
flowchart LR
  apiContainer["API service<br/>node dist/main.js"]
  workerContainer["Worker service<br/>node dist/main.js"]
  pg[("Managed PostgreSQL 16")]
  redis[("Managed Redis 7")]
  logs["Logs and traces<br/>pino + OpenTelemetry"]

  apiContainer --> pg
  apiContainer --> redis
  workerContainer --> redis
  workerContainer -. future jobs .-> pg
  apiContainer --> logs
  workerContainer --> logs
```

Required production configuration:

- `DATABASE_URL` for non-BYPASSRLS tenant/domain API database access.
- `AUTH_LOOKUP_DATABASE_URL` for narrowly privileged pre-tenant identity,
  session, token, device, and store-scope resolution. Production boot rejects a
  missing credential or a role shared with `DATABASE_URL`.
- `MIGRATION_DATABASE_URL` for the deployment-only migration owner credential.
- `REDIS_URL` for production API email job enqueueing and worker queue
  consumption.
- `LOG_LEVEL` when the default `info` level is not appropriate.

## Current Gaps By Design

- Dashboard/web UI is not scaffolded in this foundation slice.
- POS endpoints are reserved by contract strategy but POS app code is out of
  scope here.
- Real email provider wiring is behind the worker adapter seam.
- Additional retail domain modules are staged through active specifications and
  task lists.
