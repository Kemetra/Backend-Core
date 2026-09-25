# Adversarial Security Review Report — Data-Pulse-2

**Date:** 2026-06-19
**Scope:** Full codebase (`apps/api`, `apps/worker`, `packages/*`, infrastructure configs)
**Methodology:** Manual source-code audit targeting OWASP Top 10, multi-tenant isolation flaws, logic errors, and deployment hardening gaps.

---

## Executive Summary

Data-Pulse-2 demonstrates a **mature security posture** for a backend SaaS platform at this stage of development. The codebase shows disciplined adherence to its Constitution principles: fail-closed RLS, constant-time auth comparisons, comprehensive log redaction, parameterized queries, and scope-gated guards. No **critical** remotely-exploitable vulnerabilities were found.

That said, several **medium** and **low** severity findings represent hardening opportunities and edge-case risks that an adversary could leverage, especially in production deployments. The findings below are ordered by severity.

---

## Findings

### FINDING-01: Missing `trust proxy` Configuration (Medium)

**Location:** `apps/api/src/main.ts`, `apps/api/src/auth/auth.controller.ts:272-277`
**Risk:** IP-based rate limiting bypass; inaccurate audit trail attribution.

**Description:**
The API is deployed behind Caddy (reverse proxy), but Express's `trust proxy` setting is never configured:

```ts
// auth.controller.ts:272
function readClientIp(req: AuthedRequest): string {
  const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
  return String(ip);
}
```

Without `app.set('trust proxy', ...)`, `req.ip` always returns the proxy's (Caddy's) internal IP, not the real client IP. This means:
- **All clients share one rate-limit bucket** (`signin_ip`, `signin_account`), causing legitimate users to be locked out by a single attacker.
- Conversely, an attacker behind a different proxy chain can bypass rate limits entirely.
- Audit events record the proxy IP, not the real client, degrading forensic value.

**Remediation:**
In `apps/api/src/main.ts`, after `NestFactory.create`:
```ts
const expressApp = app.getHttpAdapter().getInstance();
expressApp.set('trust proxy', 1); // or 'loopback' if Caddy is on localhost
```
Configure the exact hop count or trusted CIDR to match the deployment topology. Do not use `true` (trusts any `X-Forwarded-For`).

---

### FINDING-02: No CORS Policy Configured (Medium)

**Location:** `apps/api/src/main.ts`
**Risk:** Cross-origin credential theft; CSRF-adjacent attacks on cookie-based sessions.

**Description:**
The API uses `httpOnly` + `SameSite=Lax` session cookies, but no CORS policy is configured via `app.enableCors(...)`. In the absence of explicit CORS headers, browsers apply default same-origin policy, which blocks cross-origin XHR/fetch. However:

- Once a dashboard frontend is deployed on a different origin, CORS must be explicitly whitelisted. If it is opened with `origin: '*'` (a common mistake) while using cookie auth, the browser will refuse to send credentials.
- More critically, if a future developer adds `app.enableCors({ origin: true, credentials: true })` to "make it work", **any origin** can exfiltrate the session cookie via `fetch(..., { credentials: 'include' })`.

**Remediation:**
Add explicit CORS now with a strict allowlist derived from an environment variable:
```ts
app.enableCors({
  origin: (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
});
```

---

### FINDING-03: `AlwaysAllowRedis` Stub Silently Disables Rate Limiting (Medium)

**Location:** `apps/api/src/auth/auth.module.ts:85-93`, `apps/api/src/auth/auth.module.ts:163-182`
**Risk:** Brute-force credential stuffing if `REDIS_URL` is misconfigured or unset in a near-production environment.

**Description:**
When `REDIS_URL` is not set, the `redisClientFactory` returns `AlwaysAllowRedis`, which:
- `incr()` always returns `1` (below every limit).
- Rate limits **never trigger**.
- Idempotency storage is disabled (every request is "fresh").

While this is documented and intentional for dev/CI, there is **no production-environment guard** on this factory (unlike `emailJobEnqueuerFactory` which throws in production without Redis). If `REDIS_URL` is accidentally unset in a production deployment:
- Sign-in brute-force is unlimited.
- Password-reset endpoint becomes an email flood vector (no IP rate limit).
- Idempotency guarantees are silently dropped.

**Remediation:**
Mirror the production fail-fast pattern from `emailJobEnqueuerFactory`:
```ts
export function redisClientFactory(): RedisLike {
  const url = process.env["REDIS_URL"];
  if (!url) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error("REDIS_URL is required in production (rate limiting + idempotency disabled without it).");
    }
    return new AlwaysAllowRedis();
  }
  // ...existing ioredis wiring...
}
```

---

### FINDING-04: Redis Deployed Without Authentication (Medium)

**Location:** `docker-compose.dev.yml:28-41`, `docker-compose.prod.yml:16-28`
**Risk:** Unauthorized access to rate-limit state, session data, idempotency keys, and BullMQ job queues.

**Description:**
Both the development and **production** Redis containers use the bare `redis:7-alpine` image with `--appendonly yes` and **no `requirepass`** or ACL configuration. The production compose template connects via `redis://redis:6379` (no auth).

While Redis is on an internal Docker bridge network (`dp2`), this provides minimal protection:
- Any container on the same bridge network can read/write Redis.
- A compromised API or worker container grants full Redis access.
- If an attacker achieves RCE in any container on the `dp2` network, they can flush rate-limit keys (enabling brute-force), read BullMQ job payloads, or inject fake jobs.

**Remediation:**
1. Add `--requirepass $(REDIS_PASSWORD)` to the Redis `command` in `docker-compose.prod.yml`.
2. Pass `REDIS_URL=redis://:$(REDIS_PASSWORD)@redis:6379` to `api` and `worker`.
3. For defense-in-depth, use Redis 7 ACL to restrict the app user to only the commands needed (GET, SET, DEL, INCR, PEXPIRE, etc.) and deny `CONFIG`, `DEBUG`, `FLUSHALL`.

---

### FINDING-05: Session Cookie `Secure` Flag Gated on `NODE_ENV` String Check (Low)

**Location:** `apps/api/src/auth/auth.controller.ts:280-292`
**Risk:** Session hijacking via MITM in staging/QA environments or misconfigured production.

**Description:**
```ts
res.cookie(SESSION_COOKIE_NAME, sessionId, {
  httpOnly: true,
  secure: process.env["NODE_ENV"] === "production",
  sameSite: "lax",
  expires,
  path: "/",
});
```

The `Secure` flag is only set when `NODE_ENV === "production"`. A staging environment with `NODE_ENV=staging` (a common practice) will transmit session cookies over plain HTTP, enabling MITM interception.

**Remediation:**
Default to `secure: true` and only disable for explicitly non-TLS environments:
```ts
secure: process.env["NODE_ENV"] !== "test" && process.env["NODE_ENV"] !== "development",
```
Or use an explicit `COOKIE_SECURE=true` env var.

---

### FINDING-06: Password Reset Token Not Rate-Limited at Confirm Endpoint (Low)

**Location:** `apps/api/src/auth/auth.controller.ts:193-203`
**Risk:** Offline brute-force of password-reset tokens.

**Description:**
The `/password-reset/request` endpoint is rate-limited (100/day per IP). However, the `/password-reset/confirm` endpoint has **no rate limit**. A reset token is 32 bytes of randomness encoded as base64url (43 chars), so brute-forcing the token value is computationally infeasible. However:

- If a future change shortens the token or changes the format, this becomes exploitable.
- The 15-minute TTL is the only defense; there's no lockout on repeated invalid confirm attempts.
- An attacker can probe confirm attempts without any throttle, potentially discovering timing differences.

**Remediation:**
Add a per-IP rate limit on `/password-reset/confirm` (e.g., 10 attempts/15 min) using the existing `guardRateLimit` mechanism.

---

### FINDING-07: `users` Table Not RLS-Protected (Low)

**Location:** `packages/db/drizzle/0000_initial.sql`
**Risk:** Cross-tenant user enumeration if a query ever runs against `users` in a tenant-scoped context without explicit filtering.

**Description:**
The `users` table has **no RLS policy** and no `ENABLE ROW LEVEL SECURITY`. This is intentional per the data model (users are platform-scoped, not tenant-scoped), and the `sessions` table is similarly unprotected for the same reason.

However, this means any query that joins or selects from `users` inside a tenant-scoped `runWithTenantContext` session sees **all users across all tenants**. The current code is careful about this (user lookups are done on the admin pool or are filtered explicitly by email/id), but this is a defense-in-depth gap:

- A future developer adding a query like `SELECT * FROM users WHERE id = $1` inside a tenant context could inadvertently expose cross-tenant user data.
- The `findActiveUserByEmail` method in `AuthService` runs against the admin pool (Drizzle on the constructor's `pool`), which is correct but could be confused with the tenant-scoped pool in a refactor.

**Remediation:**
Document this as an explicit architectural decision (it may already be in the constitution). Consider adding a code-review checklist item: "Any query touching `users` or `sessions` must NOT run inside `runWithTenantContext` unless the results are explicitly filtered."

---

### FINDING-08: `sessions` Table Lacks RLS — Revoked Session Cookie Replay Window (re-rated HIGH for credential-at-rest, 2026-09-25)

**Re-rate (#608):** the original Low rating covered a cache-TTL replay window. Combined with plaintext storage of the cookie as `sessions.id`, any read of `sessions` was immediate credential theft. That at-rest defect is HIGH (constitution §XII / §IV). The fix stores only SHA-256 of a CSPRNG cookie, distinct from the row id, and revokes live pre-fix sessions at deploy. The missing database backstop on `active_tenant_id` is tracked separately as HIGH (#609) and is not closed by this re-rate.

**Location:** `apps/api/src/auth/session.repository.ts:82-99`
**Risk:** A revoked session could be served from a stale cache for up to the cache TTL.

**Description:**
The `SessionRepository` has a `SessionCache` interface (currently `NoOpSessionCache`, with Redis planned). The `findActiveById` method reads from cache first:
```ts
const cached = await this.cache.get(id);
if (cached && this.isLive(cached)) return cached;
```

When the Redis cache is wired (slice 3b), a revoked session will remain "active" in the cache until the TTL expires (documented as "5 minutes per FR-AUTH-6"). During this window, a stolen session cookie that has been revoked by the user (e.g., via sign-out on another device) will still authenticate successfully.

**Remediation:**
The planned TTL of <=5 minutes is reasonable for most threat models. For high-security deployments, consider:
1. Cache invalidation on sign-out (write-through invalidation — already implemented via `cache.invalidate(id)` in `touchLastSeen`, `updateActiveContext`, and `revoke`).
2. When the Redis cache is wired (slice 3b), verify the TTL-based replay window is acceptable for the deployment's threat model. The `revoke` method already invalidates the cache, so the replay window is bounded by cache propagation delay, not by missing invalidation.

---

### FINDING-09: No Health Check Endpoint — Metrics Port Used as Liveness Probe (Low)

**Location:** `docker-compose.prod.yml:73-79`
**Risk:** Information disclosure; operational reliability gap.

**Description:**
The API container's health check probes the Prometheus metrics endpoint (`:9464/metrics`):
```yaml
test: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:9464/metrics')...\""]
```

The comment acknowledges "No public /health route yet." The metrics endpoint:
- Exposes internal metric names, label values, and cardinality — useful for reconnaissance.
- If accidentally exposed externally (misconfigured Caddy/LB), it leaks operational telemetry.
- Does not verify database/Redis connectivity — the API can be "healthy" (process up) while unable to serve requests.

**Remediation:**
Implement a `GET /health` endpoint that:
1. Checks database connectivity (a lightweight `SELECT 1`).
2. Checks Redis connectivity.
3. Returns `200` only when all dependencies are reachable.
4. Bind the metrics listener to `127.0.0.1` only (it already is for the worker; verify for API).

---

### FINDING-10: Dev Compose Exposes Postgres and Redis on Host Ports with Default Credentials (Low)

**Location:** `docker-compose.dev.yml:14-20, 32-34`
**Risk:** Local network exploitation of development databases.

**Description:**
The dev compose publishes Postgres on `0.0.0.0:5432` with credentials `dp2/dp2_dev_password` and Redis on `0.0.0.0:6379` with no auth. On a shared network (office WiFi, coworking space), any device on the LAN can connect to these services.

**Remediation:**
Bind dev ports to localhost only:
```yaml
ports:
  - "127.0.0.1:5432:5432"
  # ...
  - "127.0.0.1:6379:6379"
```

---

### FINDING-11: `AlwaysAllowRedis` Breaks All `@Idempotent` Endpoints Without Redis (Informational)

**Location:** `apps/api/src/auth/auth.module.ts:155-158, 163-182`
**Risk:** All `@Idempotent("required")` POST endpoints return **425 Too Early** when `REDIS_URL` is absent.

**Description:**
When `REDIS_URL` is absent, `AlwaysAllowRedis.set()` always returns `null`. For `SET NX` semantics, `null` means "key already exists / NX failed." This causes:
- `InProgressMarker.trySet()` always returns `false` ("another request is in-flight").
- The `IdempotencyInterceptor` interprets this as a concurrent duplicate and returns **425 Too Early** with `Retry-After: 2`.

There are 20+ `@Idempotent("required")` decorators across the codebase. In practice this likely doesn't manifest because integration tests override `REDIS_CLIENT` with mocks, but if anyone runs the full API locally without `REDIS_URL`, **every idempotent POST endpoint is permanently broken** — a worse failure mode than duplicate execution.

Separately, `IdempotencyKeyStore` lookups (`get`) always return `null`, so replay lookups are disabled — requests that pass the in-progress gate are treated as fresh (no stored-response replay).

**Remediation:**
Already covered by FINDING-03's production guard. For dev, `AlwaysAllowRedis.set()` should return `"OK"` (not `null`) when the `nx` option is set, so that `trySet()` succeeds and the request proceeds. Alternatively, provide an in-memory Map-based stub with TTL eviction that correctly implements both NX and replay semantics.

---

### FINDING-12: Outbox Consumer Tenant Context Obligation is Documentation-Only (Informational)

**Location:** `packages/shared/src/outbox/consumer.ts:19-22`
**Risk:** If a consumer implementer forgets `runWithTenantContext`, DB access silently uses whatever GUC is on the connection.

**Description:**
The `OutboxConsumer` interface documents "MUST establish tenant context via `runWithTenantContext` before any DB access beyond the outbox row itself." This is enforced by test (`T561`) but not by the type system or a runtime wrapper.

**Remediation:**
Consider a `TenantScopedOutboxConsumer` base class that wraps `handle()` with `runWithTenantContext(pool, { tenantId: event.tenant_id, ... }, ...)` automatically, so individual consumers can't forget. Alternatively, the drainer itself could establish tenant context before dispatching to the consumer.

---

### FINDING-13: Connector Registration Secret Returned in Response Body (Informational)

**Location:** `apps/api/src/connector/connector-registration.service.ts:341-342`, `apps/api/src/connector/dto/register-connector.dto.ts:74-75`
**Risk:** Secret exposure in logs, browser history, or response caches.

**Description:**
When a connector credential is issued or rotated, the raw secret token is returned in the response body:
```ts
// dto:
secret: string;

// service:
secret: rawToken,
```

This is a "show once" pattern (similar to AWS access keys), which is acceptable. However:
- The log redaction list covers `*.secret` (good).
- There is no `Cache-Control: no-store` header on these responses to prevent intermediate caching.
- If a response logger is ever added that logs full response bodies before redaction kicks in, the secret leaks.

**Remediation:**
1. Add `Cache-Control: no-store` to credential-issuing responses.
2. The existing pino redaction covers `*.secret` — verify that response-body logging (if added) goes through the redaction pipeline.

---

### FINDING-14: No Maximum Password Length Server-Side Beyond Zod 1024 (Informational)

**Location:** `apps/api/src/auth/dto.ts:18`, `packages/auth/src/passwords.ts:23-28`
**Risk:** Denial-of-service via large password payloads to argon2id.

**Description:**
The `SignInSchema` accepts passwords up to 1024 characters. The `hashPassword` function passes the plaintext directly to argon2id with `memoryCost: 19456 KiB` and `timeCost: 2`. While 1024 chars is reasonable, argon2id hashes the entire input — a 1024-byte password with `t=2, m=19MiB` is computationally expensive per request.

An attacker sending many concurrent sign-in requests with max-length passwords could increase CPU/memory pressure on the API server. The rate limiter mitigates this (5 per account / 30 per IP per window), but:
- The rate limit is per-IP, and an attacker with a botnet distributes across many IPs.
- Even within rate limits, 30 concurrent argon2id computations with 19MiB each = ~570MiB of memory.

**Remediation:**
Pre-hash long passwords with SHA-256 before passing to argon2id (a common pattern — bcrypt has a 72-byte limit; argon2id doesn't, but pre-hashing caps the input size without user impact). Or reduce the Zod max to 128 characters (most password managers cap at 64-128).

---

## Positive Observations (Defense Highlights)

The following security controls are well-implemented and deserve recognition:

| Control | Implementation |
|---|---|
| **Constant-time auth** | `timingSafeEqual` for token hashes; dummy PHC for non-existent users |
| **Argon2id with OWASP params** | `memoryCost: 19456, timeCost: 2, parallelism: 1` + `needsRehash` |
| **Token hashing** | Raw tokens never stored; SHA-256 hash in `BYTEA` column |
| **RLS on all tenant tables** | `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` on every tenant-scoped table |
| **SET LOCAL for GUCs** | Transaction-scoped `set_config(..., true)` prevents GUC leak across pool connections |
| **Non-disclosing errors** | Uniform 401 envelope; no email-existence / session-existence leak |
| **Scope-gated guards** | Separate guards per surface (Dashboard, POS, Connector, POS-Operator, SessionOnlyAdmin) |
| **Workflow token exclusion** | `password_reset` / `email_verify` scopes rejected at `AuthGuard` |
| **Comprehensive log redaction** | 80+ redaction paths covering credentials, PII, and PII-suspect fields |
| **Helmet middleware** | Default CSP and security headers via `helmet()` |
| **Parameterized queries** | All SQL uses `$1`-style placeholders; no string concatenation in queries |
| **Zod validation** | Input validation on all mutation endpoints via `ZodValidationPipe` |
| **Idempotency outbox** | Transactional outbox pattern with at-least-once delivery guarantees |
| **UUID validation** | `runWithTenantContext` validates tenantId format before SQL execution |

---

## Summary Table

| ID | Severity | Category | Title |
|---|---|---|---|
| F-01 | Medium | Network / Auth | Missing `trust proxy` — rate limits ineffective behind reverse proxy |
| F-02 | Medium | Network | No CORS policy — future misconfiguration risk |
| F-03 | Medium | Auth | `AlwaysAllowRedis` silently disables rate limiting without production guard |
| F-04 | Medium | Infrastructure | Redis deployed without authentication in production template |
| F-05 | Low | Auth | Session cookie `Secure` flag gated on `NODE_ENV === "production"` only |
| F-06 | Low | Auth | Password reset confirm endpoint not rate-limited |
| F-07 | Low | Multi-tenancy | `users` table not RLS-protected (architectural, but defense-in-depth gap) |
| F-08 | Low | Auth | Session cache replay window on revocation (when Redis cache is wired) |
| F-09 | Low | Infrastructure | No `/health` endpoint; metrics port used as liveness probe |
| F-10 | Low | Infrastructure | Dev compose exposes DB/Redis on all interfaces |
| F-11 | Info | Idempotency | `AlwaysAllowRedis` breaks all `@Idempotent` endpoints without Redis (425 Too Early) |
| F-12 | Info | Multi-tenancy | Outbox consumer tenant context obligation is documentation-only |
| F-13 | Info | Secrets | Connector credential secret in response body (show-once, but no `Cache-Control`) |
| F-14 | Info | DoS | No pre-hash for large passwords before argon2id |

---

## Recommended Priority

1. **Immediate (before production traffic):** F-01 (trust proxy), F-03 (production Redis guard), F-04 (Redis auth).
2. **Short-term:** F-02 (CORS), F-05 (Secure flag), F-09 (health endpoint), F-10 (dev bind).
3. **Backlog:** F-06, F-07, F-08, F-11, F-12, F-13, F-14.
