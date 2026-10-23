### Changed
- RT-812 `[GATED]`, owner authorization in Jira RT-812 comment 13442: a
  migration, its grants and a metric are now registered by adding files, not by
  editing shared lists, so parallel migration PRs no longer conflict.
  - The migration chain comes from a frozen baseline plus
    `packages/db/__tests__/cli/migrations/<id>.ts`, each with a probe. The
    0001 down chain is derived.
  - The boot-checked grants come from `apps/api/src/auth/grants/*.grants.ts`,
    checked against the deploy scripts. New tables must be classified for the
    auth lookup role.
  - The metric label allowlist comes from
    `packages/shared/src/observability/metric-labels/*.labels.ts`.
  - **Deploy step 2 changed:** run
    `op run --env-file=deploy/grants.env -- deploy/apply-domain-grants.sh`. It
    applies every grant script marked `-- deploy: every-release`, and the
    release bundle ships the same set.
  - No guard is weaker. A stray or missing migration, a wrong head, a missing
    grant and an unclassified table still fail, with negative tests for each.
