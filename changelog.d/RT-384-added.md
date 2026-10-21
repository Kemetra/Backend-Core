### Added
- RT-384 `[GATED]`, pending owner approval (AD-CASH-001 follow-up 1): OpenAPI
  contract `cash-variance-policy.openapi.yaml` (1.0.0-draft, contract-only).
  It defines the shift variance policy: the device read of the resolved policy
  (`GET /api/pos/v1/store/cash-variance-policy`, ETag/304), and the
  cookie-session Console reads, revision lists and publishes for the tenant
  default and the store override (owner / tenant_admin; a permanent override
  is owner-only; stricter-only; 90-day horizon). `pos-shifts.openapi.yaml`
  1.2.0-draft adds an optional `frozenPolicy` object on `openShift` and
  optional recorded / derived values on `Shift` / `ShiftClose`, and
  replaces the stale "default 0" text. `shift-closes.openapi.yaml`
  1.1.0-draft adds the same optional values and three optional filters.
  Strictly additive; no runtime or migration change (RT-385 / RT-387).
