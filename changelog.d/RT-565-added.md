### Added
- RT-565 `[GATED]`, owner-approved 2026-10-19 (RT-565 comment 12969, D1–D7 of
  `docs/planning/rt-565-posting-freshness-read.md`):
  `erpnext-sync-ops/console-sync-ops.yaml` 1.2.0-draft (additive).
  `consoleGetSyncOpsSummary` gains a required top-level `asOf` and a
  required `postingFreshness`: `lastPosted` (`state` `known` / `unknown` /
  `none` and its ERP confirmation time), `pendingCount`, `oldestPendingAt`
  and `oldestPendingAgeSeconds`. Facts only, no current / behind verdict;
  the `posting` domain rule, roles, session, RLS, store scope and the
  out-of-scope 404 are unchanged. No runtime or migration change; the read
  and its indexes ship in the RT-565 runtime PR.
