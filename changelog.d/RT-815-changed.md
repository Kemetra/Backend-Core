### Changed
- RT-815, owner authorization in session 2026-10-22 ("pr and merge
  auhtrized"): the api Jest suite runs on ONE shared Postgres per run instead
  of one container per spec file. Jest `globalSetup` builds a migrated
  `rt_template`, and `startPgEnv()` clones a fresh database from it per spec
  file (~150 ms instead of ~5 s per file; 284 files booted a container).
  `stopPgEnv()` drops the clone. `globalTeardown` fails the run if any spec
  changed cluster roles (`pg_authid`). Specs that change roles or need a
  container handle use `startPgEnv({ isolated: true })`. Lock and activity
  barriers are scoped to the spec's own database. The worker package keeps
  per-file containers through the fallback. Test code only: no `.github`,
  migration, threshold or product change.
