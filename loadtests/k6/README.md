# Backend-Core k6 load tests — first slice

> Track A of Feature 004 (Platform Production Readiness), Phase 2,
> tasks T420–T437.
> Source artifact: `specs/004-platform-production-readiness/tasks.md §5`.

This directory holds the **only** load-test artifacts in this repository.

- No `package.json` change.
- No `pnpm-lock.yaml` change.
- No file under `apps/**` or `packages/**`.
- No CI workflow change.
- Scripts run via an **external** k6 runtime (Docker image or bare CLI).

If you need to change anything outside `loadtests/k6/**` to make load
testing work, **stop and open a separate feature spec** — this slice is
deliberately scoped to a documented harness only.

---

## 1. Execution mode

### 1.1 Recommended — Docker image `grafana/k6:0.50.0` (T420)

The Docker image keeps the k6 runtime reproducible without polluting the
repo with a dependency. The operator's host needs Docker; nothing else.

#### Smoke (~5 RPS, 30s)

```
docker run --rm \
  -v "$PWD/loadtests/k6:/scripts" \
  -e BASE_URL=http://host.docker.internal:3000 \
  -e LOAD_USER_A_EMAIL=... -e LOAD_USER_A_PASSWORD=... \
  -e LOAD_USER_B_EMAIL=... -e LOAD_USER_B_PASSWORD=... \
  -e LOAD_USER_C_EMAIL=... -e LOAD_USER_C_PASSWORD=... \
  grafana/k6:0.50.0 run /scripts/smoke.js \
  --summary-export /scripts/last-smoke.json
```

#### Baseline (6 flows, 5–15m)

```
docker run --rm \
  -v "$PWD/loadtests/k6:/scripts" \
  -e BASE_URL=https://load.example.invalid \
  -e LOAD_USER_A_EMAIL=... -e LOAD_USER_A_PASSWORD=... \
  -e LOAD_USER_B_EMAIL=... -e LOAD_USER_B_PASSWORD=... \
  -e LOAD_USER_C_EMAIL=... -e LOAD_USER_C_PASSWORD=... \
  -e LOAD_DURATION=10m -e LOAD_VUS=20 \
  grafana/k6:0.50.0 run /scripts/baseline.js \
  --summary-export /scripts/last-baseline.json
```

#### Stress (ramp to breakpoint, on-demand)

```
docker run --rm \
  -v "$PWD/loadtests/k6:/scripts" \
  -e BASE_URL=https://load.example.invalid \
  -e LOAD_STRESS_MAX_VUS=300 -e LOAD_STRESS_RAMP=10m -e LOAD_STRESS_PLATEAU=5m \
  -e LOAD_USER_A_EMAIL=... -e LOAD_USER_A_PASSWORD=... \
  -e LOAD_USER_B_EMAIL=... -e LOAD_USER_B_PASSWORD=... \
  -e LOAD_USER_C_EMAIL=... -e LOAD_USER_C_PASSWORD=... \
  grafana/k6:0.50.0 run /scripts/stress.js \
  --summary-export /scripts/last-stress.json
```

#### Regression (compare to a prior baseline JSON)

```
docker run --rm \
  -v "$PWD/loadtests/k6:/scripts" \
  -e BASE_URL=https://load.example.invalid \
  -e PRIOR_BASELINE=/scripts/baselines/2026-05-16-r1.json \
  -e LOAD_USER_A_EMAIL=... -e LOAD_USER_A_PASSWORD=... \
  -e LOAD_USER_B_EMAIL=... -e LOAD_USER_B_PASSWORD=... \
  -e LOAD_USER_C_EMAIL=... -e LOAD_USER_C_PASSWORD=... \
  grafana/k6:0.50.0 run /scripts/regression.js \
  --summary-export /scripts/last-regression.json
```

### 1.2 Fallback — bare CLI

If the operator's host can install k6 directly (Homebrew / apt / Chocolatey /
binary download from the k6 GitHub releases), they may run the scripts
without Docker:

```
BASE_URL=http://localhost:3000 \
LOAD_USER_A_EMAIL=... LOAD_USER_A_PASSWORD=... \
LOAD_USER_B_EMAIL=... LOAD_USER_B_PASSWORD=... \
LOAD_USER_C_EMAIL=... LOAD_USER_C_PASSWORD=... \
k6 run loadtests/k6/smoke.js
```

Pin to a k6 binary version compatible with `grafana/k6:0.50.0` (k6
`v0.50.x`) so behaviour matches the Docker run.

### 1.3 Environment boundaries (T420, FR-A-007)

| Environment                 | Permitted runs              | Notes                                                                |
|-----------------------------|-----------------------------|----------------------------------------------------------------------|
| Local dev                   | smoke only                  | Useful for harness debugging.                                        |
| Non-production load env     | smoke / baseline / stress / regression | Expected target; must mirror prod RLS / auth / tenant context. |
| **Production**              | **forbidden** by FR-A-007    | Production is observed, not load-tested. **Never set `BASE_URL` to a production host.** |

### 1.4 Result artifact format

Always pass `--summary-export <path>.json` (see commands above). k6 writes
a structured JSON summary the operator's wrapper script (or the
regression run inside this repo) can ingest. The summary file is also the
input format for `regression.js`. Per-run JSON exports are stored
out-of-band — they are **not** committed to this repo.

### 1.5 Pass/fail gating rules

| Class       | Pass condition                                                                                                  |
|-------------|-----------------------------------------------------------------------------------------------------------------|
| Smoke       | Zero unexpected status codes; harness completes the 30s run.                                                    |
| Baseline    | Per-flow p95/p99 thresholds in `baseline.js options.thresholds`; `http_req_failed.rate < 0.01`; no 5xx surge.   |
| Stress      | No automated pass/fail. Output is the breakpoint report; operator inspects.                                     |
| Regression  | All tracked flows within the regression delta budget (§4). `regression_report.json` is the durable record.      |

---

## 2. The six candidate first-slice flows (T421)

From `specs/004-platform-production-readiness/plan.md §3.1.3`. All
endpoints are foundation-only; catalog endpoints (Feature 003) are
deliberately excluded from this first slice.

| # | Flow                              | Endpoint(s)                                                                                         | Expected RPS band (per-tenant)      | Track B signals to watch alongside                                                                                                            |
|---|-----------------------------------|------------------------------------------------------------------------------------------------------|-------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| 1 | Sign-in                           | `POST /api/v1/auth/signin`                                                                          | 1–5 RPS sustained, peaks ~20 RPS    | `auth_failure_total` (by `cause`), `suspicious_login_total`, `http_request_duration_seconds{route=...}`, `db_pool_in_use`, `redis_command_duration_seconds` |
| 2 | Session refresh                   | `POST /api/v1/auth/refresh`                                                                         | 10–30 RPS sustained                 | `http_request_duration_seconds{route=...}`, `redis_command_duration_seconds`, session-store latency on the API side                            |
| 3 | Get active context                | `GET /api/v1/context/me`                                                                            | 20–50 RPS sustained                 | `tenant_context_failure_total`, `db_rls_context_failure_total`, `http_request_duration_seconds{route=...}`                                     |
| 4 | List tenant members (RLS read)    | `GET /api/v1/tenants/{tenant_id}/members`                                                           | 5–15 RPS sustained                  | `db_slow_query_total{query_class=...}`, `db_pool_waiters`, `cross_tenant_rejection_total` (must stay zero)                                     |
| 5 | Invite + accept (audit-heavy)     | `POST /api/v1/memberships/invite` + `POST /api/v1/invitations/accept`                               | 1–3 RPS sustained per tenant        | `queue_lag_seconds`, `worker_job_duration_seconds`, `queue_failed_total`, `queue_dead_letter_total`, audit fan-out lag                          |
| 6 | Update membership (governance)    | `PATCH /api/v1/memberships/{membership_id}`                                                         | 1–3 RPS sustained                   | `queue_retry_total`, `worker_processing_failure_total`, `db_rls_context_failure_total`                                                          |

Across three concurrent tenants the aggregate baseline target is roughly
60–200 RPS aggregate — modest by design. Stress runs probe past those
bands until the platform's first failure signal appears.

> Track B signals are emitted by the platform's own observability stack
> (per `docs/observability/signals.md`, to be authored in Phase 3); k6
> itself reports only HTTP-side numbers. See §3 below for the split.

---

## 3. Required success measures (T422)

Per spec §6.4 / plan §3.1.4. **k6 reports the HTTP slice only; Track B
reports everything else.**

| Measure                                                       | Where reported              | Notes                                                                                            |
|---------------------------------------------------------------|------------------------------|--------------------------------------------------------------------------------------------------|
| p50 / p95 / p99 HTTP latency per flow                          | k6 (`--summary-export`)     | Tagged by `flow` for per-endpoint isolation. Thresholds gate baseline runs.                       |
| 4xx rate and 5xx rate (separately, per flow)                   | k6                          | `http_req_failed` for aggregate; per-flow 4xx vs 5xx requires inspection of tagged status codes.  |
| RPS sustained and peak                                         | k6                          | Reported as iterations/s and per-flow request counts.                                             |
| DB pool in-use / waiters                                       | Track B (`docs/observability/signals.md`) | `db_pool_in_use`, `db_pool_waiters`. **No** `tenant_id` label (FR-B-006).            |
| DB slow-query count                                            | Track B                     | `db_slow_query_total{query_class}`. Threshold recommendation: 500ms (research §4).                |
| DB transaction-rollback rate                                   | Track B                     | Emitted from Drizzle pool / instrumentation hook.                                                 |
| Redis p50 / p95 latency                                        | Track B                     | `redis_command_duration_seconds`.                                                                 |
| BullMQ oldest waiting job age (queue lag) per queue            | Track B                     | `queue_lag_seconds`.                                                                              |
| Worker p50 / p95 job duration per job type                     | Track B                     | `worker_job_duration_seconds`.                                                                    |

If a baseline run shows p95/p99 within budget but Track B signals
indicate DB pool saturation, queue lag growth, or RLS-context failures,
treat the run as **failed** even if the HTTP-side thresholds passed.
That's the rationale for running k6 and the platform's `/metrics`
scrape side-by-side.

---

## 4. Regression delta budget (T424)

From `research.md §1`:

- **+10%** p95 latency drift per tracked flow.
- **+20%** p99 latency drift per tracked flow.
- **+0.5 percentage points** absolute error-rate drift per tracked flow
  (on the 0..1 scale, i.e., 0.005).

`regression.js`:

1. Reads `PRIOR_BASELINE` (a previously exported `--summary-export` JSON)
   at init time using `open()`.
2. Runs the same workload as `baseline.js`.
3. In `handleSummary()`, extracts per-flow `p(95)`, `p(99)`, and
   `http_req_failed.rate` for each tracked flow, compares to the prior
   baseline, and writes `regression_report.json` next to the summary
   export.
4. Sets the report status to `regression_detected` if any tracked flow
   breaches any of the three budgets. The operator's wrapper script
   should treat `regression_detected` as a release-blocking signal.

### 4.1 Baseline storage

Prior-baseline JSON files are stored at:

```
loadtests/k6/baselines/<release-tag>.json
```

Example: `loadtests/k6/baselines/2026-05-16-r1.json`.

**Baseline JSON files are NOT committed.** They live in the operator's
artifact store (e.g., a private bucket or release attachment). The
`baselines/` directory exists at run time only inside the Docker bind
mount; this repo does not ship baseline data.

### 4.2 When to recalibrate

Per research §1, the regression delta budget is intentionally generous
for the first three baseline runs while the platform is still settling.
Recalibrate the budget downward once three consecutive baseline runs
land within ±5% of each other. Update the budget in
`regression.js DELTA_BUDGET` only after that calibration — and only with
explicit reviewer approval, because tightening the budget changes the
release-gate behaviour.

---

## 5. Synthetic-data fixture contract (T423)

Full detail: `fixtures/synthetic-tenants.md`.

- **At least three synthetic tenants** in concurrent use: `tenant-load-A`,
  `tenant-load-B`, `tenant-load-C`. The k6 scripts hard-code these slugs
  and assign one per VU via `pickTenantForVu(__VU, ...)` so RLS and pool
  pressure are exercised across at least three tenants simultaneously
  (FR-A-009).
- **Three store profiles**: 2 / 8 / 50 stores per tenant. The choice maps
  to the small / mid / heavy customer shapes from plan §3.1.5.
- **Membership counts**: roughly 5 / 25 / 150 per tenant. Half use
  `store_access_kind: "all"`; half use `"specific"` so both code branches
  see traffic.
- **Pre-provisioned test tokens / users**: one load user per tenant. Email
  and password come from the operator's env vars (`LOAD_USER_*_EMAIL` /
  `LOAD_USER_*_PASSWORD`). Tenant and store IDs come from
  `LOAD_TENANT_*_ID` / `LOAD_STORE_*_ID`. These MUST NOT be committed to
  the repo.
- **Rebuild cadence**: weekly recommended. The reset job in the load
  environment should:
  - drop all `invitee-*@example.invalid` invitations created by the load
    run;
  - reset role grants/revokes back to the documented baseline shape;
  - leave the three tenants themselves intact (do not recreate UUIDs).
- **No fixture data files in this repo.** Operator-side concern; T431
  intentionally ships documentation only.

---

## 6. Library helpers

- `lib/auth.js` (T429): real `POST /api/v1/auth/signin` against synthetic
  credentials. **No guard bypass** — exercises `AuthGuard` exactly as a
  dashboard client would.
- `lib/tenants.js` (T430): real `POST /api/v1/context/tenant` +
  `POST /api/v1/context/store`. Supports ≥3 concurrent tenants per run by
  spreading VUs across the `SYNTHETIC_TENANTS` pool.
- `lib/util.js`: `baseUrl()`, `uuidv4()`, `jsonHeaders()`, `jsonPostHeaders()`
  (the latter includes an `Idempotency-Key` header by default to be
  forward-compatible with Track D's per-endpoint idempotency rollout).

All scripts read the API host from `__ENV.BASE_URL`; the default
(`http://localhost:3000`) is for local dev smoke runs only.

---

## 7. What this slice deliberately does NOT do

- Does NOT add `k6` to `package.json` or any other workspace.
- Does NOT add a CI workflow that runs k6.
- Does NOT change `apps/**` or `packages/**`.
- Does NOT add fixture data files (operator-side concern).
- Does NOT publish a baseline JSON inside the repo.
- Does NOT run against production (FR-A-007).
- Does NOT bypass `AuthGuard` / `TenantContextGuard` / `RolesGuard` (FR-A-010).

Subsequent slices (per `tasks.md §19`) may add CI wiring or expand the
candidate flow set — each is its own gated PR.

---

## 8. Spec drift

The planning artifacts in `specs/004-platform-production-readiness/` use
shorthand paths in a few places (e.g. `POST /v1/auth/login`,
`GET /v1/tenants/me`, `GET /v1/memberships`). These do not match the
actual OpenAPI contracts in `packages/contracts/openapi/`. The k6 scripts
follow the **OpenAPI contracts**, which are the source of truth per
Constitution §IV.

Real paths used by the scripts in this directory:

| Planning shorthand                                | Actual path (OpenAPI source of truth)                              |
|---------------------------------------------------|---------------------------------------------------------------------|
| `POST /v1/auth/login`                              | `POST /api/v1/auth/signin` (operationId `signIn`)                  |
| `POST /v1/auth/refresh`                            | `POST /api/v1/auth/refresh` (operationId `refreshSession`)         |
| `GET /v1/tenants/me`                               | `GET /api/v1/context/me` (operationId `getActiveContext`)          |
| `GET /v1/memberships`                              | `GET /api/v1/tenants/{tenant_id}/members` (operationId `listMembers`) |
| `POST /v1/memberships/invitations`                 | `POST /api/v1/memberships/invite` (operationId `createInvitation`) |
| `POST /v1/memberships/accept`                      | `POST /api/v1/invitations/accept` (operationId `acceptInvitation`) |
| `POST /v1/memberships/{id}/role` (governance write)| `PATCH /api/v1/memberships/{membership_id}` (operationId `updateMembership`) |

This drift is documentation-only — it does not require any
contract or runtime change. It should be reconciled in a future
documentation pass on `specs/004-platform-production-readiness/`.
