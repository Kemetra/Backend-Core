# Tasks: Foundation — Auth, Tenants, Stores, Roles

**Feature**: 001-foundation-auth-tenant-store
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Constitution**: v3.0.0
**Status**: Generated tasks (Phase 2 of speckit). **No code produced yet.**
**Created**: 2026-05-02

> Stack alignment: pnpm workspaces · NestJS API + worker · BullMQ · Drizzle ORM
> with explicit SQL migrations · PostgreSQL 16+ · Redis 7+ · Zod · OpenAPI 3.1
> · Jest + Supertest + Testcontainers · pino + OpenTelemetry · argon2id.
>
> **Out of scope of this task list** (do NOT generate tasks for any of these
> in this feature): dashboard / web frontend (`apps/web`, login UI, protected
> dashboard flows), POS application or POS sync endpoints, product catalog,
> inventory, orders, payments, billing, subscriptions, reports, analytics
> dashboards, dbt or analytics pipelines.

## User stories (derived from spec §5)

| ID | Priority | Story | Spec scenarios |
|---|---|---|---|
| **US1** | P1 | Authenticate as a user | 5.1 + cross-cutting 5.4/5.7 |
| **US2** | P2 | Manage tenants and stores (admin) | 5.2/5.3 prerequisites; cross-tenant isolation |
| **US3** | P2 | Active tenant/store context | 5.2, 5.3, 5.4, 5.5, 5.7 |
| **US4** | P3 | Invite users and manage memberships | 5.8 |
| **US5** | P3 | Backend authorization (roles + permissions) | 5.6, cross-cutting through all stories |
| **US6** | P3 | Audit events | FR-AUDIT-1/2/3 |
| **US7** | P4 | POS integration seams (model-only) | 5.9, FR-POS-SEAM-1/2/3, SC-8 |

> Each user story is independently testable: the success criteria for US-N
> can be verified against the running system once Phase 2 plus US-N's tasks
> are complete, regardless of whether higher-priority stories are also
> finished.

---

## Phase 1 — Setup

> Project bootstrap. No business logic. No NestJS modules yet.

- [ ] T001 Create root pnpm workspace manifest at `pnpm-workspace.yaml`
- [ ] T002 [P] Create root TypeScript base config at `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`)
- [ ] T003 [P] Create root ESLint config at `.eslintrc.cjs` (typescript-eslint, disallow `any`, custom rule slot)
- [ ] T004 [P] Create root Prettier config at `.prettierrc`
- [ ] T005 [P] Pin Node version at `.nvmrc` (Node 20 LTS)
- [ ] T006 [P] Create root `package.json` with scripts (`build`, `test`, `lint`, `migrate`, `dev`) and pnpm engines field
- [ ] T007 [P] Create developer-only Postgres + Redis stack at `docker-compose.dev.yml` (Postgres 16, Redis 7, healthchecks)
- [ ] T008 [P] Append node_modules/dist/.turbo/.cache patterns to `.gitignore`
- [ ] T009 [P] Create `CHANGELOG.md` skeleton (Keep-a-Changelog format) at repo root
- [ ] T010 [P] Add Constitution-Check PR description template at `.github/pull_request_template.md`

## Phase 2 — Foundational (blocks all user stories)

> Workspace packages, DB schema, base middleware. Every user story depends
> on this phase completing.

### Workspace package skeletons

- [ ] T020 Scaffold `packages/shared` (`package.json`, `tsconfig.json`, `src/index.ts`)
- [ ] T021 [P] Scaffold `packages/db` (`package.json`, `tsconfig.json`, `drizzle/` folder, `src/index.ts`)
- [ ] T022 [P] Scaffold `packages/auth` (`package.json`, `tsconfig.json`, `src/index.ts`)
- [ ] T023 [P] Scaffold `packages/contracts` (`package.json`, `tsconfig.json`); copy OpenAPI YAMLs from `specs/001-foundation-auth-tenant-store/contracts/*.yaml` into `packages/contracts/openapi/` and load them at runtime (no codegen yet)
- [ ] T024 Scaffold `apps/api` NestJS app (`package.json`, `nest-cli.json`, `tsconfig.json`, empty `src/main.ts`, empty `src/app.module.ts`)
- [ ] T025 [P] Scaffold `apps/worker` NestJS standalone (`package.json`, `tsconfig.json`, empty `src/main.ts`, empty `src/worker.module.ts`)

### `packages/shared` foundations

- [ ] T030 [P] Test Zod base schemas (UUID, Email, Slug) in `packages/shared/__tests__/zod/base.spec.ts`
- [ ] T031 Implement Zod base schemas in `packages/shared/src/zod/base.ts`
- [ ] T032 [P] Test error-envelope shape (uniform `{ error: { code, message, request_id } }`) in `packages/shared/__tests__/errors/envelope.spec.ts`
- [ ] T033 Implement error envelope types + helpers in `packages/shared/src/errors/envelope.ts`
- [ ] T034 [P] Implement pino logger factory (with `tenant_id`, `request_id`, redact list) in `packages/shared/src/logger/pino.ts`
- [ ] T035 [P] Implement OpenTelemetry SDK setup (HTTP, Postgres, Redis, BullMQ instrumentations) in `packages/shared/src/observability/otel.ts`

### `packages/auth` primitives (TDD)

- [ ] T040 Test argon2id password hashing helper (hash/verify, OWASP 2025 params, timing-safe verify) in `packages/auth/__tests__/passwords.spec.ts`
- [ ] T041 Implement argon2id helper using `argon2` npm in `packages/auth/src/passwords.ts`
- [ ] T042 [P] Test SHA-256 token-hash helper (constant-time compare) in `packages/auth/__tests__/tokens.spec.ts`
- [ ] T043 [P] Implement token-hash helper in `packages/auth/src/tokens.ts`
- [ ] T044 [P] Define session/token shape types in `packages/auth/src/types.ts`
- [ ] T045 [P] UUIDv7 generator behind adapter (with UUIDv4 fallback path tested) at `packages/shared/src/ids/uuid.ts` with test at `packages/shared/__tests__/ids/uuid.spec.ts`

### `packages/db` schema and migration (Drizzle + explicit SQL)

- [ ] T050 [P] Drizzle schema for `users` in `packages/db/src/schema/users.ts`
- [ ] T051 [P] Drizzle schema for `tenants` in `packages/db/src/schema/tenants.ts`
- [ ] T052 [P] Drizzle schema for `stores` in `packages/db/src/schema/stores.ts`
- [ ] T053 [P] Drizzle schema for `memberships` in `packages/db/src/schema/memberships.ts`
- [ ] T054 [P] Drizzle schema for `store_access` in `packages/db/src/schema/store_access.ts`
- [ ] T055 [P] Drizzle schema for `roles` (incl. `(tenant_id, id)` unique for composite FK) in `packages/db/src/schema/roles.ts`
- [ ] T056 [P] Drizzle schema for `permissions`, `role_permissions` (forward-compat empty) in `packages/db/src/schema/permissions.ts`
- [ ] T057 [P] Drizzle schema for `sessions` in `packages/db/src/schema/sessions.ts`
- [ ] T058 [P] Drizzle schema for `auth_tokens` (with reserved `device_id` column) in `packages/db/src/schema/auth_tokens.ts`
- [ ] T059 [P] Drizzle schema for `invitations` in `packages/db/src/schema/invitations.ts`
- [ ] T060 [P] Drizzle schema for `audit_events` in `packages/db/src/schema/audit_events.ts`
- [ ] T061 [P] Drizzle schema for `idempotency_keys` in `packages/db/src/schema/idempotency_keys.ts`
- [ ] T062 [P] Schema barrel export at `packages/db/src/schema/index.ts`
- [ ] T063 Test that the migration applies cleanly on an empty Postgres (Testcontainers) and produces all tables, FKs, partial uniques, CHECK constraints, RLS policies, and `updated_at` triggers per `data-model.md` in `packages/db/__tests__/migration.spec.ts`
- [ ] T064 Author explicit SQL migration `packages/db/drizzle/0000_initial.sql` (creates `citext` extension; tables in order; constraints; RLS enable; policies; triggers) and rollback at `packages/db/drizzle/0000_initial.down.sql`
- [ ] T065 [P] Migration runner CLI (`pnpm migrate:up` / `:down`) in `packages/db/src/cli/migrate.ts` with test at `packages/db/__tests__/cli/migrate.spec.ts`

### Tenant-scoping helpers and DB context middleware (Drizzle)

- [ ] T070 Test `withTenant(tx, tenantId)` query proxy injects `WHERE tenant_id = :tenantId` and refuses unscoped queries (Testcontainers) in `packages/db/__tests__/helpers/with-tenant.spec.ts`
- [ ] T071 Implement `withTenant` helper in `packages/db/src/helpers/with-tenant.ts`
- [ ] T072 [P] Test DB session middleware that issues `SET LOCAL app.current_tenant` and `SET LOCAL app.is_platform_admin` per transaction in `packages/db/__tests__/middleware/tenant-context.spec.ts`
- [ ] T073 Implement DB session middleware in `packages/db/src/middleware/tenant-context.ts`

### API skeleton (no domain endpoints yet)

- [ ] T080 NestJS bootstrap (`apps/api/src/main.ts`) with cookie parser, helmet, structured logging, and global Zod ValidationPipe
- [ ] T081 [P] Empty `AppModule` skeleton at `apps/api/src/app.module.ts` (modules wired in later phases)
- [ ] T082 [P] Test `RequestIdInterceptor` (assigns UUID, exposes via header) in `apps/api/test/common/request-id.interceptor.spec.ts`
- [ ] T083 [P] Implement `RequestIdInterceptor` in `apps/api/src/common/request-id.interceptor.ts`
- [ ] T084 [P] Test `LoggingInterceptor` (pino line per request, no secrets) in `apps/api/test/common/logging.interceptor.spec.ts`
- [ ] T085 [P] Implement `LoggingInterceptor` in `apps/api/src/common/logging.interceptor.ts`
- [ ] T086 [P] Test global `ExceptionFilter` (uniform error envelope, 404=403=cross-tenant per FR-ISO-4) in `apps/api/test/common/exception.filter.spec.ts`
- [ ] T087 [P] Implement global `ExceptionFilter` in `apps/api/src/common/exception.filter.ts`
- [ ] T088 [P] OpenAPI loader that reads YAMLs from `packages/contracts/openapi/` at startup in `apps/api/src/openapi/loader.ts`
- [ ] T089 [P] Zod ValidationPipe (Zod schema → request validation, 400 with envelope) in `apps/api/src/common/zod-validation.pipe.ts` with test at `apps/api/test/common/zod-validation.pipe.spec.ts`

### Worker skeleton (no jobs yet)

- [ ] T090 NestJS standalone bootstrap (BullMQ connection, graceful shutdown) in `apps/worker/src/main.ts`
- [ ] T091 [P] Worker module skeleton in `apps/worker/src/worker.module.ts`
- [ ] T092 [P] BullMQ default options module (retry/backoff/DLQ defaults) in `apps/worker/src/queues/queue.config.ts` with test at `apps/worker/test/queues/queue.config.spec.ts`

---

## Phase 3 — User Story 1 (P1): Authenticate as a user

**Story goal**: a user with valid credentials can sign in, refresh, sign out, and complete password-reset / email-verification flows; failed attempts are rate-limited; sessions can be revoked server-side.

**Independent test criteria**: against a running API with the foundational phase complete, the verifier completes spec quickstart §1 (sign-in + active context auto-set) and the auth-related parts of §9 (session survives Redis flush; revocation propagates within ≤5 minutes). No tenant/store admin work required for this story.

- [ ] T100 [US1] Test `AuthGuard` (cookie + bearer paths; 401 on missing/invalid) in `apps/api/test/auth/auth.guard.spec.ts`
- [ ] T101 [US1] Implement `AuthGuard` in `apps/api/src/auth/auth.guard.ts`
- [ ] T102 [US1] [P] Test `SessionRepository` (Postgres SoT, Redis read-through cache) using Testcontainers in `apps/api/test/auth/session.repository.spec.ts`
- [ ] T103 [US1] Implement `SessionRepository` in `apps/api/src/auth/session.repository.ts`
- [ ] T104 [US1] [P] Test `AuthTokenRepository` (opaque token hash lookup; revocation; expiry) in `apps/api/test/auth/auth-token.repository.spec.ts`
- [ ] T105 [US1] Implement `AuthTokenRepository` in `apps/api/src/auth/auth-token.repository.ts`
- [ ] T106 [US1] [P] Test rate-limit helper (per-account 5/15min, per-IP 30/hour) backed by Redis in `apps/api/test/auth/rate-limit.spec.ts`
- [ ] T107 [US1] Implement rate-limit helper in `apps/api/src/auth/rate-limit.ts`
- [ ] T108 [US1] Test `AuthService` (sign-in success/failure, password verify, account lockout, session creation) in `apps/api/test/auth/auth.service.spec.ts`
- [ ] T109 [US1] Implement `AuthService` in `apps/api/src/auth/auth.service.ts`
- [ ] T110 [US1] Integration test `AuthController` covering `POST /auth/signin`, `signout`, `refresh`, `password-reset/request|confirm`, `email/verify/request|confirm` (Supertest + Testcontainers) in `apps/api/test/auth/auth.controller.spec.ts`. Include: rejects 401 same shape as not-found per FR-ISO-4; 202 for password-reset request regardless of email existence; revocation invalidates within ≤5 min.
- [ ] T111 [US1] Implement `AuthController` in `apps/api/src/auth/auth.controller.ts`, conforming to `contracts/auth.openapi.yaml`
- [ ] T112 [US1] [P] Test `EmailQueueProducer` (enqueue verify/reset jobs with idempotent payload) in `apps/api/test/auth/email-queue.producer.spec.ts`
- [ ] T113 [US1] Implement `EmailQueueProducer` in `apps/api/src/auth/email-queue.producer.ts`
- [ ] T114 [US1] [P] Test email worker processor (verify + password-reset emails; provider-agnostic adapter) using ioredis-mock in `apps/worker/test/email/email.processor.spec.ts`
- [ ] T115 [US1] Implement email processor + provider-agnostic email adapter interface in `apps/worker/src/email/email.processor.ts` and `apps/worker/src/email/email.adapter.ts` (no concrete provider chosen — PQ-1 stub)

**US1 done when**: all auth endpoints in `contracts/auth.openapi.yaml` validate against runtime responses; 401 + rate-limit + revocation tests pass; coverage for `apps/api/src/auth/**` ≥ 80%.

---

## Phase 4 — User Story 2 (P2): Manage tenants and stores

**Story goal**: a platform admin can create/soft-delete tenants; a tenant admin can read/update their tenant and CRUD stores within it. Cross-tenant isolation is enforced at every endpoint.

**Independent test criteria**: with US1 complete, the verifier completes spec quickstart §2 (cross-tenant isolation: Carol cannot see Alice's stores) and §7 (soft-delete + retention).

- [ ] T130 [US2] Test `TenantsController` CRUD + cross-tenant isolation + platform-admin gating + soft-delete in `apps/api/test/tenants/tenants.controller.spec.ts`
- [ ] T131 [US2] Implement `TenantsController` + `TenantsService` in `apps/api/src/tenants/`
- [ ] T132 [US2] [P] Test slug uniqueness invariant (case-insensitive partial unique) in `apps/api/test/tenants/slug.invariant.spec.ts`
- [ ] T133 [US2] [P] Test `StoresController` CRUD within active tenant + cross-store isolation in `apps/api/test/stores/stores.controller.spec.ts`
- [ ] T134 [US2] Implement `StoresController` + `StoresService` in `apps/api/src/stores/`
- [ ] T135 [US2] [P] Test store-code uniqueness within tenant in `apps/api/test/stores/code.invariant.spec.ts`
- [ ] T136 [US2] [P] Test soft-delete retention behavior (read returns 404 to non-platform-admin; data still present) in `apps/api/test/tenants/soft-delete.spec.ts`
- [ ] T137 [US2] [P] Test that `FR-STORE-4` (no cross-tenant store reassignment) is enforced — patch attempts fail in `apps/api/test/stores/no-reassign.spec.ts`

**US2 done when**: contracts `tenants.openapi.yaml` + `stores.openapi.yaml` validate; cross-tenant isolation tests pass at API and DB layers; soft-delete window honored.

---

## Phase 5 — User Story 3 (P2): Active tenant/store context

**Story goal**: an authenticated user can switch active tenant (among their memberships) and active store (within the active tenant + their access policy); subsequent requests resolve only within that context.

**Independent test criteria**: with US1 + US2 complete, verifier completes spec quickstart §1 steps 3–4 and §3.

- [ ] T150 [US3] Test `TenantContextGuard` (resolves active tenant from session/token; rejects mismatched tenant; AsyncLocalStorage propagation) in `apps/api/test/context/tenant-context.guard.spec.ts`
- [ ] T151 [US3] Implement `TenantContextGuard` in `apps/api/src/context/tenant-context.guard.ts`
- [ ] T152 [US3] [P] Test `ContextController` switch-tenant / switch-store / clear-store, including cross-tenant store rejection (404, indistinguishable from not-found per FR-ISO-4) in `apps/api/test/context/context.controller.spec.ts`
- [ ] T153 [US3] Implement `ContextController` + `ContextService` in `apps/api/src/context/`
- [ ] T154 [US3] [P] Test that DB middleware sets `app.current_tenant` GUC for every authenticated request (Testcontainers) in `apps/api/test/db/db-context.middleware.spec.ts`
- [ ] T155 [US3] Wire DB middleware into NestJS request lifecycle in `apps/api/src/db/db-context.middleware.ts`
- [ ] T156 [US3] [P] Test FR-CTX-4 (store-scoped request without active store → 401) and FR-CTX-6 (tenant-scoped without store-scoped) in `apps/api/test/context/fr-ctx.spec.ts`
- [ ] T157 [US3] [P] Test that active store auto-clears on tenant switch in `apps/api/test/context/auto-clear.spec.ts`

**US3 done when**: `context.openapi.yaml` validates; switching is server-resolved + audited; mismatched tenant/store rejections do not leak existence.

---

## Phase 6 — User Story 4 (P3): Invitations and memberships

**Story goal**: a tenant admin can invite a user with a role and store-access policy; the invitee accepts via a single-use token and gains a membership. Existing memberships can have their role / store-access changed; memberships can be revoked (soft-deleted with audit).

**Independent test criteria**: spec quickstart §5 completes end-to-end. SC-6 (invite-to-signin under 5 minutes) verifies via the integration test stopwatch.

- [ ] T170 [US4] Test `InvitationsController` create + accept + revoke + expiry in `apps/api/test/memberships/invitations.controller.spec.ts`
- [ ] T171 [US4] Implement `InvitationsController` + `InvitationsService` in `apps/api/src/memberships/invitations.*`
- [ ] T172 [US4] [P] Test invitation token issuance + hashing (token visible once; only hash persisted) in `apps/api/test/memberships/invitations.token.spec.ts`
- [ ] T173 [US4] [P] Test `MembershipsController` update (role change, store-access change) + revoke in `apps/api/test/memberships/memberships.controller.spec.ts`
- [ ] T174 [US4] Implement `MembershipsController` + `MembershipsService` in `apps/api/src/memberships/`
- [ ] T175 [US4] [P] Test invariant I-3 (StoreAccess.tenant matches Membership.tenant) at DB layer via composite FK rejection in `packages/db/__tests__/store-access.invariant.spec.ts`
- [ ] T176 [US4] [P] Test `FR-ACCESS-3` (new store automatically accessible to "all stores" users; not to "specific" users) in `apps/api/test/memberships/access-on-new-store.spec.ts`
- [x] T177 [US4] [P] Test `FR-ACCESS-4` (revoking access invalidates cached authz within bound) in `apps/api/test/memberships/revoke-cache.spec.ts`
- [ ] T178 [US4] [P] Test that accepting an invitation never grants access to other tenants (FR-TEN-2 / scenario 5.8) in `apps/api/test/memberships/invite-tenant-scoped.spec.ts`
- [ ] T179 [US4] Test invite-email enqueued via `EmailQueueProducer` on invitation creation (no real email sent in test) in `apps/api/test/memberships/invitations.email-enqueue.spec.ts`

**US4 done when**: `memberships.openapi.yaml` validates; quickstart §5 passes; token never persisted plain; tenant-scoped invariant holds.

---

## Phase 7 — User Story 5 (P3): Backend authorization

**Story goal**: every protected endpoint enforces role + permission server-side; frontend state cannot bypass authorization.

**Independent test criteria**: spec quickstart §4 (frontend-bypass probe) and the cross-tenant + cross-store sweeps from §2 and §3 all pass without any UI involved.

- [ ] T200 [US5] Test `@Roles()` decorator + `RolesGuard` (allow/deny matrix per role) in `apps/api/test/auth/roles.guard.spec.ts`
- [ ] T201 [US5] Implement `@Roles()` decorator + `RolesGuard` in `apps/api/src/auth/roles.decorator.ts` and `apps/api/src/auth/roles.guard.ts`
- [ ] T202 [US5] Implement role catalog seeding + role-to-permission map (predefined v1 per Q2 default C; permissions table forward-compat) in `apps/api/src/auth/roles.catalog.ts` with test at `apps/api/test/auth/roles.catalog.spec.ts`
- [ ] T203 [US5] [P] Cross-tenant authorization sweep test (every protected endpoint × cross-tenant attempt → 404 same shape) in `apps/api/test/authz/cross-tenant.sweep.spec.ts`
- [ ] T204 [US5] [P] Cross-store authorization sweep test in `apps/api/test/authz/cross-store.sweep.spec.ts`
- [ ] T205 [US5] [P] Frontend-bypass probe test (Store-Staff user crafts tenant-admin request → 403) in `apps/api/test/authz/frontend-bypass.spec.ts`
- [ ] T206 [US5] [P] Default-deny test: an endpoint with no `@Roles()` and no `@Public()` annotation must fail closed in `apps/api/test/authz/default-deny.spec.ts`
- [ ] T207 [US5] [P] RLS bypass probe: a raw SQL `SELECT * FROM stores WHERE id = '<other tenant store>'` on a connection with `app.current_tenant` set to the wrong tenant returns 0 rows in `packages/db/__tests__/rls.bypass.spec.ts`
- [x] T208 [US5] [P] Lint rule (custom ESLint rule or test-time grep) that forbids un-tenant-scoped Drizzle queries in `apps/api/src/**/*.ts` (excluding repositories that explicitly opt out) — rule at `tools/eslint-rules/no-unscoped-tenant-query.js`, smoke test at `tools/eslint-rules/__tests__/no-unscoped-tenant-query.spec.js`. CI runs it via `pnpm lint:eslint` on the fast job.

**US5 done when**: SC-1 + SC-2 + SC-4 + SC-9 measurable; sweep tests cover every endpoint.

---

## Phase 8 — User Story 6 (P3): Audit events

**Story goal**: every governance/security action emits an immutable audit record retrievable per-tenant; PII and credentials never appear in audit metadata.

**Independent test criteria**: spec quickstart §6 (audit completeness) passes.

- [ ] T230 [US6] Test `AuditEmitter` interceptor enqueues a job for each auditable action (auth.signin.{ok|failed}, role/access changes, context switch, soft-delete, platform-admin cross-tenant) in `apps/api/test/audit/audit-emitter.interceptor.spec.ts`
- [ ] T231 [US6] Implement `AuditEmitter` interceptor in `apps/api/src/audit/audit-emitter.interceptor.ts`
- [ ] T232 [US6] [P] Test `audit-fanout` worker job (consumes BullMQ → inserts `audit_events` row; retry/backoff; DLQ on terminal failure) in `apps/worker/test/audit/audit-fanout.processor.spec.ts`
- [ ] T233 [US6] Implement `audit-fanout` worker in `apps/worker/src/audit/audit-fanout.processor.ts`
- [ ] T234 [US6] [P] Test `AuditController` query API (filters by action prefix, actor, store, time range; cursor pagination; tenant-scoped; tenant-admin gated) in `apps/api/test/audit/audit.controller.spec.ts`
- [ ] T235 [US6] Implement `AuditController` + `AuditService` in `apps/api/src/audit/`
- [ ] T236 [US6] [P] Test PII / credential redaction (hash, token, password, email body never appear in audit `metadata`) in `apps/api/test/audit/redaction.spec.ts`
- [ ] T237 [US6] [P] Test that audit rows are insert-only at the application layer (UPDATE attempts fail) in `apps/api/test/audit/insert-only.spec.ts`
- [ ] T238 [US6] [P] Test that authentication failures (no resolved user) record `actor_user_id IS NULL` with `actor_label` = the email used (no password) in `apps/api/test/audit/anonymous-actor.spec.ts`

**US6 done when**: SC-7 measurable; `audit.openapi.yaml` validates; redaction enforced.

---

## Phase 9 — User Story 7 (P4): POS integration seams (model-only)

**Story goal**: the foundation provides reusable seams (data model, auth subsystem, idempotency platform, reserved namespace) so a future POS sync feature attaches without redesign. **No POS endpoints are implemented.**

**Independent test criteria**: spec quickstart §8 (POS-seam thought experiment in code) passes; SC-8 walkthrough document exists.

- [ ] T260 [US7] [P] Test `IdempotencyKeyStore` Redis-primary + Postgres-mirror (round-trip; expired entries; collision behavior; cross-tenant isolation) in `packages/shared/__tests__/idempotency/store.spec.ts`
- [ ] T261 [US7] Implement `IdempotencyKeyStore` in `packages/shared/src/idempotency/store.ts` (no real endpoint consumes it yet — helper only)
- [ ] T262 [US7] [P] Test that `auth_tokens.device_id` column exists, is nullable, and that a row with `scope='pos'` + `device_id` set + `user_id` null is accepted by the schema (CHECK passes) in `packages/db/__tests__/auth-tokens.seam.spec.ts`
- [ ] T263 [US7] [P] Test that `/api/pos/v1/*` returns the same not-found envelope as any other unknown route (namespace reserved but empty) in `apps/api/test/pos-namespace/reserved-404.spec.ts`
- [ ] T264 [US7] [P] **POS-seam walkthrough** test (codifies SC-8): construct an in-memory hypothetical POS order submission, assert it can attach to `(tenant_id, store_id, device_id)`, runs through `TenantContextGuard`, uses `IdempotencyKeyStore`, and would enqueue follow-on work — all using existing primitives, with **zero schema changes** asserted by snapshot of the schema barrel — in `apps/api/test/pos-seam/walkthrough.spec.ts`
- [ ] T265 [US7] [P] Author SC-8 walkthrough document at `specs/001-foundation-auth-tenant-store/pos-seam-walkthrough.md` (text walkthrough that mirrors the test for human review)

**US7 done when**: walkthrough test passes; document exists; no POS endpoint contracts created.

---

## Phase 10 — Polish & Cross-Cutting Concerns

> Whole-system quality gates and platform polish.

- [ ] T300 [P] Test contract conformance: load each YAML in `specs/001-foundation-auth-tenant-store/contracts/*.yaml` and validate that every API runtime response matches the schema (OpenAPI request/response validator) in `apps/api/test/contract-conformance.spec.ts`
- [ ] T301 [P] Wire BullMQ retry/backoff/DLQ defaults across all queues (email, audit-fanout, session-revoke) and add a per-queue DLQ metric in `apps/worker/src/queues/queue.config.ts`
- [ ] T302 [P] Implement `session-revoke` queue + worker (admin-initiated revocation propagates within ≤5 min — FR-AUTH-6) in `apps/worker/src/auth/session-revoke.processor.ts` with test at `apps/worker/test/auth/session-revoke.processor.spec.ts`
- [ ] T303 [P] Test OTel context propagation from API → worker (trace_id flows through BullMQ payload) in `apps/worker/test/observability/otel-propagation.spec.ts`
- [ ] T304 [P] Configure Jest coverage threshold ≥ 80% in `jest.config.ts` at repo root and per-app
- [ ] T305 [P] CI workflow: lint + test + build + migration dry-run on Postgres (Testcontainers in CI) at `.github/workflows/ci.yml`
- [ ] T306 [P] Author repo `README.md` quickstart pointer linking to `specs/001-foundation-auth-tenant-store/quickstart.md`
- [ ] T307 [P] Update `CHANGELOG.md` with v0.1.0 "foundation" entry
- [ ] T308 [P] Constitution v3.0.0 sign-off: append a "Post-implementation Constitution Check" subsection to `plan.md` confirming all 14 principles still hold against the built code
- [ ] T309 [P] Verify Success Criteria SC-1..SC-9 against the running system; record results in `specs/001-foundation-auth-tenant-store/sc-verification.md`
- [ ] T310 [P] Performance check for SC-5 (context resolution p95 ≤ 200ms) — measurement script + report in `apps/api/test/performance/context-resolution.spec.ts`
- [ ] T311 [P] Audit log retention policy: BullMQ scheduled job to mark records past retention; tested in `apps/worker/test/audit/retention.spec.ts`
- [ ] T312 [P] Soft-delete retention worker (30 days for tenants/stores per PQ-6) at `apps/worker/src/cleanup/soft-delete-sweep.processor.ts` with test at `apps/worker/test/cleanup/soft-delete-sweep.spec.ts`
- [ ] T313 [US3] [P] Test that sign-in for a user with memberships in multiple tenants does NOT auto-set active_tenant_id on the session (spec §5.1 multi-tenant path); and that a subsequent tenant-scoped call returns 401 until context-switch is called. Files: apps/api/test/auth/auth.service.spec.ts and apps/api/test/auth/auth.controller.spec.ts

---

## Dependency graph (story completion order)

```
Phase 1 (Setup)
   ↓
Phase 2 (Foundational)
   ↓
   ├─→ US1 (P1) ──┐
   │              ├─→ US3 (P2)  ──┐
   ├─→ US2 (P2) ──┘              ├─→ US4 (P3)
   │                              ├─→ US5 (P3)
   │                              ├─→ US6 (P3)
   │                              └─→ US7 (P4)
   │                                       ↓
   └─────────────────────────→ Phase 10 (Polish)
```

- **MVP scope**: Phase 1 + Phase 2 + **US1** alone produces a system where a user can authenticate; useful for early integration with downstream work. Constitution still passes for that subset.
- **Foundation-complete scope**: Phase 1 + Phase 2 + US1 + US2 + US3 covers spec scenarios 5.1–5.7. Sufficient to start any other backend feature (catalog, inventory, etc., all of which are out of scope here).
- **Spec-complete scope**: Add US4 + US5 + US6 + US7 + Phase 10. Sign-off conditions in spec §15 fully met.

---

## Parallel execution opportunities

Tasks marked `[P]` within the same phase have no shared file or strict ordering dependency and can be executed in parallel. Notable parallel windows:

- Phase 2 schema files (T050–T062) are 13-way parallel.
- Phase 3 (US1) repositories (T102–T107) are 6-way parallel after T101.
- Phase 7 (US5) sweep tests (T203–T207) are 5-way parallel after T201.
- Phase 10 polish tasks (T300–T312) are mostly fully parallel.

---

## Out-of-scope guard (verification)

The following categories are **explicitly absent** from this task list. If any future task introduces them under this feature, it MUST first amend the spec/plan and pass a fresh Constitution Check.

| Category | Status | Where it actually belongs |
|---|---|---|
| Dashboard / web frontend (UI, login page, protected dashboard flows) | ❌ NOT in this task list | Separate dashboard feature |
| POS application (UI, offline behavior, local sync client) | ❌ NOT in this task list | Separate POS repository |
| POS sync API endpoints (`/api/pos/v1/*` real routes) | ❌ NOT in this task list (only the empty namespace + idempotency platform are here) | Future POS-sync feature |
| Product catalog | ❌ NOT in this task list | Future feature |
| Inventory | ❌ NOT in this task list | Future feature |
| Orders / sales records | ❌ NOT in this task list | Future feature |
| Payments | ❌ NOT in this task list | Future feature |
| Billing / subscriptions / metering | ❌ NOT in this task list | Future feature |
| Reports / analytics dashboards | ❌ NOT in this task list | Future feature |
| dbt models / analytics pipelines | ❌ NOT in this task list | Constitution analytics section; future feature |
| Webhook delivery to external services | ❌ NOT in this task list (only the worker stack to host it later) | Future feature |
| Multi-region / data residency | ❌ NOT in this task list | Explicit non-goal of v1 (PQ-3) |

A reviewer should be able to scan all 100+ tasks and confirm none of them
generates UI, POS sync, billing, analytics, or reports artifacts.

---

## Format check

All tasks above conform to the required format
`- [ ] T### [P?] [USX?] Description with file path`. Phase 1, Phase 2,
and Phase 10 tasks intentionally have no `[USX]` label (per the skill rules);
Phase 3–9 tasks all carry their user-story label.

**End of tasks.**
