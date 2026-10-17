# RT-574 — Rate limiting for console (cookieAuth) routes: inventory, decision proposal, bounded issues

| | |
|---|---|
| **Jira** | RT-574 (parent epic RT-5, relates to RT-561) |
| **Work Mode** | Planning (security). Docs-only; no production code, contract, migration or CI change. |
| **Status** | PROPOSAL, **revision 3** (incorporates the coordinator/Opus reviews of revisions 1 and 2, and the bot review comments). Nothing here is ratified until the owner approves this PR. |
| **Baseline** | `Kemetra/Backend-Core` `origin/main` = `d9723aa708edb42020d8ac50f59af7e3b3f8eab3` (RT-616, #811). Branch `claude/rt-574-ratelimit-plan-3c4a09`. Admin-Console facts verified at `Kemetra/Admin-Console` `origin/main` `f8c972a`. |
| **Extends** | ADR 0009 (`.specify/memory/decisions/0009-pos-write-endpoint-rate-limiting.md`) from POS write routes to console routes. Does not change ADR 0009. |
| **Origin** | RT-561 security review (PR #780): the console read contracts cannot honestly document a 429 because no console limiter exists. |

Line references are to `origin/main` at the baseline SHA above.

---

## 0. Recommendation in six lines

1. **Reuse the existing Redis `RateLimiter`** behind **one new global guard**, registered right after `FailClosedAuthGuard`. No new dependency (`@nestjs/throttler` would need `package.json` + lockfile approval and still needs custom cost-class, report-only and fail-open code).
2. **Key per authenticated user** (`userId`, or `tokenId` for a `dashboard_api` bearer with no user), never per session, tenant or IP.
3. **Six cost classes** with tunable starting budgets (§D3): `cheapRead` 300/min, `expensiveRead` 60/min, `write` 30/min, `jobOrPreview` 10/10 min, `onboarding` 20/h, `incidentControl` 120/10 min (generous, so an incident is never locked out). Default class by HTTP method; a ratchet spec snapshots every route with its class.
4. **Fail-open with a bounded timeout** (250 ms) and a circuit breaker, plus new bounded-label telemetry. The guard ships **default `off`**; `report` is enabled by explicit config, then `enforce` as a separate owner decision. Merging the guard is not a behaviour change; switching it to `report` is a (small, measured) latency and Redis-load change.
5. **429 contract is additive** on **103** cookieAuth operations (106 minus three shared exemptions: `signOut`, `requestEmailVerification`, `refreshSession`), GATED. Admin-Console treats 429 as back-off, never as sign-out, never auto-retries a mutation.
6. **Sign-in has its own, separate gaps** (no `Retry-After`, lockout-DoS, no `email/verify/confirm` limit, unset-`TRUST_PROXY` collapse, Redis-outage posture). They are split into five independent drafted issues (§5, issues 5a-5e: contract + `Retry-After`, `TRUST_PROXY` boot check, lockout redesign, new public buckets + alert, outage posture) so they do not ride on the console decision.

Draft issues, in dependency order (§5): **1a** primitive hardening → **1** runtime → (**2** contract ∥ **3** Admin-Console) → **4** report-then-enforce (owner); **5a-5e** sign-in hardening is independent.

---

## 1. Inventory of what exists today

### 1.1 The primitive

| Item | Evidence | What it does |
|---|---|---|
| `RateLimiter.check(bucketName, identifier, bucket)` | `apps/api/src/auth/rate-limit.ts:148-165` | Redis fixed-window counter. `INCR`; on the first hit `PEXPIRE … NX`; `PTTL` read back: **2-3 Redis round trips per check**. Returns `{allowed, count, remaining, resetMs}`. Key `rl:<bucket>:<identifier>` (`:128-132`). |
| `RateLimiter.release` | `rate-limit.ts:176-180` | Gives one hit back (sign-in uses it so only failed authentications count, RT-136). |
| `RedisLike` port | `rate-limit.ts:38-54` | Narrow interface (`incr`, `pexpireNx`, `pttl`, `decr`, `del`; no `eval`); production adapter is `IoredisIdempotencyAdapter` (`auth/ioredis-idempotency-adapter.ts`). |
| Provider + export | `auth.module.ts:252-255`, `:324-328` | One shared `RateLimiter`, exported from `AuthModule` for downstream modules. |
| Redis client | `auth.module.ts:100-116` | `new Redis(url)` at `:114` with **ioredis defaults** (offline queue on, retries on). `NODE_ENV=production` without `REDIS_URL` throws at boot (`:103-107`); non-prod falls back to `AlwaysAllowRedis` (`:187-209`), whose `incr` always returns 1, so **limits never trigger in dev/CI without Redis**. |

### 1.2 Buckets that exist

| Bucket(s) | Where | Keyed by | Posture |
|---|---|---|---|
| `signInPerAccount` 5/15 min, `signInPerIp` 30/h, `passwordResetPerIp` 100/day, `passwordResetConfirmPerIp` 10/15 min | `rate-limit.ts:62-75`; used at `auth.controller.ts:121`, `:124`, `:207`, `:225` | account (email) / IP | **Not fail-open and unbounded in time.** `guardRateLimit` (`auth.controller.ts:290-316`) awaits `check` with no catch and no timeout (`:295`): with ioredis defaults a Redis outage hangs or 500s the public routes. The 429 (`RATE_LIMIT_429`, `:88-91`) is a bare `HttpException("Too many requests", 429)` with **no `Retry-After`**; the filter fills in the lowercase code `rate_limited` (`common/exception.filter.ts:38-39`, `packages/shared/src/errors/envelope.ts:7`). `auth.openapi.yaml:49-54` documents the sign-in 429 without a `Retry-After` header; `requestPasswordReset` (`:102-120`) documents no 429 at all although the runtime can throw one. |
| *(missing)* | `auth.controller.ts:266-274` | none | **`POST /auth/email/verify/confirm` is public and has no limiter.** `POST /auth/password-reset/request` is limited per IP only (`:207`), not per email. There is no global failed-sign-in cap. |
| `pairingPerIp` 30/h, `pairingInvalidGlobal` 300/15 min | `rate-limit.ts:67`, `:74`; `pairing.controller.ts:69-72`, `:94-97` | IP / global | 429 `RATE_LIMITED` + `Retry-After` clamped [1,300] (`pairing.controller.ts:143-161`). POS onboarding, public. |
| `emailVerifyRequestPerUser` 3/h | `rate-limit.ts:70`; `auth.controller.ts:253-258` | user | **The one cookieAuth route that is already limited.** Over the limit the route still answers 202 (no signal, by contract). No catch or timeout around `check`. |
| POS write buckets: `posWriteSale` 300/h, `posWriteSettlementIntent` 120/h, `posWriteShift` 120/h, `posReadSaleHistory` 1200/h, `posWriteSaleReprint` 120/h | `rate-limit.ts:85-105` | **device** (ADR 0009 D1) | `PosWriteRateLimitGuard`; fail-open. |
| `posRotateDevice` 10/h, `posRotateRefusalAudit` 20/h (RT-369) | `rate-limit.ts:100`, `:104`; `rotation.service.ts:126-129`; `rotation.controller.ts:34` | device | Separate budgets so a refused token cannot spend the live till's budget. POS surface, out of scope here. |
| `cashierAdmissionTakeover` | `pos-cashier-admissions/takeover-rate-limit.ts` | device | Fail-open **with a 250 ms timeout** (`DEFAULT_TAKEOVER_LIMITER_TIMEOUT_MS`, `cashier-admissions.config.ts:26`), because an ioredis client with an offline queue "could otherwise hold [locks] for seconds" (`takeover-rate-limit.ts:8-15`). |

### 1.3 The guard pattern and ADR 0009

- `PosWriteRateLimitGuard` (`auth/pos-write-rate-limit.guard.ts:49`): per-route bucket from route metadata via `@PosWriteRateLimitBucket(...)` (`pos-write-rate-limit.decorator.ts:23-28`); a route without the decorator is **not throttled** (`guard.ts:70-76`). Keyed by device (`:94-110`). Over limit → 429 `{code:"RATE_LIMITED", message:"Too many requests."}` + `Retry-After` clamped to [1,300] (`:128-141`). **Fail-open** when device resolution or `check` throws (`:92-126`). **No timeout** on `check`, so the fail-open catch never fires during a hang. Only POS routes carry the decorator (`sales.controller.ts:248`, `sale-history.controller.ts:177,207,231`, `shift-cash-up.controller.ts:112,129,152`, `settlement.controller.ts:119`, `rotation.controller.ts:34`).
- ADR 0009: D1 key per device, not IP/token/tenant; D2 tunable starting defaults; **D3 fail-open for writes with an alert**; D4 429 + `Retry-After`, a contract (GATED) and a paired-client change.
- The ADR's alert counter is "AD-TOOL-003-phase-gated"; **`api.metrics.ts` has no rate-limit counter today**. Only the generic `http_error_4xx_total{route,status}` (`recordHttp4xxError`, `api.metrics.ts:325-328, 387`) and `auth_failure_total{cause="rate_limited"}` (sign-in only) exist.

### 1.4 What else sits in front of console routes

| Layer | Finding | Evidence |
|---|---|---|
| Reverse proxy | Caddy config has **no** rate-limit directive; stock Caddy has none (it needs a plugin build). | `Caddyfile:16-70` |
| `@nestjs/throttler` | **Not present** in the root or `apps/api` `package.json`. | grep of both manifests |
| Trust proxy | `TRUST_PROXY` defaults to `false` when unset; prod example/compose set `1`. With it unset behind Caddy, `req.ip` is Caddy's address, so **all clients share one IP bucket** (the 30/h sign-in IP budget becomes a global one). | `main.ts:46-56`, `deploy/prod.env.example:34-35`, `docker-compose.prod.yml:96` |
| Global auth | `FailClosedAuthGuard` is the only `APP_GUARD`. It runs `AuthGuard` for every non-public, non-device route. | `app.module.ts:240`, `auth/fail-closed-auth.guard.ts:23-48` |
| Per-route console guards | Console controllers use `SessionOnlyAdminGuard` (a cookie session only; token principals rejected, `session-only-admin.guard.ts:39-54`) → `TenantContextGuard` → `RolesGuard`, e.g. `console-sales.controller.ts:93`. Some routes use `AuthGuard`/`DashboardAuthGuard` and **accept a `dashboard_api` bearer as well as the cookie** (`auth.guard.ts:145-162`). | |
| Idempotency | `IdempotencyInterceptor` saves a replay record only on success and releases its claim on error (`idempotency.interceptor.ts:486-510`), so a 429 is never replayed. Guards also run before interceptors, so a guard-thrown 429 never claims an idempotency key. | same file |
| Request id | `RequestIdInterceptor` is a **global interceptor** (`main.ts:77-82`), so it runs after guards. A guard-thrown 429 reaches the filter with `request.requestId` unset; the filter mints a new id (`exception.filter.ts:106`) that is not echoed in `X-Request-Id` and matches no log line (see D5). | |

### 1.5 Answer to "what protects cookieAuth console routes today?"

**Almost nothing.** Method: every OpenAPI file under `packages/contracts/openapi` was parsed; an operation counts as cookie-authenticated when its effective `security` names `cookieAuth`.

- **151** operations in total; **106** declare `cookieAuth`, across **25** contract files (Appendix A). **0 of the 106 document a 429.** The word `Retry-After` appears in `memberships`, `devices`, `cash-variance-policy` and `unknown-items` only in their *idempotency in-progress* (425/409) descriptions, not as a rate limit. `console-sales.openapi.yaml:162-163` states outright: "There is no console rate limit on this surface, so no 429."
- **Runtime:** exactly one cookieAuth route has a limiter (`requestEmailVerification`, §1.2). No console route has a throttle, and Caddy applies none.
- **Scope is by principal and scheme, not by path.** The cookieAuth set includes `/api/inventory/v1/*` (security default `cookieAuth`, `inventory.yaml:118-119`), which lies outside `/api/v1`. Conversely `POST /api/v1/settlement/settlement-intent` is a POS route under `/api/v1` that is already limited (ADR 0009). A path prefix would get both wrong.

**Net exposure.** A valid (or stolen) console session, or a `dashboard_api` bearer, can issue unbounded requests against the most expensive console reads (31-day sales range scans `console-sales.openapi.yaml:188`, audit search, reconciliation/posting backlog lists, device impact), trigger reconciliation runs, and send invitations, all without any ceiling. A garbage or forged cookie also costs one DB lookup per request (`auth.guard.ts:125`) before any controller-level limiter could run (residual risk R1).

---

## 2. Decisions

"Owner decision" marks the points where the choice is not purely technical; all are collected in §7.

### D1. Mechanism

| Option | Verdict |
|---|---|
| **A. Reuse `RateLimiter` + one new global guard** | **Recommended.** Zero new dependencies (the primitive was written to need none, `rate-limit.ts:19-23`); same Redis client, key namespace and operational story as ADR 0009; full control of the cost classes, report-only mode, fail-open timeout, envelope and `Retry-After`. |
| B. `@nestjs/throttler` | Rejected for v1. New dependency = `package.json` + lockfile (GATED, needs explicit owner approval, CLAUDE.md §10) and a separate Redis storage adapter (another dependency). It would still need custom code for per-user keying, cost classes, report-only, a fail-open timeout, and the repo's error envelope. |
| C. Caddy rate limit | Rejected. Needs a non-stock plugin build (supply chain), cannot key on the authenticated user, and cannot return the application error envelope. Remains a candidate for the *pre-auth* gap (R1) only. |
| D. In-memory per-instance limiter | Rejected. With several API instances the effective limit multiplies by instance count and resets on restart. |

**Shape of A (guard, not interceptor).**
- A **global `APP_GUARD` registered immediately after `FailClosedAuthGuard`**, **in the same `providers` array of `AppModule`, adjacent** (`app.module.ts:240`; global-guard order across modules depends on module import order, so it is pinned by an order spec rather than assumed). Global guards run before controller guards and before all interceptors, so (a) `request.principal` is already set, (b) it covers every console controller by default instead of ~25 controllers each having to remember `@UseGuards`, and (c) a 429 never claims an idempotency key (§1.4).
- **It skips** requests with no principal (public routes and device-bearer routes, whose own guards set the principal later), `token` principals whose scope is `pos`, `pos_operator` or `connector`, and routes on the **shared exemption list**.
- **One shared exemption list**, a single module imported by both the runtime ratchet spec and the contract sweep of issue 2, so the sweep can never force a false 429 into a contract: `signOut`, `requestEmailVerification`, `refreshSession`.
  - `signOut`: a user must always be able to leave.
  - `requestEmailVerification`: keeps its own silent per-user bucket (always 202).
  - `refreshSession`: **Admin-Console treats a non-ok refresh as session loss** (`auth-interceptor.ts`: `if (!refreshed.ok) { deps.onSessionLost(); … }`, Admin-Console `f8c972a`), so a 429 on refresh could sign the user out. Whether a 429 maps to `ok:false` depends on the caller, so the route is exempt either way. Refresh is cheap (one session lookup) and already requires a live session.
- **Cost class** from a route decorator `@ConsoleRateLimit("cheapRead" | "expensiveRead" | "write" | "jobOrPreview" | "onboarding" | "incidentControl" | "exempt")`, **defaulting by HTTP method** (GET/HEAD → `cheapRead`; other verbs → `write`). Explicit overrides pin the expensive, job, onboarding and incident routes (§D3).
- **Ratchet spec** in the style of `test/auth/route-auth-markers.enforcement.spec.ts`: sweep the real `AppModule` and **snapshot every route that serves a cookieAuth operation, with its resolved class.** A new route that is not in the snapshot fails the spec, which forces its author to classify it explicitly (the runtime still falls back to the method default, so a missed spec never leaves a route unlimited). A change to any entry is a deliberate snapshot edit in review.
- **Order spec:** pin that the limiter guard runs after `FailClosedAuthGuard` and before every controller guard.
- Tenant is not resolved at this point (`TenantContextGuard` is controller-level and runs later; a session principal carries only `userId`, `auth.guard.ts:64-69`), which is a further reason to key on the user rather than the tenant.

### D2. Keying

| Option | Verdict |
|---|---|
| **Per user** (`principal.userId`; for a `dashboard_api` bearer with no user, `tokenId`) | **Recommended.** Stable subject: a compromised account that opens N sessions cannot multiply its budget, and a re-sign-in does not reset it. The same reasoning ADR 0009 D1 used against per-token keying. |
| Per session | Rejected as the key. A successful sign-in is not throttled per account (the account bucket counts failures only and is released on success, `rate-limit.ts:6-8`, `auth.controller.ts:116-135`); only the per-IP bucket counts every attempt (30/h/IP, `:119-120`, `:124`). Someone holding credentials can therefore mint sessions from a few IPs and multiply a per-session budget. |
| Per tenant | Rejected for v1, for ADR 0009 D1's reason: one abusive subject would consume the whole tenant's budget and degrade every other operator. Also not resolvable at the guard (D1). Tenant-level visibility, if wanted, is an optional owner item (O10), not a keying change. |
| Per IP (post-auth) | Rejected. Stores sit behind shared NAT; per-IP either throttles a whole store or is so high it protects nothing (ADR 0009 D1). IP is also PII (`redaction-matrix.md:113`). |

- **Key format:** `rl:console_<class>:u:<userId>` or `…:t:<tokenId>`. The `u:`/`t:` prefix keeps a user id and a token id from ever colliding in one namespace.
- **Cardinality and lifetime:** one key per (active principal, class), at most six per principal, each with a TTL equal to its window (1 min to 1 h). Redis only holds principals active in the last hour; for a pilot-sized fleet that is hundreds of keys.
- **Include `dashboard_api` bearer principals** in the same classes. Several console routes accept the bearer as well as the cookie; limiting only the cookie would leave a trivial bypass.
- **Shared logins** (one console account used by several staff) collapse onto one budget; the starting budgets are deliberately generous and report-only will show whether it is a real pattern.

### D3. Budgets (tunable starting defaults, not frozen contract: ADR 0009 D2)

Fixed window per user per class. Short windows are chosen so a limited operator recovers in at most a minute or an hour, with a `Retry-After` an operator will actually wait out. **The class split and the numbers are an owner decision (O4).**

| Class | Applies to | Starting budget | Sizing rationale |
|---|---|---|---|
| `cheapRead` | GET by id, small lists, `context/me`, reference reads | **300 / min / user** | Admin-Console has **no polling** (no `refetchInterval`, `refetchOnWindowFocus: false`, `staleTime` 30 s; verified `f8c972a`), so reads come from navigations and manual filters. A page load fans out to several parallel reads (not yet measured, issue 3). 300/min is ~30 navigations per minute: far above a human, well below a script. |
| `expensiveRead` | `consoleListSales` (31-day range scan), `listAuditEvents`, `consoleGetSaleAuditTimeline`, `consoleListNeedsRepair`, `consoleListPostingBacklog`, `listPostingBacklog`, `listProductReconciliationBacklog`, `listReconciliationResults`, `getProductReconciliationRunResults`, `listErpnextNegativeOnHand`, `listErpnextNegativeOnHandStores`, `consoleGetSyncOpsSummary`, `consoleGetDeviceImpact`, `listStockMovements`, `listOutboxDeadLetters`, `consoleListShiftCloses`, `tenantAdminListUnknownItems` | **60 / min / user** | One request per second sustained is already faster than a person filtering and paging; a scraper hits it in seconds. |
| `write` | every other non-GET (default), including `updateMembership`, `softDelete*`, stock movements, repairs, policy publish | **30 / min / user** | Human-paced mutations. |
| `jobOrPreview` | job triggers and heavy previews: `triggerReconciliationRun`, `triggerProductReconciliationRun`, `tenantAdminBulkDismissUnknownItems`, `consolePutTenantLogo`, `consolePreviewTenantLogo`, `previewStoreTimezoneChange` | **10 / 10 min / user** | Each call is expensive or enqueues background work. |
| `onboarding` | account and fleet onboarding: `createInvitation` (sends an email), `consoleIssuePairingCode`, `createTenant`, `tenantAdminRegisterConnectorInstance`, `tenantAdminIssueConnectorCredential`, `openSupportSession` | **20 / hour / user** | A handful a day. Sized to include client retries: see M4 note below. |
| `incidentControl` | containment actions: `consoleRevokeDevice`, `consoleRetireDevice`, `tenantAdminRotateConnectorCredential`, `tenantAdminRevokeConnectorCredential`, `tenantAdminDisableConnectorInstance`, `revokeMembership`, `consoleCancelPairingCode`, `endSupportSession` | **120 / 10 min / user** (generous, separate) | An operator revoking every device of a compromised store, or rotating every credential, must never be throttled by the same budget as ordinary writes. 12/min is far above a manual response yet still bounds a runaway script. **Owner may instead choose `exempt`** (no limit at all); the recommendation is a generous separate budget so the class is still bounded and observable. |

Notes:
- The route-to-class lists are the **initial proposal**; issue 1 finalises them against the real route table and pins them in the ratchet snapshot (D1).
- **Idempotent retries spend budget (M4).** The guard runs before the idempotency interceptor, so a replay of a completed key and an in-progress (425) retry are counted like any request. Skipping them at the guard would need an extra Redis read of the in-progress marker for every request (and the marker is owned by a later stage), so the proposal is to **size for it, not skip it**: `onboarding` 20/h covers one logical invitation plus a couple of 425 retries each (the in-progress hint is 2 s, `idempotency.interceptor.ts:304-305`). Budgets count requests, not logical operations. Revisit if report-only shows 425 retries dominating a class.
- Windows differ by class (1 min, 10 min, 1 h), so `Retry-After` can reach 3600 s for `onboarding`. See D5 for the clamp.
- **Calibrate from report-only data** before any enforce flip (D6).
- Fixed windows allow up to 2× burst across a window boundary; accepted (same trade-off as every existing bucket).

### D4. Store and failure posture

- **Store: the existing Redis** (`REDIS_URL`, required in production, `auth.module.ts:103-107`). Multi-instance safe. No in-memory fallback.
- **Fail-open for every class**, an extension of ADR 0009 D3 from POS writes to console routes: the limiter is defence in depth, and a limiter outage must not become a console outage. Fail-closed for `jobOrPreview` buys nothing: the job triggers enqueue on the same Redis through BullMQ, so an outage already stops them; and the credential/device writes do not depend on Redis, so failing them closed would turn a limiter outage into a lock-out of the very controls an operator needs during an incident. **Owner decision O3** (explicitly: is ADR 0009 D3 extended to console routes?).
- **"Fail-open" must be real, so it needs a bound.** `new Redis(url)` uses ioredis defaults (offline queue + retries), so during an outage `check` *hangs* rather than throws, and a bare `try/catch` never fires (§1.3). `TakeoverRateLimit` already solves this with a 250 ms race. The new guard **must**:
  1. race `check` against a timeout (default **250 ms**, env `CONSOLE_RATE_LIMIT_TIMEOUT_MS`, 1-10000, read at boot, same convention as `CASHIER_TAKEOVER_LIMITER_TIMEOUT_MS`);
  2. on timeout or error: allow, count `outcome=fail_open`, warn-log (no identifiers);
  3. keep a small in-process **circuit breaker** (open after 5 consecutive failures, half-open probe of **one** request after 10 s) so a sustained outage does not add 250 ms to every console request.
- **ioredis offline-queue replay (L5).** A command whose 250 ms race timed out is still queued inside the client; when Redis returns, the queued `INCR`s replay and **over-count** the buckets, which in `enforce` could cause a short burst of spurious 429s right after recovery (the safe direction, but visible). Issue 1 must either give the limiter its own connection with `enableOfflineQueue: false` (the production health check already builds such a client, `docker-compose.prod.yml:161`) or document and test the recovery behaviour. Not a blocker for `report`.
- **Primitive hardening is its own issue (1a, L1/L2).** `check` seeds the TTL only when `count === 1` (`rate-limit.ts:155-157`); if the process dies, or the `PEXPIRE` fails, between `INCR` and `PEXPIRE`, the key keeps no TTL and the bucket never resets. For an IP/device key that is a nuisance; for a long-lived **per-user** key it is a **permanent lockout** once enforced. The fix is a single Lua script (or `MULTI`) that increments, seeds the TTL if absent and returns `PTTL` in **one atomic round trip**: it makes the TTL self-heal atomic and cuts the cost from 2-3 round trips to 1, which also shrinks the `report`-mode overhead (D6). It changes a shared primitive (all existing buckets benefit), so it ships on its own with its own review, before issue 1.

### D5. Response (429 envelope and `Retry-After`)

- **Status 429**, body in the canonical envelope `{ "error": { "code", "message", "request_id" } }`, **non-disclosing** message `"Too many requests."` (no budget, class or window in the body).
- **`Retry-After: <seconds>`**, an integer from `ceil(resetMs/1000)`, clamped to **[1, 3600]**. If `resetMs` is unknown (`-1`), use 1. **This is a deliberate exception to the POS clamp of [1,300]** (`pos-write-rate-limit.guard.ts:129-132`, `RetryAfter` header max 300 in `pos-sales/*.yaml`): console windows are up to one hour, and a clamp below the window would tell an operator to retry while still limited and invite retry loops. The console `RetryAfter` header is therefore its own schema (`integer`, 1-3600) in each console contract; it is not `$ref`-shared with the POS one.
- **`Cache-Control: no-store`** on the 429 (guard-thrown exceptions bypass the handler's `@Header`, so the guard sets it).
- **No `X-RateLimit-*` headers in v1**: not needed by the client, and they tell an attacker the budget. Can be added additively later.
- **`request_id` (L6).** Because `RequestIdInterceptor` runs after guards (§1.4), a guard-thrown 429 would carry a freshly minted id that appears in no log and not in `X-Request-Id`. The guard must assign `request.requestId` itself (honouring a well-formed inbound `X-Request-Id`, the same rule as the interceptor), set the `X-Request-Id` response header, and use that id in any warn log it writes.
- **Error code: OWNER DECISION O1.** The repo is split by case:
  - `RATE_LIMITED` (uppercase): `PosWriteRateLimitGuard` (`pos-write-rate-limit.guard.ts:138`), pairing (`pairing.controller.ts:148,161`), all POS contracts;
  - `rate_limited` (lowercase): the exception filter's canonical status-derived code (`exception.filter.ts:38-39`, `envelope.ts:7`), the takeover limiter, the sign-in 429.
  Console envelopes are lowercase everywhere (`validation_error`, `not_found`, `console-sales.controller.ts:68,71`). **Recommendation: `rate_limited`**, so the console surface is internally consistent and the guard needs no special code. Admin-Console must key on the **HTTP status 429**, treating the code as informational and matching it case-insensitively. If the owner prefers `RATE_LIMITED` for cross-surface uniformity with POS, it is a one-line change in the guard and the contract text; decide before issue 2 merges.

### D6. Rollout: default off, report next, enforce last

- Boot-time `CONSOLE_RATE_LIMIT_MODE`: `off` | `report` | `enforce`. **Default when unset: `off`.** Merging issue 1 therefore changes nothing in production. (Revision 1 proposed `report` as the default; rejected because `report` costs 2-3 Redis round trips (1 after issue 1a) and up to 250 ms on a Redis stall on **every** console request, so it must be switched on deliberately, staging first.)
- `report`: run the same check and classification; on a would-be refusal count `would_limit` and warn-log at most once per class per 60 s, with the **class and the route template only** (**no user, tenant or IP**, IP is PII per `redaction-matrix.md:113`); **never throw**. To explain a nonzero `would_limit` on a route, use the existing per-request log written by `LoggingInterceptor` (`common/logging.interceptor.ts:105-150`), which already records the route template, `user_id`, `tenant_id` and `request_id` for every request that proceeds (in `report` mode all of them do); filter it by that route and the warn log's time window. In `enforce` a refused request never reaches the interceptor, so it is visible only through `console_rate_limit_total{outcome="limited"}` and `http_error_4xx_total`.
- `enforce`: throw 429. Both `report` and `enforce` are explicit configuration changes (`deploy/prod.env.example` + compose passthrough = production configuration), owned by issue 4.
- **Telemetry (new, required; this is what makes the exit criteria measurable).** Bounded labels only; **no user, tenant or IP label**.
  - Counter `console_rate_limit_total{class, outcome, route}`:
    - `class`: the six classes plus `exempt` (closed set);
    - `outcome` (mutually exclusive): `allowed` (utilisation under 50%), `near_limit` (allowed, utilisation 50% or more), `would_limit` (over budget, report mode), `limited` (over budget, enforce mode), `fail_open`;
    - `route`: the route template, the same bounded label `http_error_4xx_total` already uses (`api.metrics.ts:325-328`), about 110 values.
  - Histogram `console_rate_limit_utilisation{class, route}`: `count / limit` of the principal's bucket at each check, buckets `0.1, 0.25, 0.5, 0.75, 0.9, 1, 2`; `route` is the same bounded template label as the counter (about 110 values, so roughly 1,000 histogram series). It shows how close real traffic runs to each budget, per route, without identifying anyone.
  - A **per-tenant aggregate** is deliberately **not** proposed: tenant is not resolvable at the guard (D1), so it would need a second hook after `TenantContextGuard`. Tenant-level visibility is an optional owner item (O10).
- **Exit criteria for the enforce flip** (all required; measured only with the telemetry above, not per-user percentiles, which the label set cannot express):
  1. issue 2 (contract) and issue 3 (Admin-Console handling) merged;
  2. at least 14 days (or the owner's chosen pilot window) of `report` data on production traffic;
  3. for every class and route: `would_limit` is zero over the window, or each nonzero route is explained from logs or audit events (a script, a bug, or a budget raised); the metric carries no user label, so "ordinary vs scripted" is judged by that explanation, not by the counter;
  4. for every route: `near_limit` is under 1% of that route's requests and that route's utilisation histogram 99.9th percentile is under 1.0 (i.e. no request is at the limit); any route above that is reclassified or its budget raised first;
  5. no unexplained `fail_open` burst, and the `report` latency overhead (added p99 of console requests) is recorded and accepted;
  6. owner sign-off.

### D7. Contract impact (additive, GATED)

- Add to **every cookieAuth operation except the shared exemption list**, i.e. **103 operations in 25 files** (106 minus `signOut`, `requestEmailVerification`, `refreshSession`; Appendix A): `429` → `$ref: "#/components/responses/TooManyRequests"` with a `Retry-After` header (`integer`, `minimum: 1`, `maximum: 3600`, **its own schema, see D5**) and the file's existing `Error` schema. Follow the per-file convention (e.g. `pos-sales/sale-history.yaml:394-400, 954-966`).
- Remove the contradicting sentence at `console-sales.openapi.yaml:162-163` and any equivalent in other files.
- Wording per operation: *"429 `rate_limited`: the caller's per-user budget for this class of operation is spent; honour `Retry-After`; never auto-retry a mutation."* No numbers in the contract (they are tunable, D3).
- **Additive.** Adding a non-2xx response is not a breaking change; the issue's acceptance criterion is `oasdiff` green **with no breaking-ignore lines** and `contract-conformance.spec.ts` green.
- **Ordering.** The contract may merge while the runtime is still `off` or `report`: the wording is "may return 429". It merges **before** the enforce flip.
- **Exemptions and the sweep.** The contract sweep in issue 2 imports the same exemption list as the runtime ratchet (D1), so it requires a 429 on every cookieAuth operation **except** the exempt ones and never forces a false 429 into `signOut`, `requestEmailVerification` or `refreshSession`.
- `[GATED]` per `standing-rules.md` §3 (`packages/contracts/openapi/**`) and the Jira scope; `x-runtime-status` unaffected. Execution needs explicit owner authorisation (O7).

### D8. How Admin-Console should react (spec for issue 3; verified against Admin-Console `origin/main` `f8c972a`)

**What the client does today** (verified):
- `src/lib/query.ts`: queries `retry: 1`, mutations `retry: false`, `refetchOnWindowFocus: false`, `staleTime` 30 s; **no `refetchInterval` anywhere in `src`** (git grep). There is no background polling to pause.
- `src/lib/client.ts`: the wrappers return `{ status, data, error }` and **do not throw** on non-2xx. Only `signIn` parses `Retry-After`.
- `src/lib/auth-interceptor.ts`: only a **401** triggers `refreshSession`; a refresh that returns `ok:false` calls `onSessionLost` (clear cache and redirect to sign-in).

**So the real questions for issue 3 are:**
1. Do the `queryFn`s (and mutation functions) throw on a 429 or return `{status: 429}` as data? If they return it, TanStack never retries it and the UI must branch on `status`; if they throw, `retry: 1` fires after its default 1 s backoff, ignoring `Retry-After`. Audit every `queryFn`/mutation that uses the wrappers and make 429 handling uniform at the `client.ts` boundary.
2. Add a shared 429 classification (status 429, `retryAfterSeconds` parsed as `signIn` already does: integer seconds, 30 s fallback, clamped [1, 3600]).

**Behaviour:**
- **429 is not 401.** It must never trigger sign-out, re-authentication, `onSessionLost`, or the session-expired flow. (This is also why `refreshSession` is exempt server-side, D1.)
- **Mutations: never retried automatically.** Preserve form state; show the failure with a "Try again in Ns" affordance.
- **Reads: no automatic retry on 429**, or at most the existing single retry delayed by `Retry-After` (+ 0-1 s jitter) through `retryDelay`, for a user-initiated read only. Never the default 1 s backoff.
- **Repeat-submit gate:** while a `Retry-After` is running, the control that caused the 429 (submit, filter apply, export) is disabled with a countdown, so a user cannot hammer it. (There is no background polling or prefetch to pause today; if any is added later it must honour the same gate.)
- UX: a non-blocking, dismissible banner ("Too many requests, you can retry in Ns") with a manual retry; no raw error strings; accessible live region.
- Match `error.code` case-insensitively; behaviour keys on status 429.

---

## 3. Residual risks and out of scope

| ID | Risk / boundary | Treatment |
|---|---|---|
| R1 | **Pre-auth gap.** A garbage or forged cookie (and any unauthenticated request to a guarded route) costs a session lookup at `auth.guard.ts:125` before any post-auth limiter sees it. | Not solved by this proposal. Candidate follow-up: a high, NAT-safe per-IP pre-auth ceiling (report-only first), or a Caddy-level limit (needs a plugin build: a new dependency, owner approval). **Owner decision O5.** |
| R2 | Redis outage disables the limiter (fail-open). | Visible via `outcome=fail_open`; alert on it. Same accepted trade-off as ADR 0009 D3. |
| R3 | Shared console logins share a budget. | Generous starting budgets; report-only will show it. |
| R4 | Fixed-window 2× burst at the boundary. | Accepted. |
| R5 | `AlwaysAllowRedis` in non-prod: limits never trigger without `REDIS_URL`. | Enforcement tests need real Redis (Docker-gated integration). Unit tests use fakes. |
| R6 | **Pre-existing sign-in gaps** (no `Retry-After`, lockout-DoS, no `email/verify/confirm` limit, unset `TRUST_PROXY`, Redis-outage hang/500). | Separate drafted issues 5a-5e, independent of the console decision. Fail posture is **owner decision O6**. |
| Out of scope | POS and device routes (ADR 0009), connector routes (`/api/connector/v1/*`), public auth routes (except issues 5a-5e), and non-`dashboard_api` bearer scopes. | Unchanged. |

---

## 4. Verification performed for this record

- Repository state: `git fetch origin`; branch clean at the time of writing; `HEAD` = `origin/main` = `d9723aa7` for Backend-Core.
- All Backend-Core `file:line` references were read at that SHA. Admin-Console facts (D8) were read from `origin/main` `f8c972a` (`src/lib/query.ts`, `client.ts`, `auth-interceptor.ts`, `git grep` for `refetchInterval`).
- The cookieAuth/429 counts come from parsing every YAML under `packages/contracts/openapi` (script run locally; not committed): 151 operations, 106 `cookieAuth` in 25 files, 0 documenting a 429.
- **Not verified (stated as assumptions):** production API instance count; the ioredis hang-on-outage and offline-queue replay behaviours are inferred from the default client options (`auth.module.ts:114`) and the existing takeover limiter's own documentation (`takeover-rate-limit.ts:8-15`), not reproduced; Admin-Console page-load fan-out (issue 3 measures it); whether Admin-Console's `refreshed.ok` is false on a 429 (depends on the caller; the route is exempt regardless).
- No production code, contract, migration, dependency or CI file was modified.

---

## 5. Draft implementation issues (text only; **not created in Jira**)

Dependency order: **1a** → **1** → (**2** ∥ **3**) → **4**. Issues **5a-5e** are independent.

### Issue 1a: Backend-Core — harden `RateLimiter` into one atomic round trip with TTL self-heal (shared primitive)

- **Repo:** Backend-Core. **Work Mode:** Implementation. **GATED:** none (no dependency, migration, contract or CI change; `ioredis` already present, `eval`/script is part of it).
- **Scope:** make `check` one atomic operation (a Lua script or `MULTI`: `INCR`, `PEXPIRE … NX` when no TTL, return count and `PTTL`) and self-heal a TTL-less key (re-seed the TTL when `PTTL` is `-1`). Extend the `RedisLike` port, `IoredisIdempotencyAdapter`, `AlwaysAllowRedis` and the test fakes accordingly. No behaviour change for any existing bucket.
- **Out of scope:** any new bucket, guard or route; sign-in policy.
- **Acceptance criteria:**
  1. `check` is one Redis round trip and returns the same `{allowed, count, remaining, resetMs}` for every existing bucket.
  2. A key that exists without a TTL is given one on the next `check` (no permanent lock).
  3. `release` semantics are unchanged (RT-136 sign-in behaviour intact).
  4. All existing consumers (sign-in, pairing, email-verify, POS write guard, takeover, rotation) are untouched and their tests pass.
  5. db-integration CI green.
- **Tests:** unit with a fake client (single call, TTL seeded once, TTL-less repair, count/limit boundary, `resetMs`); real-Redis integration (Docker-gated): window rollover, concurrent increments, kill-between-commands equivalent; all existing `test/auth/rate-limit*.spec.ts` and `pos-write-rate-limit.guard.unit.spec.ts` stay green unchanged.

### Issue 1: Backend-Core — console rate limiting runtime: global guard, cost classes, modes, telemetry (RT-574 follow-up)

- **Repo:** Backend-Core. **Work Mode:** Implementation. **Depends on:** RT-574 decision approved (O1, O3, O4) and issue 1a merged. **GATED surfaces:** none. Documenting the new env vars in `deploy/prod.env.example` is optional and value-neutral; changing a prod value is issue 4.
- **Behaviour on merge:** **none.** The default mode is `off`; this issue is not a no-op only in that it adds code and tests.
- **Scope:**
  - `ConsoleRateLimitGuard` + `@ConsoleRateLimit(...)` decorator + the six-class table + the shared exemption list module (also consumed by issue 2's sweep), registered as an `APP_GUARD` adjacent to and after `FailClosedAuthGuard` in the same providers array.
  - Skip rules, exemptions (`signOut`, `requestEmailVerification`, `refreshSession`), default-by-method and the explicit overrides of D3, finalised against the real route table.
  - Keying per D2 (`rl:console_<class>:u:<userId>` / `:t:<tokenId>`; skip `pos`/`pos_operator`/`connector` scopes and requests with no principal).
  - Modes `off`/`report`/`enforce` (default `off`), boot-time env; 429 shape per D5 (code per O1; `Retry-After` [1,3600]; `Cache-Control: no-store`; guard-assigned `request_id` and `X-Request-Id`).
  - 250 ms timeout + circuit breaker (half-open one-request probe), fail-open (D4); decide the dedicated limiter connection with `enableOfflineQueue: false` vs documented recovery behaviour (L5).
  - Telemetry per D6: `console_rate_limit_total{class,outcome,route}` and `console_rate_limit_utilisation{class,route}`, bounded labels, registered through the existing label-assertion helper.
- **Out of scope:** POS/device/connector routes; contract text (issue 2); Admin-Console (issue 3); sign-in/email-verify behaviour (issues 5a-5e); a per-IP pre-auth limiter; enabling `report`/`enforce` in any environment (issue 4).
- **Acceptance criteria:**
  1. With the default (`off`) the guard performs no Redis call and changes no response.
  2. In `report` mode no request is ever refused by the guard; would-be refusals increment `would_limit`; warn logs contain no user, tenant or IP.
  3. In `enforce` mode the (limit+1)-th request in a window to a class returns 429 with the canonical envelope, `Retry-After` in [1,3600], `Cache-Control: no-store`, and a `request_id` equal to the `X-Request-Id` response header; the next window succeeds.
  4. Keying is per user: two sessions of one user share a budget; two users do not; a `dashboard_api` bearer without a user keys on `tokenId`; a user id and a token id with the same string never share a key.
  5. **The ratchet snapshot lists every route serving a cookieAuth operation with its resolved class; a route absent from the snapshot fails the spec; a changed entry is a deliberate snapshot edit.**
  6. POS, device, connector and unauthenticated requests are not touched; the three exempt operations are exempt (and appear in the shared exemption list used by issue 2).
  7. Redis down or hanging: the request is allowed within the timeout; `fail_open` is counted; after 5 consecutive failures the breaker skips checks and probes with one request after 10 s; no request is delayed by more than the timeout.
  8. A guard-thrown 429 neither claims nor stores an idempotency key (retrying with the same key after the window succeeds).
  9. The guard is registered immediately after `FailClosedAuthGuard` in the same providers array (order spec).
  10. The metric label sets are bounded and contain no user, tenant or IP value.
  11. No new dependency; no change to `package.json`, lockfile, migrations, `.github/**` or `packages/contracts/openapi/**`.
  12. **db-integration CI is green** (every harness that boots `AppModule` still boots; the guard's dependencies resolve there and in standalone harnesses: see the soft-skip hazard in project memory).
- **Tests:**
  - Unit (fakes, Docker-free): classification and default-by-method; keying matrix; skip/exempt rules; over-limit 429 headers/body/request id; `off` makes no call; `report` never throws; `enforce` throws; fail-open on throw and on timeout; breaker open/half-open/close; utilisation and `near_limit` outcome boundaries; metric labels bounded.
  - Ratchet snapshot spec over the real `AppModule` (pattern: `test/auth/route-auth-markers.enforcement.spec.ts`) and a guard-order spec.
  - HTTP integration with real Redis (Docker-gated): boundary 429, window rollover, idempotency non-claim, Redis stop → fail-open within the timeout, recovery without a spurious burst of 429s.
  - Existing rate-limit and POS guard specs stay green.

### Issue 2: Backend-Core — console contract wording: documented 429 on cookieAuth operations (GATED, contract-first)

- **Repo:** Backend-Core. **Work Mode:** Implementation (contract). **GATED:** `packages/contracts/openapi/**`; needs explicit owner authorisation (O7). **Depends on:** RT-574 decision (O1). Can merge before the runtime enforces.
- **Scope:** per D7: add `429` + `TooManyRequests` response + a console `Retry-After` header (`integer`, 1-3600, own schema) to the **103** cookieAuth operations that are not on the shared exemption list, in 25 files (Appendix A); delete the "no 429" sentence at `console-sales.openapi.yaml:162-163` and any equivalent; update affected `info.description` status mappings and changelog entries.
- **Out of scope:** runtime change; POS/device contracts; the public auth contract (issue 5a); new error codes beyond the one chosen in O1; request-body changes.
- **Acceptance criteria:**
  1. Every cookieAuth operation **not on the shared exemption list** documents a 429 with the `Retry-After` header and the file's `Error` schema; `signOut`, `requestEmailVerification` and `refreshSession` do **not** gain a 429; no operation outside the cookieAuth set gains one.
  2. `oasdiff` breaking-change gate green **with no breaking-ignore lines** added.
  3. `contract-conformance.spec.ts` green; OpenAPI lint green; no `x-runtime-status` change.
  4. No contract text states a numeric budget.
- **Tests:** a contract test (sweep of all contract files) that imports **the same exemption list as the runtime ratchet** and asserts every `cookieAuth` operation outside it has a `429` response with `Retry-After`, and every exempt one has none, so a future cookieAuth operation without a 429 fails CI and the sweep can never force a false 429; oasdiff run attached as evidence.

### Issue 3: Admin-Console — handle 429 from Backend-Core (verified-facts scope)

- **Repo:** `Kemetra/Admin-Console`. **Work Mode:** Implementation. **Depends on:** issue 2 merged (contract-first); not on the runtime enforcing.
- **Verified starting point** (`f8c972a`): queries `retry: 1`, mutations `retry: false`; no `refetchInterval`; `refetchOnWindowFocus: false`; the `client.ts` wrappers return `{status}` and do not throw; only `signIn` parses `Retry-After`; only a 401 triggers refresh, and an `ok:false` refresh signs the user out.
- **Scope:** (a) **audit every `queryFn` and mutation function** for whether a 429 is thrown or returned as data, and report the result on the RT-574 thread (this also records page-load fan-out and validates the `cheapRead` budget); (b) a shared 429 classification at the `client.ts` boundary (status, `retryAfterSeconds`, 30 s fallback, clamp [1,3600]); (c) retry policy: never auto-retry a mutation; for reads, no retry on 429 or one retry delayed by `Retry-After` + jitter via `retryDelay`, never the default 1 s backoff; (d) repeat-submit gate with a countdown on the control that caused the 429; (e) non-blocking banner with a live region; (f) guarantee a 429 never reaches `onSessionLost` or the sign-in redirect.
- **Out of scope:** any Backend-Core change; 401/403 handling; per-route custom UX beyond the shared banner; polling (none exists).
- **Acceptance criteria:**
  1. A 429 never signs the user out or routes to sign-in, including a 429 returned by a call that goes through the 401 interceptor.
  2. A mutation that gets a 429 is not retried automatically and the form input is preserved.
  3. A user-initiated read is retried at most once, after `Retry-After` (+jitter); there is no 1 s default-backoff retry on a 429.
  4. A missing/invalid `Retry-After` falls back to 30 s; values are clamped to [1,3600].
  5. The control that caused a 429 is disabled with a visible countdown until `Retry-After` elapses; the banner is dismissible and announced to assistive tech.
  6. `error.code` is matched case-insensitively; behaviour keys on status 429.
  7. Every `queryFn`/mutation that uses the wrappers is covered by the shared 429 handling (the audit list is attached).
- **Tests:** unit tests for the `Retry-After` parser and the retry policy; component/integration tests with a mocked 429 asserting exact request counts (no storm), no sign-out, mutation not retried, control disabled then re-enabled after the countdown; an accessibility check on the banner.

### Issue 4: Backend-Core — enable console rate limiting: report mode, then enforce (OWNER DECISION, production config)

- **Repo:** Backend-Core (+ deploy config). **Work Mode:** Implementation. **GATED:** production configuration (CLAUDE.md §10); explicit owner approval at each phase. **Depends on:** issue 1 (and 1a) merged for phase A; issues 2 and 3 merged **and** the D6 exit criteria met for phase B.
- **Phase A, enable `report`:** set `CONSOLE_RATE_LIMIT_MODE=report` through the deploy path (staging first, then production; `deploy/prod.env.example` + the compose passthrough). Record the baseline console p99 latency before and after.
- **Phase B, flip to `enforce`:** after the exit criteria; adjust any class budget the report data shows is wrong; record the calibration evidence and a one-step rollback (`report`; no code deploy).
- **Out of scope:** new classes, new keying, contract changes.
- **Acceptance criteria:**
  1. Phase A: before/after console latency recorded and accepted by the owner; `console_rate_limit_total` and the utilisation histogram receive data in production.
  2. Phase B evidence attached before the flip shows **D6 exit criteria 3 and 4 met, repeated here word for word (both per route)**, plus the report window and the `fail_open` count:
     - criterion 3: for every class and route: `would_limit` is zero over the window, or each nonzero route is explained from logs or audit events (a script, a bug, or a budget raised); the metric carries no user label, so "ordinary vs scripted" is judged by that explanation, not by the counter;
     - criterion 4: for every route: `near_limit` is under 1% of that route's requests and that route's utilisation histogram 99.9th percentile is under 1.0 (i.e. no request is at the limit); any route above that is reclassified or its budget raised first;
  3. **Staging provocation test (scripted, repeatable):** with a dedicated test user and `enforce` on staging, send `budget+1` requests to one named route of each class (the script lists them); assert the (budget+1)-th returns 429 with `Retry-After` in range and `Cache-Control: no-store`; assert `console_rate_limit_total{outcome="limited"}` increases by exactly the number of refused requests, labelled with only the expected class and route; assert the Admin-Console banner appears (not an error page, not a sign-out) via a recorded browser run.
  4. The one-step rollback (`report`) is exercised on staging and confirmed to stop all refusals.
  5. The owner records approval on the issue for each phase.
- **Tests / evidence:** the staging script and its output, a metric snapshot before and after each phase, screenshots/logs of the banner and the 429 headers.

### Issue 5: sign-in and public-auth rate-limit hardening: five independent bounded issues (5a-5e)

None depends on the console limiter (issues 1-4). Each is its own issue with its own review; 5d benefits from issue 1a. Common context: R6; `auth.controller.ts`, `main.ts`, `auth.openapi.yaml`. Common acceptance: no new dependency; sign-in for a correct password from an unlocked client is unchanged; db-integration CI green.

#### Issue 5a: Backend-Core — `Retry-After` on public-auth 429s and the contract wording (GATED)

- **Repo:** Backend-Core. **Work Mode:** Implementation (contract). **GATED:** `packages/contracts/openapi/**` (`auth.openapi.yaml`); owner authorisation required.
- **Scope:** `RATE_LIMIT_429` (`auth.controller.ts:88-91`) sends no `Retry-After`; the Admin-Console `signIn` wrapper already parses it. Send `Retry-After` (integer seconds from the bucket's reset, clamped [1,3600]) on every public-auth 429. Document the header on `signIn` (`auth.openapi.yaml:49-54`) and document the 429 that `requestPasswordReset` (`:102-120`) can already return.
- **Out of scope:** new buckets, thresholds, or fail posture.
- **Acceptance criteria:** every public-auth 429 carries `Retry-After` in [1,3600]; the contract documents the header on `signIn` and a 429 on `requestPasswordReset`; `oasdiff` green with no breaking-ignore lines; `contract-conformance.spec.ts` green.
- **Tests:** unit and integration asserting header presence and range per bucket; the contract sweep.

#### Issue 5b: Backend-Core — `TRUST_PROXY` boot check

- **Repo:** Backend-Core. **Work Mode:** Implementation. **GATED:** production boot behaviour if fail-fast is chosen (owner).
- **Scope:** `TRUST_PROXY` unset means `false` (`main.ts:53`), which behind Caddy collapses every client onto one IP bucket (the 30/h sign-in IP budget becomes global, an easy sign-in denial of service). Warn at boot when `NODE_ENV=production` (or a deployed `DEPLOYMENT_ENVIRONMENT`) and `TRUST_PROXY` is unset; fail-fast as an owner option. An explicit `TRUST_PROXY=false` stays valid for a direct deployment.
- **Acceptance criteria:** unset in a deployed environment produces the warning (or refusal, per the owner's choice); an explicit value does not; no other boot behaviour changes.
- **Tests:** a boot-check unit test for each combination (unset / `false` / `1` / `true`, production vs non-production).

#### Issue 5c: Backend-Core — sign-in lockout redesign (OWNER numbers, O9)

- **Repo:** Backend-Core. **Work Mode:** Implementation after owner approval; needs security review.
- **Scope:** five failed guesses against an email lock out the correct password for 15 minutes (`signInPerAccount`, keyed by email). Proposal: key the 5/15 min failure bucket on the (email, IP) pair and keep a higher per-email-only cap (for example 20/15 min) so a lone attacker IP cannot lock the owner out from their usual IP while distributed guessing is still capped. **The numbers are owner decision O9.**
- **Acceptance criteria:** a single attacker IP cannot lock out the owner signing in from another IP; distributed guessing is still capped by the per-email-only bucket; the RT-136 release-on-success behaviour and the non-disclosure of account existence are preserved.
- **Tests:** real-Redis integration of the (email, IP) and email-only interplay, boundary and rollover; a regression test for the non-disclosing responses.

#### Issue 5d: Backend-Core — new public-auth buckets and a failed-sign-in alert

- **Repo:** Backend-Core. **Work Mode:** Implementation. **Depends on:** none (benefits from issue 1a).
- **Scope:** (1) a per-email limit on `password-reset/request` (for example 5/h per email, still always 202) so one inbox cannot be flooded within the per-IP budget (`auth.controller.ts:207`); (2) a limit on `email/verify/confirm` (public and unlimited today; for example 20/15 min/IP); (3) a global failed-sign-in **alert** (metric + alert only, **not enforced**: an enforced global cap would itself be a lockout DoS).
- **Acceptance criteria:** over-limit password-reset requests still answer 202 and send nothing; the confirm route returns 429 over its budget; the failed-sign-in counter is bounded-label and fires the alert condition in a test.
- **Tests:** boundary and rollover per bucket; 202 preserved; metric labels bounded.

#### Issue 5e: Backend-Core — public-auth limiter posture on a Redis outage (OWNER, O6)

- **Repo:** Backend-Core. **Work Mode:** Implementation after owner decision.
- **Scope:** today `guardRateLimit` awaits `check` with no catch and no timeout (`auth.controller.ts:295`): an outage hangs or 500s sign-in. Options: (a) keep fail-closed but deliberate: a bounded timeout, then 503 with `Retry-After` (recommended: sign-in is where brute-force protection matters, and signed-in console sessions keep working because the console limiter fails open); (b) fail-open with a timeout, which lets guessing proceed unthrottled during an outage.
- **Acceptance criteria:** with Redis stopped, sign-in and the other public-auth routes answer within the timeout with the chosen posture (503 + `Retry-After` for (a)); no hang; the posture is documented.
- **Tests:** a Redis-stop integration test asserting the status, headers and latency bound.

---

## 6. Appendix A. cookieAuth operations by contract (from the parse; none documents a 429)

25 files, 106 operations. **Exempt (no 429 is added): `signOut`, `requestEmailVerification`, `refreshSession`** (all in `auth.openapi.yaml`), leaving 103.

| Contract | Ops | Operations |
|---|---:|---|
| `audit.openapi.yaml` | 1 | `listAuditEvents` |
| `auth.openapi.yaml` | 3 | `signOut`, `refreshSession`, `requestEmailVerification` (all exempt) |
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

The per-operation route table (operation id, route template, class) is produced by issue 1's ratchet snapshot, which is the authoritative source.

---

## 7. Owner decisions

Each with the recommendation. Nothing in this record is ratified until the owner answers.

| # | Decision | Recommendation |
|---|---|---|
| **O1** | Console 429 error-code case: `rate_limited` vs `RATE_LIMITED`. | **`rate_limited`** (console envelopes and the filter are lowercase; Admin-Console keys on status 429 and matches the code case-insensitively). Decide before issue 2 merges. |
| **O2 / O4** | The cost-class model and starting budgets (D3), **including the split of the old heavy class into `jobOrPreview` 10/10 min, `onboarding` 20/h and `incidentControl`**; and whether `incidentControl` is a generous separate budget (120/10 min) or fully `exempt`. | Approve the six classes as *starting defaults*; make `incidentControl` a generous separate budget (still bounded and observable); calibrate every number in `report`. |
| **O3** | Extend ADR 0009 D3 (fail-open with an alert) to **every console class**. | **Yes.** Fail-closed gains nothing for job triggers (same Redis) and would lock operators out of containment controls during an incident. Bounded by a 250 ms timeout and a breaker. |
| **O3b** | Default mode when `CONSOLE_RATE_LIMIT_MODE` is unset. | **`off`**; `report` is switched on explicitly (staging first). `report` adds Redis round trips and up to 250 ms on a Redis stall to every console request. |
| **O5** | The pre-auth cookie-flood gap (R1): accept for now, or open a follow-up? Any Caddy rate-limit plugin (a non-stock build, i.e. a new dependency) needs your approval. | Accept for now; open a separate report-only per-IP follow-up after issue 1 lands; do not add a Caddy plugin in this cycle. |
| **O6** | Sign-in / public-auth fail posture on a Redis outage (issue 5e). | Deliberate fail-closed with a bounded timeout and a 503 + `Retry-After` (not a hang or an unexplained 500); already-signed-in console sessions keep working. |
| **O7** | GATED execution of issue 2 (`packages/contracts/openapi/**`, 103 operations in 25 files). | Authorise it as one additive PR once O1 is decided; it may merge before enforcement. |
| **O8** | The enforce flip (issue 4, phase B) and enabling `report` in production (phase A), both production configuration. | Phase A after issues 1a and 1; phase B only after issues 2 and 3 are merged and the D6 exit criteria are met, with your sign-off on the calibration evidence. |
| **O9** | The sign-in lockout redesign numbers (issue 5c): per-(email, IP) failure bucket 5/15 min plus a per-email-only cap of 20/15 min. | Approve the (email, IP) keying and the higher email-only cap as a starting point; security-review before shipping. |
| **O10** | Tenant-level visibility of console rate-limit usage (optional). Today the telemetry is per class and route only, with no tenant label; a tenant aggregate would need a second hook after `TenantContextGuard`. | Not needed for the enforce criteria; add only if you want per-tenant usage reporting. |
