### Changed
- RT-816 `[GATED .github]`, owner authorization in session 2026-10-22 (scope
  expanded to the release gates on RT-816): the `packages/db` migration and
  worker DB suites move out of `db-integration` into a new parallel
  `db-package (packages/db migrations + worker DB suites)` job with the same
  tier gate, so they no longer run in front of the api suite. `ci` requires
  it like `db-integration`. Both release gates (`release-images.yml`
  `REQUIRED_CHECKS` and `deploy/lab/verify-release.cjs`) now also require it,
  so a `main` commit with failing migration tests still cannot be released.
  `verify-release.cjs` requires `db-package` only when the release commit's own
  `ci.yml` defines that job (before RT-816 `db-integration` ran those suites,
  so older releases stay verifiable at equal strength); an unreadable `ci.yml`
  requires all three. `db-integration` keeps its name, which the release
  gates read.
