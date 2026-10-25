### Changed
- RT-863 `[GATED .github + deploy]`, owner authorization 2026-10-25 (decision
  MR-3, RT-863 comment 13811, option b with automatic tightening): image
  release and lab deploy now depend on the POS compatibility gate.
  `release-images.yml` and `deploy/lab/verify-release.cjs` require a green
  `contracts-compat (POS supported snapshots)` run on the release SHA (no
  pre-RT-713 exemption), and the new `deploy/release-compat-gate.cjs` refuses a
  fleet baseline that is stale or in the future at release/deploy time.
  Release-mode envelope/replay `NOT_PROVEN` is recorded in the run summary, the
  GitHub release notes and the lab ledger instead of blocking; once every
  supported snapshot has a `recorded` replay fixture the gate applies
  `check.mjs --mode release` semantics with no further change. The RT-816
  `db-package` pre-split fallback is unchanged.
