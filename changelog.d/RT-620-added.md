### Added
- RT-620 `[GATED]`, owner-approved 2026-10-18 (RT-574 issue 2, O7): every
  cookieAuth operation not on the shared console rate-limit exemption list
  (`signOut`, `requestEmailVerification`, `refreshSession`) documents the 429
  the RT-619 `ConsoleRateLimitGuard` can return: 103 operations in 24
  contract files (`auth.openapi.yaml` holds only exempt operations and is
  unchanged). Each file gains a `TooManyRequests` response (code
  `rate_limited`, the canonical envelope, required `Cache-Control: no-store`
  and `X-Request-Id`) and its
  own `ConsoleRetryAfter` header (required integer, 1 to 3600, not the POS
  `RetryAfter`); audit, context, memberships and tenants also gain the
  canonical `Error` schema; tenant-branding, whose `Error` code enum is
  closed, gets a `RateLimitedError` for its 429; the text-only closed code
  sets name `rate_limited`. No budget number appears in any contract. The
  console-sales "no 429" sentence is gone and the status mappings name the
  429. Each changed file takes an additive minor version. A new contract
  sweep imports the runtime exemption list. No runtime or migration change.
