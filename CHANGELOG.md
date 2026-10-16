# Changelog

All notable changes to Data-Pulse-2 are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Phase 1 workspace setup: `pnpm-workspace.yaml`, `tsconfig.base.json`,
  `.eslintrc.cjs`, `.prettierrc`, `.nvmrc`, root `package.json`,
  `docker-compose.dev.yml`, Constitution-Check PR template.
- RT-113 BC1: OpenAPI contract `pos-cashier-admissions.openapi.yaml`
  (1.0.0-draft, contract-only). It defines the device-authenticated cashier
  admission, admission end and cashier roster routes that replace the cashier
  path's use of the operator-identity-gated roster and active-session routes.
- RT-414 `[GATED]`, owner-approved 2026-10-12 (decisions 1–5 on RT-414): OpenAPI contract
  `platform-support-sessions.openapi.yaml` (1.0.0-draft, contract-only). It
  defines the platform support session (RT-391 P0-a, D2): open with a
  mandatory purpose, read current, explicit renew and end, a 60-minute
  server-set expiry, the cross-cutting `support_session_required` /
  `support_session_expired` refusal on tenant-scoped routes (including
  `listMembers`, `updateTenant` and `switchActiveStore`), an `Origin` check
  (`origin_rejected`) on the surface's POSTs and on unsafe-method requests a
  support session admits, and the
  `platform.support_session.*` and `platform.cross_tenant.accessed` audit
  metadata allowlists. `context.openapi.yaml` 1.1.0-draft adds a
  platform-admin-only 403 on `switchActiveTenant` and a nullable
  `support_session` on `ContextResponse`. No runtime or migration change.
- RT-383 `[GATED]`, pending owner approval: OpenAPI contract
  `shift-closes.openapi.yaml` (1.0.0-draft, contract-only). It defines the
  admin-facing read of recorded RT-17 shift closes for Admin-Console RT-18:
  `GET /api/v1/shift-closes` (filtered, keyset-paginated list) and
  `GET /api/v1/shift-closes/{shiftId}` (one close with its movements). No
  runtime change; the POS shift operations are unchanged.
- RT-383: runtime for the admin shift-close reads (`ShiftClosesModule`). Both
  operations ship unchanged on the wire and lose `x-runtime-status:
  contract-only`. Dashboard session, roles owner / tenant_admin /
  store_manager, the operator store scope as a SQL predicate, one
  non-disclosing 404 body for every refusal, and a tenant-bound keyset cursor
  that keeps `closedAt` at microsecond precision. No migration; the POS shift
  operations are unchanged.
- RT-530 `[GATED]`, owner-approved 2026-10-15 (RT-530 comment 11988):
  manager-approved sale void. `POST /api/pos/v1/sales/{saleRef}/void` now
  needs a bound RT-114 manager approval (`approval`) and the void's
  `businessDate`; without a valid one it is refused. `pos-sales/sales.yaml`
  1.8.0-draft adds both fields as optional in shape (additive) and the 403
  `void_approval_required` / `void_self_approval` / `void_approver_not_eligible`
  and 422 `void_approval_invalid` / `void_outside_business_day` refusals. The
  approver must be an owner, tenant_admin or store_manager of the tenant with
  access to the sale's store, and neither the requester nor the selling
  operator; the requester must be the authenticated envelope operator (403
  `void_requester_mismatch`) and a user of the tenant with access to the store; the void must be on the sale's business day. A replay answers
  before these checks. Migration 0046 adds the approval evidence columns to
  `sale_voids` (all NULL for earlier voids); the `sale.voided` audit event
  carries the approver. The server re-validates every claim of the evidence but
  cannot prove that a PIN was typed on the terminal.
- RT-538 `[GATED]`, owner-authorized 2026-10-16 for implement and merge, not
  deploy (RT-538 comment 12079): storage for the store-wide sale history
  (RT-537 contract). Migration 0047 adds the nullable receipt snapshot columns
  on `sales` (`receipt_*`), `sale_lines.line_seq` and the append-only,
  tenant-RLS `sale_reprints` table; migration 0048 builds
  `idx_sales_tenant_store_business_date` (tenant, store, business date DESC,
  occurred at DESC, id DESC) with `CREATE INDEX CONCURRENTLY`, as a
  single-statement file so the runner does not wrap it in a transaction. No
  backfill, no runtime or contract change; the routes stay contract-only until
  RT-539.
- RT-539 (RT-534 S3; owner decisions OD-534-1..8): the store-wide POS sale
  history runtime on the RT-538 schema. `GET /api/pos/v1/sale-history`
  (business-date range, at most 31 days, keyset pages), `GET
  /api/pos/v1/sale-history/{saleRef}` (the full recorded detail) and `POST
  /api/pos/v1/sale-history/{saleRef}/reprints` (authorize / record), behind
  `SaleHistoryAuthGuard`: the manager/admin envelope sees every sale of its
  store; the device bearer plus `X-Cashier-Admission` sees only the admitted
  cashier's own sales, from every till of the store. Per-device rate limits
  (`posReadSaleHistory`, `posWriteSaleReprint`). `captureSale` accepts the
  optional `receipt` snapshot (kept out of `payload_hash`, first write wins)
  and stores each line's position as `line_seq`. Deploy step 2 gains
  `sale-reprints-domain-grants.sql`; the API refuses to boot without it. The
  contract's `x-runtime-status: contract-only` markers are unchanged ([GATED]).
- RT-542 `[GATED]`, owner-approved 2026-10-16 (RT-542 comment 12124): the three
  sale-history operations (`listSaleHistory`, `readSaleHistoryDetail`,
  `recordSaleReprint`) lose `x-runtime-status: contract-only` now that the RT-539
  runtime serves them. `sale-history.yaml` stays `1.0.0-draft`; no new field, no
  other operation, no runtime or migration change.

### Changed
- RT-113 BC1: `pos-operators.openapi.yaml` 1.1.1-draft is a prose-only fix.
  The roster and active-session descriptions now match the `security` block
  and the runtime (RT-182): an operator-identity JWT, an RT-150
  manager-eligible caller, a `branch_id` the runtime requires, and no device
  token read.
- RT-208 `[GATED]`: `pos-operators.openapi.yaml` 1.2.0-draft declares the
  roster `branch_id` query parameter `required: true`, matching the runtime's
  `branch_id_required` refusal (still the generic 401). Acknowledged oasdiff
  ERR `request-parameter-became-required`. No runtime change.

### Security
- RT-430 `[GATED]`, owner-approved 2026-10-12 (decisions recorded on RT-430):
  CSRF hardening. Every `POST`, `PUT`, `PATCH` or `DELETE` authenticated by
  the `dp2_session` cookie must carry an `Origin` that is the API's own
  origin (from `Host`; `https` wherever the cookie is `Secure`) or is listed
  in `ALLOWED_ORIGINS`; otherwise 403 `origin_rejected`, before the session
  lookup. A missing `Origin` is refused. Sign-in refuses a foreign `Origin`
  and admits a missing one. Bearer, POS device-token and operator-envelope
  requests are not checked. One implementation (`auth/origin-check.ts`)
  serves this and the RT-414 support-session rule. The cookie-auth contracts
  document the 403 (additive under oasdiff). Non-browser cookie clients must
  now send `Origin`; the Schemathesis harness does. No migration.

## [0.1.0] — Foundation backend — 2026-05-12

### Added

#### Workspace and package layer
- pnpm workspace with two deployable services (`apps/api`, `apps/worker`)
  and four internal packages (`packages/auth`, `packages/contracts`,
  `packages/db`, `packages/shared`).
- Shared primitives: Zod base schemas, error envelope, pino logger factory
  with `tenant_id`/`request_id` binding, OpenTelemetry SDK setup (HTTP,
  Postgres, Redis, BullMQ instrumentations), UUIDv7 generator with UUIDv4
  fallback, idempotency key store (Redis-primary, Postgres-mirror).

#### Database schema and migrations
- Drizzle schema for all foundation entities: `users`, `tenants`, `stores`,
  `memberships`, `store_access`, `roles`, `permissions`, `role_permissions`,
  `sessions`, `auth_tokens` (with reserved `device_id` POS seam column),
  `invitations`, `audit_events`, `idempotency_keys`.
- Explicit SQL migration `packages/db/drizzle/0000_initial.sql` with
  rollback: `citext` extension, tables in dependency order, FK and CHECK
  constraints, `updated_at` triggers, RLS enabled and policies applied.
- `withTenant` query proxy and DB-session middleware that issues
  `SET LOCAL app.current_tenant` and `SET LOCAL app.is_platform_admin`
  per transaction.
- Testcontainers-backed migration integration test verifying all tables,
  FKs, partial uniques, CHECK constraints, RLS policies, and triggers.

#### API — auth
- `AuthGuard` (cookie + bearer token paths), `AuthService` (sign-in,
  password verify, argon2id, account lockout), `AuthController` (sign-in,
  sign-out, refresh, password-reset request/confirm,
  email-verify request/confirm).
- `SessionRepository` (PostgreSQL source of truth, Redis read-through cache),
  `AuthTokenRepository` (opaque SHA-256 token hash, revocation, expiry).
- Rate-limit helper: per-account 5/15 min, per-IP 30/hour (Redis-backed).
- `@Roles()` decorator + `RolesGuard`; predefined v1 role catalog with
  forward-compatible permissions table.

#### API — tenants, stores, and memberships
- `TenantsController` + `TenantsService`: CRUD, slug uniqueness,
  cross-tenant isolation, platform-admin gating, soft-delete.
- `StoresController` + `StoresService`: CRUD within active tenant,
  store-code uniqueness, cross-store isolation.
- `InvitationsController` + `InvitationsService`: create, accept, revoke,
  expiry; invitation token visible once, only hash persisted.
- `MembershipsController` + `MembershipsService`: role and store-access
  updates, membership revocation with audit.

#### API — active context
- `TenantContextGuard` and `ContextController`/`ContextService`: active
  tenant switch, active store switch/clear; cross-tenant store attempts
  return 404 indistinguishable from not-found (FR-ISO-4).
- DB middleware wires `app.current_tenant` GUC into the NestJS request
  lifecycle for every authenticated request.

#### API — audit
- `AuditEmitter` interceptor enqueues a BullMQ job for each auditable
  action: auth sign-in (success/failure), role/access changes, context
  switch, soft-delete, platform-admin cross-tenant operations.
- `AuditController` + `AuditService`: filters by action prefix, actor,
  store, time range; cursor pagination; tenant-scoped; tenant-admin gated.
- PII/credential redaction enforced at the logger boundary; audit rows
  are insert-only at the application layer.

#### API — common infrastructure
- `RequestIdInterceptor` (UUID assignment + response header),
  `LoggingInterceptor` (pino per-request line, no secrets),
  global `ExceptionFilter` (uniform error envelope; 404 = 403 = cross-tenant
  per FR-ISO-4), Zod `ValidationPipe`.
- OpenAPI loader reads YAMLs from `packages/contracts/openapi/` at startup.

#### Worker foundations
- NestJS standalone worker bootstrap with BullMQ connection and graceful
  shutdown.
- BullMQ default options module with configurable retry/backoff/DLQ
  defaults across all queues.
- Email processor (verify + password-reset flows) with provider-agnostic
  adapter interface (no concrete provider chosen — PQ-1 stub).
- `audit-fanout` processor: consumes BullMQ, inserts `audit_events` row;
  retry/backoff; DLQ on terminal failure.
- `session-revoke` processor: admin-initiated session revocation propagates
  within ≤5 minutes (FR-AUTH-6); processor and registry layer complete.
- Soft-delete sweep processor layer (T312): processor slice scaffolded;
  runtime scheduling is not yet wired (Layer A only).
- OpenTelemetry trace context propagation from API → worker via BullMQ
  job payload (`trace_id`/`span_id` flows through `audit-fanout`,
  `session-revoke`, and email queues).

#### Contracts and conformance
- OpenAPI 3.1 YAML contracts of record under `packages/contracts/openapi/`
  for auth, tenants, stores, context, memberships, and audit domains.
- Contract-conformance test coverage for `GET /tenants`, `GET /stores`,
  and `PATCH /memberships` endpoints (additional slices in progress).

#### Coverage and quality
- Jest coverage threshold ≥ 80% configured at repo root and per-app.
- Unit coverage established across all core repositories, services,
  controllers, guards, interceptors, and worker processors.
- Codecov reporting integrated via CI.

#### Documentation
- `README.md` quickstart pointer links to
  `specs/001-foundation-auth-tenant-store/quickstart.md`.
- Foundation spec, plan, data model, contracts, and 140-task implementation
  plan under `specs/001-foundation-auth-tenant-store/`.

### Notes
- Dashboard UI and POS application are out of scope and not implemented.
- POS sync API endpoints are not implemented; `/api/pos/v1/*` namespace
  is reserved (returns the standard not-found envelope).
- T311 audit log retention policy is not yet implemented (pending
  retention schema and design decisions).
- T312 soft-delete sweep processor layer is complete; runtime scheduling
  is not yet wired.
- T309 SC-1..SC-9 verification and T308 Constitution post-implementation
  sign-off are not yet recorded.
- Product catalog, inventory, orders, payments, billing, reports,
  analytics, dbt, and ClickHouse are explicitly out of scope.

## [0.1.0-foundation] — Planning baseline

### Added
- Project Constitution v2.0.0 (`.specify/memory/constitution.md`).
- Foundation feature spec, plan, contracts (OpenAPI 3.1), data model,
  quickstart, and 140-task implementation plan under
  `specs/001-foundation-auth-tenant-store/`.

### Notes
- No application code shipped at this baseline.
- Dashboard UI, POS app, POS sync, product catalog, inventory, orders,
  payments, billing, reports, and analytics/dbt are explicitly out of
  scope of the foundation feature.
