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
