# RT-574 — Rate limiting for console (cookieAuth) routes: inventory, decision proposal, bounded issues

| | |
|---|---|
| **Jira** | RT-574 (parent epic RT-5, relates to RT-561) |
| **Work Mode** | Planning (security). Docs-only; no production code, contract, migration or CI change. |
| **Status** | PROPOSAL for owner review. Nothing here is ratified until the owner approves this PR. |
| **Baseline** | `Kemetra/Backend-Core` `origin/main` = `d9723aa708edb42020d8ac50f59af7e3b3f8eab3` (RT-616, #811). Branch `claude/rt-574-ratelimit-plan-3c4a09`. |
| **Supersedes / extends** | Extends ADR 0009 (`.specify/memory/decisions/0009-pos-write-endpoint-rate-limiting.md`) from POS write routes to console routes. Does not change ADR 0009. |
| **Origin** | RT-561 security review (PR #780): the console read contracts cannot honestly document a 429 because no console limiter exists. |

Line references are to `origin/main` at the baseline SHA above.

---

## 0. Recommendation in five lines

1. **Reuse the existing Redis `RateLimiter`** behind **one new global guard**, registered right after `FailClosedAuthGuard`. No new dependency (`@nestjs/throttler` would need `package.json` + lockfile approval and still needs custom cost-class, report-only and fail-open code).
2. **Key per authenticated user** (`userId`, or `tokenId` for a `dashboard_api` bearer with no user), never per session, tenant or IP.
3. **Four cost classes** with tunable starting budgets: `cheapRead` 300/min, `expensiveRead` 60/min, `write` 30/min, `heavyOrSensitive` 10 per 10 min. Default class by HTTP method; explicit per-route overrides; a ratchet spec forces every cookieAuth route to resolve to a class.
4. **Fail-open with a bounded timeout** (250 ms) and a small circuit breaker, plus a new bounded-label metric. Ship in **report-only** mode first; enforcing is a separate owner decision.
5. **429 contract is additive** (`TooManyRequests` response + `Retry-After` header on every cookieAuth operation, GATED). Admin-Console treats 429 as "back off", never as sign-out, never auto-retries a mutation.

Four child issues are drafted in §8, in dependency order: runtime (report-only) → contract + Admin-Console client (parallel) → enforce flip (owner).

---

## 1. Inventory of what exists today

### 1.1 The primitive

| Item | Evidence | What it does |
|---|---|---|
| `RateLimiter.check(bucketName, identifier, bucket)` | `apps/api/src/auth/rate-limit.ts:148-165` | Redis fixed-window counter. `INCR`; on the first hit `PEXPIRE … NX`; `PTTL` read back. Returns `{allowed, count, remaining, resetMs}`. Key `rl:<bucket>:<identifier>` (`:128-132`). |
| `RateLimiter.release` | `rate-limit.ts:176-180` | Gives one hit back (used by sign-in so only failed authentications count, RT-136). |
| `RedisLike` port | `rate-limit.ts:38-54` | Narrow interface; production adapter is `IoredisIdempotencyAdapter` (`apps/api/src/auth/ioredis-idempotency-adapter.ts`). |
| Provider + export | `auth.module.ts:252-255`, `:324-328` | One shared `RateLimiter`, exported from `AuthModule` for downstream modules (ADR 0009 rationale, `:324-327`). |
| Redis client | `auth.module.ts:100-116` | `new Redis(url)` at `:114` with **ioredis defaults** (offline queue on, retries on). `NODE_ENV=production` without `REDIS_URL` throws at boot (`:103-107`); non-prod falls back to `AlwaysAllowRedis` (`:187-209`), whose `incr` always returns 1, so **limits never trigger in dev/CI without Redis**. |

### 1.2 Buckets that exist

| Bucket(s) | Where | Keyed by | Posture |
|---|---|---|---|
| `signInPerAccount` 5/15 min, `signInPerIp` 30/h, `passwordResetPerIp` 100/day, `passwordResetConfirmPerIp` 10/15 min | `rate-limit.ts:62-75`; used at `auth.controller.ts:121`, `:124`, `:207`, `:225` | account / IP | **Not fail-open.** `guardRateLimit` (`auth.controller.ts:290-316`) awaits `check` with no catch (`:295`), so a Redis outage on these public routes is a 500. The 429 (`RATE_LIMIT_429`, `:88-91`) is a bare `HttpException("Too many requests", 429)` with **no `Retry-After`**; the exception filter fills in the lowercase code `rate_limited` (`common/exception.filter.ts:38-39`, `packages/shared/src/errors/envelope.ts:7`). |
| `pairingPerIp` 30/h, `pairingInvalidGlobal` 300/15 min | `rate-limit.ts:67`, `:74`; `pairing.controller.ts:69-72`, `:94-97` | IP / global | 429 `RATE_LIMITED` + `Retry-After` clamped [1,300] (`pairing.controller.ts:143-161`). POS onboarding, public. |
| `emailVerifyRequestPerUser` 3/h | `rate-limit.ts:70`; `auth.controller.ts:253-258` | user | **The one cookieAuth route that is already limited.** Over the limit the route still answers 202 (no signal, by contract). No catch around `check` (a Redis outage is a 500 on this route). |
| POS write buckets: `posWriteSale` 300/h, `posWriteSettlementIntent` 120/h, `posWriteShift` 120/h, `posReadSaleHistory` 1200/h, `posWriteSaleReprint` 120/h | `rate-limit.ts:85-105` | **device** (ADR 0009 D1) | `PosWriteRateLimitGuard`; fail-open. |
| `posRotateDevice` 10/h, `posRotateRefusalAudit` 20/h (RT-369) | `rate-limit.ts:100`, `:104`; `rotation.service.ts:126-129`; `rotation.controller.ts:34` | device | Separate budgets so a refused token cannot spend the live till's budget. POS surface, out of scope here. |
| `cashierAdmissionTakeover` | `pos-cashier-admissions/takeover-rate-limit.ts` | device | Fail-open **with a 250 ms timeout** (`DEFAULT_TAKEOVER_LIMITER_TIMEOUT_MS`, `cashier-admissions.config.ts:26`), because an ioredis client with an offline queue "could otherwise hold [locks] for seconds" (`takeover-rate-limit.ts:8-15`). |

### 1.3 The guard pattern and ADR 0009

- `PosWriteRateLimitGuard` (`auth/pos-write-rate-limit.guard.ts:49`): per-route bucket from route metadata via `@PosWriteRateLimitBucket(...)` (`pos-write-rate-limit.decorator.ts:23-28`); a route without the decorator is **not throttled** (`guard.ts:70-76`, inert until a route opts in). Keyed by device (`:94-110`). Over limit → 429 `{code:"RATE_LIMITED", message:"Too many requests."}` + `Retry-After` clamped to [1,300] (`:128-141`). **Fail-open** when device resolution or `check` throws (`:92-126`). **No timeout** on `check`: with ioredis defaults an outage hangs the request rather than throwing. Only POS routes carry the decorator (`sales.controller.ts:248`, `sale-history.controller.ts:177,207,231`, `shift-cash-up.controller.ts:112,129,152`, `settlement.controller.ts:119`, `rotation.controller.ts:34`).
- ADR 0009: D1 key per device, not IP/token/tenant; D2 tunable starting defaults; **D3 fail-open for writes with an alert**; D4 429 + `Retry-After`, a contract (GATED) and paired-client change.
- The ADR's alert counter is "AD-TOOL-003-phase-gated"; **`api.metrics.ts` has no rate-limit counter today**. Only the generic `http_error_4xx_total` (`recordHttp4xxError`, `api.metrics.ts:387`) and `auth_failure_total{cause="rate_limited"}` (sign-in only) exist.

### 1.4 What else sits in front of console routes

| Layer | Finding | Evidence |
|---|---|---|
| Reverse proxy | Caddy config has **no** rate-limit directive; stock Caddy has none (it needs a plugin build). The `Caddyfile` only does gzip, the `log_skip` for health probes, `reverse_proxy api:3000`, and static serving. | `Caddyfile:16-70` |
| `@nestjs/throttler` | **Not present** in the root or `apps/api` `package.json`. | grep of both manifests |
| Trust proxy | `TRUST_PROXY` defaults to `false`; prod example/compose set `1`. IP keying is only correct if that stays configured. | `main.ts:46-56`, `deploy/prod.env.example:34-35`, `docker-compose.prod.yml:96` |
| Global auth | `FailClosedAuthGuard` is the only `APP_GUARD`. It runs `AuthGuard` for every non-public, non-device route. | `app.module.ts:240`, `auth/fail-closed-auth.guard.ts:23-48` |
| Per-route console guards | Console controllers use `SessionOnlyAdminGuard` (a cookie session only; token principals rejected, `session-only-admin.guard.ts:39-54`) → `TenantContextGuard` → `RolesGuard`, e.g. `console-sales.controller.ts:92-94`. Some routes use `AuthGuard`/`DashboardAuthGuard` and **accept a `dashboard_api` bearer as well as the cookie**. | `auth.guard.ts:115-162` |
| Idempotency | `IdempotencyInterceptor` saves a replay record only on success and releases its claim on error (`idempotency.interceptor.ts:486-510`), so a 429 is never replayed. Guards also run before interceptors, so a guard-thrown 429 never claims an idempotency key. | same file |

### 1.5 Answer to "what protects cookieAuth console routes today?"

**Almost nothing.** Method: every OpenAPI file under `packages/contracts/openapi` was parsed; an operation counts as cookie-authenticated when its effective `security` names `cookieAuth`.

- **151** operations in total; **106** declare `cookieAuth`, across 27 contract files (`audit`, `auth` (signout/refresh/email-verify), `cash-variance-policy`, `catalog/*`, `connector-admin`, `console-sales`, `context`, `devices`, `connector-health`, `erpnext-reconciliation`, `erpnext-sync-ops`, `inventory`, `memberships`, `outbox`, `platform-support-sessions`, `sale-sync-ops`, `settlement` (payer-accounts), `shift-closes`, `stores`, `tenant-branding`, `tenants`). The per-file operation list is in Appendix A.
- **0 of the 106 document a 429.** The word `Retry-After` appears in `memberships`, `devices`, `cash-variance-policy` and `unknown-items` only in their *idempotency in-progress* (425/409) descriptions, not as a rate limit. `console-sales.openapi.yaml:162-163` states outright: "There is no console rate limit on this surface, so no 429."
- **Runtime:** exactly one cookieAuth route has a limiter (`requestEmailVerification`, §1.2). No console route has a throttle, and no limit is applied by Caddy.
- **Scope is by principal and scheme, not by path.** The cookieAuth set includes `/api/inventory/v1/*` (security default `cookieAuth`, `inventory.yaml:118-119`), which lies outside `/api/v1`. Conversely `POST /api/v1/settlement/settlement-intent` is a POS route that sits under `/api/v1` and is already limited (ADR 0009). A path prefix would get both wrong.

**Net exposure.** A valid (or stolen) console session, or a `dashboard_api` bearer, can issue unbounded requests against the most expensive console reads (31-day sales range scans `console-sales.openapi.yaml:188`, audit search, reconciliation/posting backlog lists, device impact), trigger reconciliation runs, and send invitations, all without any ceiling. A garbage or forged cookie also costs one DB lookup per request (`auth.guard.ts:125`) before any controller-level limiter could run (see residual risk R1).

---

## 2. Decisions

Each decision gives the options, the recommendation and the rationale. "Owner decision" marks the points where the choice is not purely technical.

### D1. Mechanism

| Option | Verdict |
|---|---|
| **A. Reuse `RateLimiter` + one new global guard** | **Recommended.** Zero new dependencies (the primitive was written to need none, `rate-limit.ts:19-23`); same Redis client, key namespace and operational story as ADR 0009; full control of the cost classes, report-only mode, fail-open timeout, envelope and `Retry-After`. |
| B. `@nestjs/throttler` | Rejected for v1. New dependency = `package.json` + lockfile (GATED, needs explicit owner approval, CLAUDE.md §10) and a separate Redis storage adapter (another dependency). It would still need custom code for per-user keying, cost classes, report-only, a fail-open timeout, and the repo's error envelope. Net more surface, not less. |
| C. Caddy rate limit | Rejected. Needs a non-stock plugin build (supply chain), cannot key on the authenticated user, and cannot return the application error envelope. Remains a candidate for the *pre-auth* gap (R1) only. |
| D. In-memory per-instance limiter | Rejected. With several API instances the effective limit multiplies by instance count and resets on restart. |

**Shape of A (guard, not interceptor).**
- A **global `APP_GUARD` registered immediately after `FailClosedAuthGuard`** (`app.module.ts:240`). Global guards run before controller guards and before all interceptors, so (a) `request.principal` is already set, (b) it covers every console controller by default (secure by default, instead of ~25 controllers each having to remember `@UseGuards`), and (c) a 429 never claims an idempotency key (§1.4).
- **It skips** requests with no principal (public routes and device-bearer routes, whose own guards set the principal later), `token` principals whose scope is `pos`, `pos_operator` or `connector`, and routes marked `@ConsoleRateLimit("exempt")`.
- **Exempt:** `POST /auth/signout` (a user must always be able to leave) and `POST /auth/email/verify/request` (it keeps its own silent per-user bucket).
- **Cost class** from a route decorator `@ConsoleRateLimit("cheapRead" | "expensiveRead" | "write" | "heavyOrSensitive" | "exempt")`, **defaulting by HTTP method** (GET/HEAD → `cheapRead`; other verbs → `write`). Explicit overrides pin the expensive and sensitive routes (§D3).
- **Ratchet spec** in the style of `test/auth/route-auth-markers.enforcement.spec.ts`: sweep the real `AppModule`; every route whose contract operation declares `cookieAuth` must resolve to a class; the explicit override list is pinned so a new expensive route cannot silently inherit `cheapRead`. **Order spec:** pin that the limiter guard is registered after `FailClosedAuthGuard`.
- Tenant is not yet resolved at this point (`TenantContextGuard` is controller-level and runs later), which is a further reason to key on the user rather than the tenant.

### D2. Keying

| Option | Verdict |
|---|---|
| **Per user** (`principal.userId`; for a `dashboard_api` bearer with no user, `tokenId`) | **Recommended.** Stable subject: a compromised account that opens N sessions cannot multiply its budget, and a re-sign-in does not reset it. The same reasoning ADR 0009 D1 used against per-token keying. |
| Per session | Rejected as the key. A successful sign-in is not throttled per account (the account bucket counts failures only and is released on success, `rate-limit.ts:6-8`, `auth.controller.ts:116-135`); only the per-IP bucket counts every attempt (30/h/IP, `auth.controller.ts:119-120`, `:124`). Someone holding credentials can therefore mint sessions from a few IPs and multiply a per-session budget. |
| Per tenant | Rejected for v1, for ADR 0009 D1's reason: one abusive subject would consume the whole tenant's budget and degrade every other operator. Revisit only if report-only data shows a tenant-wide fan-out problem. |
| Per IP (post-auth) | Rejected. Stores sit behind shared NAT; per-IP either throttles a whole store or is so high it protects nothing (ADR 0009 D1). Also IP is PII (`redaction-matrix.md:113`). |

**Include `dashboard_api` bearer principals** in the same classes. Several console routes accept the bearer as well as the cookie (`auth.guard.ts:145-162`); limiting only the cookie would leave a trivial bypass.

**Shared logins** (one console account used by several staff) collapse onto one budget. The starting budgets are deliberately generous for that reason; report-only will show whether it is a real pattern.

### D3. Budgets (tunable starting defaults, not frozen contract: ADR 0009 D2)

Fixed window per user per class. Short windows are chosen so a limited operator recovers in at most a minute or ten (a `Retry-After` an operator will actually wait out).

| Class | Applies to | Starting budget | Sizing rationale |
|---|---|---|---|
| `cheapRead` | GET by id, small lists, `context/me`, reference reads | **300 / min / user** | A page load fans out to roughly 5-10 parallel reads (assumption, to be verified against Admin-Console in issue 3). 300/min is ~30 navigations per minute: far above a human, well below a script. |
| `expensiveRead` | `consoleListSales` (31-day range scan), `listAuditEvents`, `consoleGetSaleAuditTimeline`, `consoleListNeedsRepair`, `consoleListPostingBacklog`, `listPostingBacklog`, `listProductReconciliationBacklog`, `listReconciliationResults`, `getProductReconciliationRunResults`, `listErpnextNegativeOnHand`, `listErpnextNegativeOnHandStores`, `consoleGetSyncOpsSummary`, `consoleGetDeviceImpact`, `listStockMovements`, `listOutboxDeadLetters`, `consoleListShiftCloses`, `tenantAdminListUnknownItems` | **60 / min / user** | One request per second sustained is already faster than a person filtering and paging; a scraper hits it in seconds. |
| `write` | every other non-GET (default) | **30 / min / user** | Human-paced mutations (repair, publish policy, create store, stock movement). |
| `heavyOrSensitive` | job triggers and bulk or heavy operations: `triggerReconciliationRun`, `triggerProductReconciliationRun`, `tenantAdminBulkDismissUnknownItems`, `consolePutTenantLogo`, `consolePreviewTenantLogo`, `previewStoreTimezoneChange`; security-sensitive writes: `createInvitation`, `consoleIssuePairingCode`, `tenantAdminIssueConnectorCredential`, `tenantAdminRotateConnectorCredential`, `consoleRevokeDevice`, `consoleRetireDevice`, `openSupportSession`, `createTenant` | **10 / 10 min / user** | Each call is expensive, enqueues background work, sends an email or mints/revokes a credential. A human does this a handful of times a day. |

Notes:
- The route-to-class lists above are the **initial proposal**; the runtime issue finalises them against the real route table and pins them in the ratchet spec.
- Windows differ by class; the 10-minute window means `Retry-After` can be up to 600 s (see D5).
- **Calibrate from report-only data**, as ADR 0009 D2 did, before any enforce flip. Admin-Console polling intervals (sync-ops summary, health) are **not verified here** (cross-repo); if any poll runs faster than the budget allows, report-only must show it before enforcement.
- Fixed windows allow up to 2× burst across a window boundary; accepted (same trade-off as every existing bucket).

### D4. Store and failure posture

- **Store: the existing Redis** (`REDIS_URL`, required in production, `auth.module.ts:103-107`). Multi-instance safe. No in-memory fallback.
- **Fail-open for every class**, matching ADR 0009 D3: the limiter is defence in depth, and a limiter outage must not become a console outage. Fail-closed for `heavyOrSensitive` buys nothing: the job triggers enqueue on the same Redis through BullMQ, so an outage already stops them; and the credential/device writes do not depend on Redis, so failing them closed would turn a limiter outage into a lock-out of the very controls an operator needs during an incident. Revisit as an owner decision at the enforce flip.
- **"Fail-open" must be real, so it needs a bound.** `new Redis(url)` uses ioredis defaults (offline queue + retries), so during an outage `check` *hangs* rather than throws, and `PosWriteRateLimitGuard`'s catch never fires (§1.3). `TakeoverRateLimit` already solves this with a 250 ms race. The new guard **must**:
  1. race `check` against a timeout (default **250 ms**, env `CONSOLE_RATE_LIMIT_TIMEOUT_MS`, 1-10000, read at boot, the same convention as `CASHIER_TAKEOVER_LIMITER_TIMEOUT_MS`);
  2. on timeout or error: allow, increment `outcome=fail_open`, warn-log (no identifiers);
  3. keep a small in-process **circuit breaker** (open after 5 consecutive failures, retry after 10 s) so a sustained outage does not add 250 ms to every console request.
- **Primitive hardening (shared code, flagged).** `check` seeds the TTL only when `count === 1` (`rate-limit.ts:155-157`). If the process dies, or the `PEXPIRE` fails, between `INCR` and `PEXPIRE`, the key keeps no TTL and the bucket never resets. For an IP/device key that is a nuisance; for a long-lived **per-user** key it is a **permanent lockout** of that user once enforced. The runtime issue must self-heal: when `pttl` reports no TTL (`-1`), re-apply `pexpireNx`. This changes a shared primitive (all existing buckets benefit); existing unit tests (`test/auth/rate-limit*.spec.ts`) must stay green or be changed deliberately.

### D5. Response (429 envelope and `Retry-After`)

- **Status 429**, body in the canonical envelope `{ "error": { "code", "message", "request_id" } }`, **non-disclosing** message `"Too many requests."` (no budget, class or window in the body).
- **`Retry-After: <seconds>`**, an integer from `ceil(resetMs/1000)`, clamped to **[1, 600]**. The POS clamp is [1,300] (`pos-write-rate-limit.guard.ts:129-132`); console needs 600 because of the 10-minute class window, otherwise a limited operator is told to retry before the window opens. If `resetMs` is unknown (`-1`), use 1.
- **`Cache-Control: no-store`** on the 429 (guard-thrown exceptions bypass the handler's `@Header`, so the guard sets it).
- **No `X-RateLimit-*` headers in v1**: not needed by the client, and they tell an attacker the budget. Can be added additively later.
- **Error code: OWNER DECISION O1.** The repo is split by case:
  - `RATE_LIMITED` (uppercase): `PosWriteRateLimitGuard` (`pos-write-rate-limit.guard.ts:138`), pairing (`pairing.controller.ts:148,161`), all POS contracts;
  - `rate_limited` (lowercase): the exception filter's canonical status-derived code (`exception.filter.ts:38-39`, `envelope.ts:7`), the takeover limiter, the sign-in 429.
  Console envelopes are lowercase everywhere (`validation_error`, `not_found`, `console-sales.controller.ts:78,82`). **Recommendation: `rate_limited`**, so the console surface is internally consistent and the guard needs no special code. Admin-Console must key on the **HTTP status 429**, treating the code as informational and matching it case-insensitively. If the owner prefers `RATE_LIMITED` for cross-surface uniformity with POS, that is a one-line change in the guard and the contract text; decide before issue 2 merges.

### D6. Rollout: report-only first

- Boot-time `CONSOLE_RATE_LIMIT_MODE`: `off` | `report` | `enforce`. **Default when unset: `report`** (observe only; no behaviour change, no deploy-config change needed to start gathering data).
- `report`: run the same check and classification; on a would-be refusal count `outcome=would_limit` and warn-log at most once per class per 60 s (**class only: no user, tenant or IP**, IP is PII per `redaction-matrix.md:113`); **never throw**.
- `enforce`: throw 429. Enabling it requires an explicit config change (`deploy/prod.env.example` + compose passthrough, i.e. production configuration), which is the **owner-gated issue 4**.
- **Metric (new, required):** counter `console_rate_limit_total` with labels `class` (bounded: the four classes plus `exempt`) and `outcome` (`allowed` | `would_limit` | `limited` | `fail_open`). **No user, tenant, IP or route-template labels.** Existing generic 429s are also visible in `http_error_4xx_total`.
- **Exit criteria for the enforce flip** (all required): issue 2 (contract) and issue 3 (Admin-Console handling) merged; at least 14 days (or the owner's chosen pilot window) of report data; for every class the per-user p99.9 hit count stays below 50% of the budget, or the budget is raised; no unexplained `fail_open` bursts; owner sign-off.

### D7. Contract impact (additive, GATED)

- Add to **every cookieAuth operation** (106 operations, 27 files, Appendix A): `429` → `$ref: "#/components/responses/TooManyRequests"`, with a `Retry-After` header (`integer`, `minimum: 1`, `maximum: 600`) and the file's existing `Error` schema. Each contract file already carries its own `components`; the repo convention (e.g. `pos-sales/sale-history.yaml:394-400, 954-966`) is a per-file `TooManyRequests` response and `RetryAfter` header, so follow it.
- Remove the contradicting sentence at `console-sales.openapi.yaml:162-163` ("There is no console rate limit on this surface, so no 429.") and any equivalent in other files.
- Wording per operation: *"429 `rate_limited` — the caller's per-user budget for this class of operation is spent; honour `Retry-After`; never auto-retry a mutation."* No numbers in the contract (they are tunable, D3).
- **Additive.** Adding a non-2xx response is not a breaking change; the issue's acceptance criterion is `oasdiff` green **with no breaking-ignore lines** and `contract-conformance.spec.ts` green.
- **Ordering.** The contract may merge while the runtime is still `report`: the wording is "may return 429", and the sentence stating otherwise must go before enforcement. Contract merges **before** the enforce flip.
- `[GATED]` per `standing-rules.md` §3 (`packages/contracts/openapi/**`) and the Jira scope; `x-runtime-status` unaffected.

### D8. How Admin-Console should react (spec for issue 3; cross-repo, not implemented here)

- **429 is not 401.** It must never trigger sign-out, re-authentication or the session-expired flow.
- Read `Retry-After` (integer seconds); if missing or invalid use 30 s; clamp to [1, 600].
- **Mutations (POST/PUT/PATCH/DELETE): never retried automatically.** Preserve form state; show the failure with a "Try again in Ns" affordance.
- **Reads: at most one automatic retry**, after `Retry-After` plus 0-1 s jitter, and only for a request the user initiated (not background polling).
- **Global back-off gate:** on any 429, suppress background polling and prefetch until the `Retry-After` has elapsed, so one limited class does not spawn a storm of failing background calls.
- **Disable the query-client default retry for 429.** (A TanStack-style default of 3 exponential retries would hammer the limiter. Admin-Console's actual default cannot be verified from this repo: issue 3 must check it.)
- UX: a non-blocking, dismissible banner ("Too many requests, retrying in Ns") with a manual retry; no raw error strings; accessible live region.
- Match `error.code` case-insensitively; key behaviour on the status.

---

## 3. Residual risks and out of scope

| ID | Risk / boundary | Treatment |
|---|---|---|
| R1 | **Pre-auth gap.** A garbage or forged cookie (and any unauthenticated request to a guarded route) costs a session lookup at `auth.guard.ts:125` before any post-auth limiter sees it. | Not solved by this proposal. Candidate follow-up: a high, NAT-safe per-IP pre-auth ceiling (report-only first), or a Caddy-level limit (needs a plugin build: a new dependency, owner approval). **Owner decision O2: accept R1 for now, or open a separate issue.** |
| R2 | Redis outage disables the limiter (fail-open). | Visible via `fail_open` outcome; alert on it. Same accepted trade-off as ADR 0009 D3. |
| R3 | Shared console logins share a budget. | Generous starting budgets; report-only will show it. |
| R4 | Fixed-window 2× burst at the boundary. | Accepted. |
| R5 | `AlwaysAllowRedis` in non-prod: limits never trigger without `REDIS_URL`. | Enforcement tests need real Redis (Docker-gated integration). Unit tests use fakes. |
| R6 | **Pre-existing:** sign-in and email-verify limiters are not fail-open (a Redis outage is a 500, `auth.controller.ts:295`) and sign-in 429 has no `Retry-After`. | Out of scope here. Failing closed on sign-in is arguably right for brute-force protection; flagged so the owner can decide separately (**O3**). |
| Out of scope | POS and device routes (ADR 0009), connector routes (`/api/connector/v1/*`), public auth routes, and non-`dashboard_api` bearer scopes. | Unchanged. |

---

## 4. Owner decisions needed

| # | Decision | Recommendation |
|---|---|---|
| O1 | Console 429 error code: `rate_limited` vs `RATE_LIMITED`. | `rate_limited` (D5). |
| O2 | Treat the pre-auth cookie-flood gap (R1) as accepted, or open a follow-up issue? | Open a separate, report-only follow-up after issue 1 lands. |
| O3 | Separate decision on sign-in / email-verify Redis-outage posture (R6)? | Raise separately; not part of RT-574. |
| O4 | Approve the cost-class model and starting numbers (D3) as *starting defaults*. | Approve; calibrate in report-only. |
| O5 | The enforce flip itself (issue 4). | After the exit criteria in D6. |

---

## 5. Draft implementation issues (text only; **not created in Jira**)

Dependency order: **1** → (**2** ∥ **3**) → **4**.

### Issue 1: Backend-Core — console rate limiting runtime: global guard, cost classes, report-only (RT-574 follow-up)

- **Repo:** Backend-Core. **Work Mode:** Implementation. **Depends on:** RT-574 decision approved (O1, O4). **GATED surfaces:** none (no dependency, migration, contract or CI change). Documenting the new env vars in `deploy/prod.env.example` is optional and value-neutral; changing a prod value is not part of this issue.
- **Scope:**
  - `ConsoleRateLimitGuard` + `@ConsoleRateLimit(...)` decorator + class table (`CONSOLE_RATE_LIMIT_CLASSES`) next to `rate-limit.ts`; registered as an `APP_GUARD` immediately after `FailClosedAuthGuard`.
  - Skip rules, exemptions, default-by-method and the explicit overrides in D1/D3, finalised against the real route table.
  - Keying per D2 (`userId ?? tokenId` for `dashboard_api`; skip `pos`/`pos_operator`/`connector` scopes and requests with no principal).
  - Modes `off`/`report`/`enforce` (default `report`), boot-time env; 429 shape per D5 (code per O1).
  - Timeout (default 250 ms) + circuit breaker, fail-open (D4).
  - `console_rate_limit_total{class,outcome}` metric (bounded labels).
  - `RateLimiter.check` self-heal for a TTL-less key (D4).
- **Out of scope:** POS/device/connector routes; contract text (issue 2); Admin-Console (issue 3); changing sign-in/email-verify behaviour; any per-IP pre-auth limiter; flipping to `enforce`.
- **Acceptance criteria:**
  1. In `report` mode no request is ever refused by the guard; would-be refusals increment `outcome=would_limit`; warn logs contain no user, tenant or IP.
  2. In `enforce` mode the (limit+1)-th request in a window to a class returns 429 with the canonical envelope, `Retry-After` in [1,600] and `Cache-Control: no-store`; the next window succeeds.
  3. Keying is per user: two sessions of one user share a budget; two users do not; a `dashboard_api` bearer without a user keys on `tokenId`.
  4. Every cookieAuth route resolves to a class; the explicit-override list is pinned by a ratchet spec, so a new route that is not on the list inherits the method default (`cheapRead` / `write`) and a change to the pinned list needs a deliberate spec edit.
  5. POS, device, connector and unauthenticated requests are not touched; `signOut` and `requestEmailVerification` are exempt.
  6. Redis down or hanging: the request is allowed within the timeout; `fail_open` is counted; after 5 consecutive failures the breaker skips checks for 10 s; no request is delayed by more than the timeout.
  7. A TTL-less counter key is repaired on the next `check`.
  8. A guard-thrown 429 neither claims nor stores an idempotency key (retrying with the same key after the window succeeds).
  9. The limiter guard is registered after `FailClosedAuthGuard` (order spec).
  10. No new dependency; no change to `package.json`, lockfile, migrations, `.github/**` or `packages/contracts/openapi/**`.
  11. **db-integration CI is green** (every harness that boots `AppModule` still boots; the guard's dependencies resolve there and in standalone harnesses: see the soft-skip hazard in project memory).
- **Tests:**
  - Unit (fakes, Docker-free): classification and default-by-method; keying matrix; skip/exempt rules; over-limit 429 headers/body; `report` never throws; `enforce` throws; fail-open on throw and on timeout; breaker open/close; self-heal; metric labels are bounded (no user/tenant/IP).
  - Ratchet spec over the real `AppModule` (pattern: `test/auth/route-auth-markers.enforcement.spec.ts`) and a guard-order spec.
  - HTTP integration with real Redis (Docker-gated): boundary 429, window rollover, idempotency non-claim, Redis stop → fail-open within the timeout.
  - Existing `test/auth/rate-limit*.spec.ts` and `pos-write-rate-limit.guard.unit.spec.ts` stay green.

### Issue 2: Backend-Core — console contract wording: documented 429 on cookieAuth operations (GATED, contract-first)

- **Repo:** Backend-Core. **Work Mode:** Implementation (contract). **GATED:** `packages/contracts/openapi/**`; needs explicit owner authorisation. **Depends on:** RT-574 decision (O1). Can merge before the runtime enforces.
- **Scope:** per D7: add `429` + `TooManyRequests` response + `Retry-After` header to all 106 cookieAuth operations in the 27 contract files (Appendix A); delete the "no 429" sentence in `console-sales.openapi.yaml:162-163` and any equivalent; update affected `info.description` status mappings and changelog entries.
- **Out of scope:** runtime change; POS/device contracts; new error codes beyond the one chosen in O1; request-body changes.
- **Acceptance criteria:**
  1. Every operation that declares `cookieAuth` documents a 429 with the `Retry-After` header (`integer`, 1-600) and the file's `Error` schema; no operation outside the cookieAuth set gains a 429.
  2. `oasdiff` breaking-change gate green **with no breaking-ignore lines** added.
  3. `contract-conformance.spec.ts` green; OpenAPI lint green; no `x-runtime-status` change.
  4. No contract text states a numeric budget.
- **Tests:** a contract test (sweep all contract files) asserting that every `cookieAuth` operation has a `429` response referencing `Retry-After`, so a future cookieAuth operation without it fails CI; oasdiff run attached as evidence.

### Issue 3: Admin-Console — handle 429 from Backend-Core (backoff, `Retry-After`, no retry storms)

- **Repo:** `Kemetra/Admin-Console`. **Work Mode:** Implementation. **Depends on:** issue 2 merged (contract-first); not on the runtime enforcing.
- **Scope:** per D8: status-based 429 handling in the HTTP/query layer; `Retry-After` parsing with a 30 s fallback and [1,600] clamp; no automatic mutation retry; at most one deferred read retry for user-initiated reads; global back-off gate pausing polling/prefetch; banner with live region; verify and override the query-client default retry for 429. First task: **inventory every polling interval and parallel page-load fan-out** and report it on the RT-574 thread (it validates D3's `cheapRead` assumption).
- **Out of scope:** any Backend-Core change; changing 401/403 handling; per-route custom UX beyond the shared banner.
- **Acceptance criteria:**
  1. A 429 never signs the user out or routes to sign-in.
  2. A mutation that gets a 429 is not retried automatically and the form input is preserved.
  3. A user-initiated read is retried at most once, after `Retry-After` (+jitter); background polling and prefetch are suppressed until the back-off elapses.
  4. A missing/invalid `Retry-After` falls back to 30 s; values are clamped to [1,600].
  5. The banner is dismissible, announced to assistive tech, and shows the remaining time.
  6. `error.code` is matched case-insensitively; behaviour keys on status 429.
- **Tests:** unit tests for the `Retry-After` parser and the retry policy; component/integration tests with a mocked 429 asserting exact request counts (no storm), no sign-out, mutation not retried, polling paused then resumed; an accessibility check on the banner.

### Issue 4: Backend-Core — flip console rate limiting from report-only to enforce (OWNER DECISION, production config)

- **Repo:** Backend-Core (+ deploy config). **Work Mode:** Implementation. **GATED:** production configuration (CLAUDE.md §10); explicit owner approval required. **Depends on:** issues 1, 2 and 3 merged, and the D6 exit criteria met.
- **Scope:** set `CONSOLE_RATE_LIMIT_MODE=enforce` through the deploy path (`deploy/prod.env.example` and the compose passthrough); adjust any class budget the report data shows is wrong; record the calibration evidence and a rollback step (set `report`; no deploy of code needed).
- **Out of scope:** new classes, new keying, contract changes.
- **Acceptance criteria:**
  1. The calibration evidence (window, per-class p99.9 vs budget, `fail_open` count) is attached before the flip.
  2. After the flip, `console_rate_limit_total{outcome="limited"}` is non-zero only for the expected classes; Admin-Console shows the banner (not an error page) when a limit is provoked on staging.
  3. A documented one-step rollback (`report`) is verified on staging.
  4. The owner records approval on the issue.
- **Tests / evidence:** staging run that provokes each class once; screenshots/logs of the banner and the 429 headers; metric snapshot before and after.

---

## 6. Verification performed for this record

- Repository state: `git fetch origin`; branch clean; `HEAD` = `origin/main` = `d9723aa7`.
- All `file:line` references were read at that SHA.
- The cookieAuth/429 counts come from parsing every YAML under `packages/contracts/openapi` (script run locally; not committed).
- **Not verified (stated as assumptions):** Admin-Console's real polling intervals and query-client retry default (cross-repo); production API instance count; the ioredis hang-on-outage behaviour is inferred from the default client options (`auth.module.ts:114`) and the existing takeover limiter's own documentation (`takeover-rate-limit.ts:8-15`), not reproduced here.
- No production code, contract, migration, dependency or CI file was modified.

---

## Appendix A. cookieAuth operations by contract (from the parse; none documents a 429)

| Contract | Ops | Operations |
|---|---:|---|
| `audit.openapi.yaml` | 1 | `listAuditEvents` |
| `auth.openapi.yaml` | 3 | `signOut`, `refreshSession`, `requestEmailVerification` |
| `cash-variance-policy.openapi.yaml` | 6 | `consoleGet/List…/Publish…` tenant and store policy |
| `catalog/erpnext-item-map.yaml` | 4 | `tenantAdminList/Suggest/Confirm/RetireErpnextItemMapping` |
| `catalog/erpnext-warehouse-map.yaml` | 3 | `tenantAdminList/Set/RetireErpnextWarehouseMapping` |
| `catalog/product-reconciliation.yaml` | 5 | backlog, repairs, runs, trigger, results |
| `catalog/tracking-profile.yaml` | 2 | get / set tracking profile |
| `catalog/unknown-items.yaml` | 7 | list, inspect, dismiss, link, create-product, reopen, bulk-dismiss |
| `connector/connector-admin.yaml` | 6 | instances, disable, credentials issue/rotate/revoke |
| `console-sales.openapi.yaml` | 2 | `consoleListSales`, `consoleGetSale` |
| `context.openapi.yaml` | 4 | `getActiveContext`, `switchActiveTenant`, `switchActiveStore`, `clearActiveStore` |
| `devices.openapi.yaml` | 8 | list/get/revoke/retire/impact devices; list/issue/cancel pairing codes |
| `erpnext-connector/connector-health.yaml` | 2 | `listConnectorHealth`, `getConnectorHealth` |
| `erpnext-reconciliation/reconciliation.yaml` | 9 | posting backlog/repair/re-resolve, runs, results, negative-on-hand |
| `erpnext-sync-ops/console-sync-ops.yaml` | 3 | summary, posting backlog, reconciliation runs |
| `inventory/inventory.yaml` | 7 | movements, locations, tracking identities, on-hand, transfers, counts (under `/api/inventory/v1`) |
| `memberships.openapi.yaml` | 3 | `createInvitation`, `updateMembership`, `revokeMembership` |
| `outbox.openapi.yaml` | 2 | dead-letter list / get |
| `platform-support-sessions.openapi.yaml` | 4 | open / current / renew / end |
| `sale-sync-ops/sale-sync-ops.yaml` | 4 | status, needs-repair, audit-timeline, repair |
| `settlement/settlement.yaml` | 3 | `consoleListPayerAccounts`, `consoleCreatePayerAccount`, `consoleUpdatePayerAccount` |
| `shift-closes.openapi.yaml` | 2 | list / get shift close |
| `stores.openapi.yaml` | 6 | list/create/read/update/delete store, timezone-change-preview |
| `tenant-branding.openapi.yaml` | 4 | logo get/put/delete/preview |
| `tenants.openapi.yaml` | 6 | list/create/read/update/delete tenant, list members |

(The per-operation `operationId` list was produced by the parse and is reproduced in full in the runtime issue's route-table task, which is the authoritative source for the ratchet spec.)
