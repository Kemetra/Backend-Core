### Changed
- RT-816 `[GATED .github]`, owner authorization in session 2026-10-22 (scope
  expanded to the release gates on RT-816): the `packages/db` migration and
  worker DB suites move out of `db-integration` into a new parallel
  `db-package (packages/db migrations + worker DB suites)` job with the same
  tier gate, so they no longer run in front of the api suite. `ci` requires
  it like `db-integration`. Both release gates (`release-images.yml`
  `REQUIRED_CHECKS` and `deploy/lab/verify-release.cjs`) now also require it,
  so a `main` commit with failing migration tests still cannot be released.
  `db-integration` keeps its name for the ruleset.
