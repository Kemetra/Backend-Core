# API test suite — one shared Postgres per run, one database per spec file (2026-10-22)

**Status:** DESIGN, approved by the owner 2026-10-22. Tickets (parent RT-7, related to RT-578, which owns the 8-min target):

- **RT-815** — §3 (test infrastructure).
- **RT-816** — §4.3 [GATED .github].
- **RT-817** — Admin-Console Playwright apt stalls (outside this document).
**Baseline:** `Kemetra/Backend-Core` `origin/main` = `9467f4b1` (fetched 2026-10-22).
**What this document does:** it records why Backend-Core PR CI takes 16–30 min, and specifies a test-infrastructure change that removes the dominant cost *inside the product code*, so the fix moves into the monorepo with the normal re-import instead of being re-done there.

---

## 1. Why

The owner's problem: a Backend-Core PR waits 16–30 min for `ci` before it can be merged. The owner also asked that the monorepo (RT-707/RT-708) must not inherit the problem.

### 1.1 Evidence (all from GitHub, 2026-10-22)

| Fact | Source |
| --- | --- |
| Push-to-`main` CI wall time grew steadily: ~10–11 min (late Sep) → ~14 (mid-Oct) → ~18 (Oct 18–19) → ~21 (Oct 21–22) | `gh api …/workflows/ci.yml/runs`, ~600 successful runs |
| `db-integration` is the critical path: `packages/db` 248 s → worker 64 s → **api 937 s**, serial in one job | run 39802181012, job 119905698699 |
| The api step ran 668 suites / 12 040 tests; summed per-file time ≈ 3 150 s vs 937 s wall, so Jest already runs ~3 workers | same job log |
| **284** of 668 api spec files start their own Postgres container (directly or through a local harness; transitive import closure). 283 of them take ≥ 5 s (avg 9.0 s, sum 2 543 s). All 383 container-free files take < 5 s | import-graph analysis of `apps/api/test/**` + Jest `PASS (x s)` lines |
| `test/health/health.http.integration.spec.ts` starts a container and applies **no** migrations: 5.2 s. The fastest file that applies all 69 migrations: 5.6 s | same log |

### 1.2 Root cause

Every container-backed spec file pays a fixed ~4.5–5 s to boot a fresh `postgres:16-alpine` container in `beforeAll` (`startPgEnv()`), and tears it down in `afterAll` (`stopPgEnv()`). Migrations are comparatively cheap (~0.4 s). 284 files × ~4.5 s ≈ 1 280 s of runner CPU per run is environment setup, not testing. The cost grows linearly with every new integration spec, which matches the steady wall-time growth.

### 1.3 Why this also matters for the monorepo

RT-755 (Done) copied `bc/db-integration` into `Kemetra/Retail-Tower-Shadow` unchanged (single job, no matrix, 40 min timeout). Under RT-709 §B.3.3, most Backend-Core paths force "BC full", so this job is on nearly every BC PR in the monorepo too. A fix in `.github/workflows/ci.yml` alone would have to be redone in the monorepo; a fix in `apps/api/test/_helpers/` is carried by the re-import (RT-760).

## 2. Goals, non-goals, anti-goals

**Goals**

- G1. Backend-Core PR critical path (`ci` green) **≤ 8 min p50**, from ~21 min. Target, not a promise; §6 says how it is measured.
- G2. Per-file Postgres overhead for the 284 container-backed api specs drops from ~5 s to < 1 s.
- G3. The change lives in test helpers and Jest config, so it carries into the monorepo unchanged.

**Non-goals**

- `packages/db` tests (migration up/down cycles; they legitimately need their own lifecycle). Only their *job placement* changes (§4.3).
- Schemathesis (RT-786/RT-809) and the CircleCI PoC (RT-594). This change is complementary: it lowers per-file cost on any CI provider.
- The pre-existing open-handle leak behind `--forceExit`.
- The separate `packages/db/__tests__/_helpers/postgres-container.ts` helper. The api specs that import it (`test/audit/outbox-audit-enqueuer.spec.ts`, `test/catalog/erpnext-posting/feed/posting-feed-ordering.spec.ts`) and the worker specs that use it keep their per-file containers. *My call:* converting them is a follow-up, measured after this lands.

**Anti-goals: if any of these happen, the change has failed, even if CI is faster**

- Any test removed, skipped, or moved out of the PR gate.
- The coverage threshold in `apps/api/jest.config.cjs` lowered.
- Weaker isolation: a spec file observing rows, roles or settings left by another file.
- Different results from `jest path/to/one.spec.ts` (a single file run locally) vs the full CI run.

## 3. Design

### 3.1 Shape

```
Jest globalSetup (once per run, parent process)
  └─ start ONE postgres:16-alpine container
  └─ CREATE DATABASE rt_template
  └─ apply every UP migration in lex order + app_test role + grants   (= applyAllUpAndCreateAppRole)
  └─ export connection info to workers via process.env

each spec file (any worker), in beforeAll
  └─ startPgEnv(): CREATE DATABASE rt_<worker>_<random> TEMPLATE rt_template   (~0.1–0.4 s)
  └─ admin + app pools point at that database

each spec file, in afterAll
  └─ stopPgEnv(): flush, end pools, DROP DATABASE … WITH (FORCE)

Jest globalTeardown
  └─ stop the container
```

Postgres copies a template database at file level and does not replay SQL, which is why the clone is cheap. `GRANT`s live in the database and are copied with it. Roles are cluster-wide, and §3.4 deals with them.

### 3.2 Helper API: keep the call sites unchanged

`apps/api/test/_helpers/postgres-container.ts` keeps its exported names and signatures, so the ~200 call sites (`startPgEnv`, `applyAllUpAndCreateAppRole`, `stopPgEnv`, `PgTestEnv`) do not change:

| Export | New behaviour |
| --- | --- |
| `startPgEnv()` | If the shared server is available (env vars from globalSetup), it clones a fresh database from the template and returns pools for it. Otherwise it falls back to today's per-file container (§3.5). |
| `applyAllUpAndCreateAppRole(env)` | It becomes a **no-op when the database was cloned from the template**, because the schema, role and grants are already there. It keeps today's behaviour on a fallback env. |
| `applyUpAndCreateAppRole(env)` | It is unused by api specs today (0 call sites) and stays as is. |
| `stopPgEnv(env)` | It flushes `deviceActivity`, ends the pools, and runs `DROP DATABASE … WITH (FORCE)`. `waitForOtherBackendsToExit` is scoped to `datname = <this database>`, because other workers' databases live on the same server. |
| `PgTestEnv` connection fields | It gains `host`, `port` and `database` fields, plus a `uriFor(user, password)` helper. `container` becomes **optional**: it is present only on an isolated or fallback env (§3.4, §3.5), and is never a handle to the shared server. Four api call sites build `postgres://…@host:port/test` from `env.container` by hand and move to `uriFor`: `audit/audit.repository.spec.ts:99-102`, `auth/database-pools.integration.spec.ts:50-53`, `catalog/isolation/cross-tenant-read.spec.ts:546-549` and `catalog/isolation/rls-bypass-probe.spec.ts:868-871`. |

**Intended call-site changes, complete list:**

1. The four `uriFor` moves above.
2. The database-scoping filters in §3.4.1.
3. `startPgEnv({ isolated: true })` in the §3.4 files.

Nothing else at call sites changes.

The template build calls the existing `applyAllUpAndCreateAppRole` logic, so the schema a spec sees is byte-identical to today's.

### 3.3 Template freshness

The template is rebuilt on every Jest run, in globalSetup. There is no cross-run cache, so a new migration on the branch is always picked up. A failed migration fails globalSetup, and the whole run reports red. That is the same verdict as today, reached sooner.

### 3.4 Cluster-level state: specs that keep a private container

Roles and server settings are shared by every database on one server. These specs mutate them, so they **opt out** and keep a dedicated container via `startPgEnv({ isolated: true })`:

| Spec | Why |
| --- | --- |
| `test/auth/database-pools.integration.spec.ts` | `CREATE ROLE auth_lookup … BYPASSRLS` (not idempotent; cluster-wide) |
| `test/auth/signin-memberships.http.integration.spec.ts` | `ALTER ROLE auth_lookup PASSWORD …` |
| `test/inventory/position/position-grain.spec.ts` | creates `app_test` itself and applies a custom migration subset |
| `test/health/health.http.integration.spec.ts` | expects an empty, un-migrated database |
| `test/devices/device-expiry-rebaseline.sql.integration.spec.ts` | runs `psql` inside the container (`container.exec(... "-d", "test" ...)`, L72) and `copyContentToContainer` (L128). It needs a real container handle |

The implementer must re-run the audit at implementation time, and add any new hit to this list (or to §3.4.1). The grep covers:

- `CREATE ROLE`, `ALTER ROLE`, `DROP ROLE`;
- `ALTER SYSTEM`, `ALTER DATABASE`;
- `pg_terminate_backend`;
- `CREATE EXTENSION`;
- `SET` without `LOCAL` on a pooled connection;
- `GRANT … TO <role>` outside the template;
- `container.exec`, `copyContentToContainer`;
- **`pg_locks`, `pg_stat_activity`**.

Five or so isolated files cost ~25 s of CPU, which is acceptable.

**Guard rather than trust:** globalSetup records a snapshot of `pg_authid` after the template build: role names, attributes and password hashes. globalTeardown compares and **fails the run** if a non-isolated spec created, dropped or altered a role, **including a password change**. `pg_roles` would not do, because it masks `rolpassword`. This turns a missed audit entry into a red build instead of silent cross-file leakage.

#### 3.4.1 Server-wide activity and lock views: scope to this database

Some specs use cluster-wide views as synchronisation barriers. Today that is safe because each file owns its server. On a shared server, another worker's lock wait would release these barriers early, which is an order-dependent flake and a breach of anti-goal 3. Known sites at `9467f4b1`:

| Site | Barrier |
| --- | --- |
| `test/pos-shifts/shift-cash-up.repository.integration.spec.ts:811-814` | `SELECT count(*) FROM pg_locks WHERE NOT granted` |
| `test/pos-shifts/__support__/shift-http-harness.ts:563-566` | same (harness used by many shift specs) |
| `test/pos-cashier-admissions/cashier-admissions.idempotency.integration.spec.ts:389` | polls `pg_stat_activity` for an advisory waiter |
| `test/pos-cashier-admissions/cashier-admissions.integration.spec.ts:757,937` | same |

*My call:* add a filter rather than isolate. `pg_locks`: `AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`. `pg_stat_activity`: `AND datname = current_database()`. Isolating would put the whole shift harness family back on per-file containers and lose much of the gain. The barrier semantics are unchanged, because every waiter the test cares about is in its own database. `rotation.http.integration.spec.ts:454` already filters this way.

### 3.5 Fallback, and running a single file locally

- `jest test/x.spec.ts` still runs globalSetup, so a single file gets the same shared server and template. Results do not depend on how many files run (anti-goal 4).
- If the env vars are absent (the helper is imported outside Jest's globalSetup), `startPgEnv()` falls back to today's per-file container. That keeps any other consumer of the helper working. One known consumer is the worker spec `apps/worker/test/erpnext-product-reconciliation/product-reconciliation-run.spec.ts:26`, which imports the api helper. The worker Jest config gets no globalSetup, so that spec keeps a per-file container with identical behaviour. It must still type-check under `pnpm typecheck`, because `ci.yml:151-152` covers worker test files.
- `MIGRATION_TEST_ALLOW_SKIP` semantics are unchanged: CI still fails if Testcontainers cannot start.

### 3.6 Concurrency

- Up to ~3 Jest workers share one Postgres server. Before, ~3 containers ran side by side on the same runner, so total Postgres load is about the same with less churn.
- Database names include the Jest worker id and a random suffix, so they cannot collide.
- `CREATE DATABASE … TEMPLATE` requires no open connections to the template. globalSetup closes its connections before any worker starts, and nothing else connects to `rt_template`.

## 4. CI changes

### 4.1 `apps/api/jest.config.cjs`

Add `globalSetup` and `globalTeardown` that point at the new helper modules. No change to `coverageThreshold`, `testTimeout` or `testMatch`.

### 4.2 Backend-Core `.github/workflows/ci.yml` — none required for §3

§3 needs no workflow change: `docker pull postgres:16-alpine` stays, and the api step command is unchanged.

### 4.3 Run `packages/db` tests in their own job [GATED .github]

`packages/db` (248 s) and the worker DB suite (64 s) run before api in the same job today. Splitting them into a parallel job removes ~5 min from the critical path. This is a `.github/**` policy change. In the monorepo it also means a new job key in `tools/project-graph/graph.yaml` (RT-748 territory), so it needs the owner's separate approval. Both the `ci` aggregator `needs:` and the graph job map must list the new job.

### 4.4 Shard the api suite [only if §6 shows G1 is missed]

If the critical path is still above 8 min after §3 + §4.3, the api suite gets `jest --shard=i/2`, with per-shard coverage blobs merged and the threshold evaluated once, which is POS's RT-588 pattern. In the monorepo this means `bc/db-integration` becomes a matrix (the graph already has the `pos/test-shard (×3)` precedent). This is not part of the first implementation.

## 5. Expected effect (hypothesis until measured)

| Step | Critical path estimate |
| --- | --- |
| Today | ~21 min |
| §3 only (shared server + template) | api ~937 s → ~550–600 s; job ~16 min |
| §3 + §4.3 (db/worker in a parallel job) | ~11–12 min |
| + §4.4 (2 api shards) | ~7–8 min |

The estimate assumes ~4.5 s saved per container file × 284, divided by ~3.4 effective workers. It is a hypothesis: the clone time and the single-server contention are measured in §6, not assumed.

## 6. Verification

1. **Parity:** the same SHA before and after has the same suite count (668), the same test count (12 040 passed / 17 skipped / 9 todo, or the current numbers at implementation time), the same coverage percentages within ±0.1 pt, and the threshold verdict unchanged.
2. **Isolation probe:** a test-only spec writes a sentinel row and a sentinel role-free setting in its database. A second spec, forced into the same worker (`--maxWorkers=1`, both files), asserts that it sees neither. This runs once as evidence and is not kept in the suite.
3. **Role guard:** on a scratch branch, add `CREATE ROLE x` to a non-isolated spec, then separately add `ALTER ROLE app_test PASSWORD '…'`, and show that globalTeardown fails the run in both cases.
3b. **Barrier probe:** run the §3.4.1 files with `--maxWorkers=3` together with a spec that holds an ungranted lock in its own database, and show that the barriers do not release early.
4. **Timing:** the api step wall time, the per-file time distribution (Jest `PASS (x s)`), and the `db-integration` job time, from 3 consecutive PR runs, compared with run 39802181012.
5. **Single-file run:** `pnpm --filter @data-pulse-2/api test -- test/auth/auth.controller.spec.ts` passes locally with Docker.

## 7. Decided vs left to the builder

**Decided in conversation with the owner (2026-10-22):**

- The target is PR merge latency.
- The monorepo must not inherit the problem.
- No test or coverage weakening.
- The fix goes into the current Backend-Core repo first.
- Split into three tickets. RT-815's acceptance is parity + < 1 s per-file overhead + measured times. The 8-min p50 stays a target in RT-578, not a ticket gate.

**My calls (open to owner veto):** one shared server per run, not per worker; rebuild the template on every run; the opt-out list in §3.4 plus the teardown role guard on `pg_authid`; database-scoping filters (§3.4.1) instead of isolating the shift/admission families; `container` kept as an optional field for isolated/fallback envs; the `packages/db` helper left out of scope; sharding deferred until it is measured as needed.

**Left to the builder:** module file names for globalSetup/teardown; database-name format; how env vars are named; whether `applyAllUpAndCreateAppRole` detects "cloned" via a flag on `PgTestEnv` or via a schema probe.
