# RT-815 Shared Postgres for api tests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-spec-file Postgres container with one container per Jest run plus one database cloned from a migrated template per spec file.

**Architecture:** Jest `globalSetup` starts the container, builds `rt_template` and exports connection info through `process.env`. Workers inherit it. `startPgEnv()` clones a database from the template, and `stopPgEnv()` drops it. Specs that touch cluster state stay on a private container. `globalTeardown` fails the run if roles changed.

**Tech Stack:** Jest 29.7 + ts-jest, `@testcontainers/postgresql` 11.14, `pg`, Postgres 16.

**Spec:** `docs/superpowers/specs/2026-10-22-api-test-shared-postgres-design.md`

## Global Constraints

- No change to `.github/**`, coverage thresholds, assertions, migrations, product code, or the `packages/db` helper.
- Exported names and signatures of `apps/api/test/_helpers/postgres-container.ts` are unchanged: `startPgEnv`, `stopPgEnv`, `applyAllUpAndCreateAppRole`, `applyUpAndCreateAppRole`, `PgTestEnv`, `APP_ROLE_NAME`, `APP_ROLE_PASSWORD`, `UP_SQL_PATH`, `guardPool`, `endPoolQuietly`, `isShutdownError`, `ignoreShutdownErrors`.
- If Docker is unreachable in globalSetup, warn and leave the env unset. The per-file fallback then fails or skips exactly as today.
- Changelog via `changelog.d/RT-815-<slug>.md` only.

## Review Focus

1. **A single spec run** (`jest one.spec.ts`, which Jest runs in-band in the parent process) must still get the shared server. Covered by Task 1, which runs the new spec alone.
2. **A spec that ends its pools late** must not crash the drop with 57P01 "Unhandled error". `stopPgEnv` waits for this database's backends before `DROP … WITH (FORCE)`. Covered by Task 1 test `stop drops the database`.
3. **Two workers cloning at the same instant** must not fail with 55006. The clone retries 55006 up to 5× at 100 ms. Covered by Task 1 test `parallel clones`.
4. **A row-lock waiter barrier** must still release under the new filter. Task 3 runs the shift and admission specs.
5. **The worker package** imports this helper with no globalSetup and must keep a per-file container. Task 4 typecheck plus the worker spec run.

---

### Task 1: Shared server, template, clone/drop in the helper

**Files:**
- Create: `apps/api/test/_helpers/pg-shared-server.ts`
- Create: `apps/api/test/_helpers/jest-global-setup.ts`
- Create: `apps/api/test/_helpers/jest-global-teardown.ts`
- Modify: `apps/api/test/_helpers/postgres-container.ts`
- Modify: `apps/api/jest.config.cjs`, adding `globalSetup` and `globalTeardown`
- Test: `apps/api/test/_helpers/shared-postgres.spec.ts`

**Interfaces:**
- `pg-shared-server.ts` produces:
  - `SHARED_ENV = { host: "RT_PG_SHARED_HOST", port: "RT_PG_SHARED_PORT", template: "RT_PG_SHARED_TEMPLATE" }`
  - `readSharedServer(): { host: string; port: number; template: string } | null`
  - `cloneDatabase(s): Promise<string>`, which returns a name `rt_w<JEST_WORKER_ID>_<8 hex>`
  - `dropDatabase(s, name): Promise<void>`
  - `snapshotRoles(client: Client): Promise<string>`, a stable JSON of `pg_authid` (rolname, all `rol*` flags, rolconnlimit, rolpassword, rolvaliduntil) plus `pg_auth_members`, ordered.
  - The superuser is `postgres`/`postgres`, matching today's helper.
- `postgres-container.ts` produces:
  - `PgTestEnv` gains `host: string`, `port: number`, `database: string`, `cloned: boolean`, `uriFor(user: string, password: string): string`. `container` becomes `container?: StartedPostgreSqlContainer`.
  - `startPgEnv(opts?: { isolated?: boolean })`.
  - `IsolatedPgTestEnv = PgTestEnv & { container: StartedPostgreSqlContainer }`, with an overload `startPgEnv(opts: { isolated: true }): Promise<IsolatedPgTestEnv>`.

- [ ] **Step 1:** Write `shared-postgres.spec.ts` with these tests:
  - `clone has full schema and app role`: `env.cloned === true`; `SELECT to_regclass('public.devices')` is non-null; the `app` pool can `SELECT 1` as `app_test`.
  - `two clones are isolated`: insert a row into a table in env A; env B count is 0; the database names differ.
  - `applyAllUpAndCreateAppRole is a no-op on a clone`: it resolves without error.
  - `uriFor targets this database`: a new Pool from `env.uriFor(APP_ROLE_NAME, APP_ROLE_PASSWORD)` returns `current_database()` equal to `env.database`.
  - `stop drops the database`: after `stopPgEnv`, a probe on `postgres` finds no `pg_database` row.
  - `parallel clones`: `Promise.all` of 4 `startPgEnv()` calls all resolve; then stop all four.
  - `isolated env has its own container`: `startPgEnv({ isolated: true })` has a defined `container` and `cloned === false`.
- [ ] **Step 2:** Run `pnpm --filter @data-pulse-2/api test -- test/_helpers/shared-postgres.spec.ts`. Expected: FAIL, because `cloned` and `uriFor` are undefined.
- [ ] **Step 3:** Implement the three new modules and the helper changes.
  - globalSetup builds the template with the existing `applyAllUpAndCreateAppRole` against an env pointed at `rt_template`. It closes every connection, then stores the container on `globalThis.__RT_PG__` and the role snapshot on `globalThis.__RT_PG_ROLES__`.
  - teardown recomputes the snapshot. On a diff it throws `Error("RT-815 role guard: cluster roles changed during the run …")` with both JSONs, then stops the container in `finally`.
  - `waitForOtherBackendsToExit` gains a `database` filter (`AND datname = $1`).
- [ ] **Step 4:** Run the Step 2 command. Expected: 7 passed.
- [ ] **Step 5:** Commit the helper, the new modules, `jest.config.cjs` and the spec.

### Task 2: Isolated specs and connection strings

**Files:** modify:
- `test/auth/database-pools.integration.spec.ts`
- `test/auth/signin-memberships.http.integration.spec.ts`
- `test/inventory/position/position-grain.spec.ts`
- `test/health/health.http.integration.spec.ts`
- `test/devices/device-expiry-rebaseline.sql.integration.spec.ts`: `startPgEnv({ isolated: true })`, with the env var typed `IsolatedPgTestEnv`
- `test/audit/audit.repository.spec.ts`, `test/catalog/isolation/cross-tenant-read.spec.ts`, `test/catalog/isolation/rls-bypass-probe.spec.ts`: hand-built URIs become `env.uriFor(...)`
- `test/ai-entitlements/entitlement-check.db.integration.spec.ts:285`: `database: env!.database`

- [ ] **Step 1:** Make the edits. Re-run the audit grep from design §3.4, and isolate or filter any new hit.
- [ ] **Step 2:** Run these 9 files. Expected: all pass.
- [ ] **Step 3:** Commit.

### Task 3: Database-scoped barriers

**Files:** modify:
- `test/pos-shifts/shift-cash-up.repository.integration.spec.ts:812`
- `test/pos-shifts/__support__/shift-http-harness.ts:566`: `FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = current_database()`
- `test/pos-cashier-admissions/cashier-admissions.idempotency.integration.spec.ts:389`, `cashier-admissions.integration.spec.ts:757,937`: append `AND datname = current_database()`

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** Run `pos-shifts` and `pos-cashier-admissions` with `--maxWorkers=3`. Expected: all pass.
- [ ] **Step 3:** Commit.

### Task 4: Full verification and probes (no commit of probes)

- [ ] Run `pnpm lint`, `pnpm lint:eslint`, `pnpm typecheck`. Expected: exit 0.
- [ ] Run the full api suite `--coverage --forceExit` at `--maxWorkers=3`. Expected: the suite count and test totals equal `origin/main`, and the threshold passes.
- [ ] Run the worker spec `product-reconciliation-run.spec.ts` with `WORKER_INCLUDE_DB_TESTS=1`. Expected: pass, on its own per-file container.
- [ ] Role-guard probe: add a temporary `CREATE ROLE rt815_probe` to one non-isolated spec. Expected: the run exits non-zero with the "role guard" message. Repeat with `ALTER ROLE app_test PASSWORD 'x2'`. Revert both.
- [ ] Changelog `changelog.d/RT-815-shared-postgres-api-tests.md`. Commit.
