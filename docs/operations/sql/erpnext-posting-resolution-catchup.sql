-- Catch-up for the frozen posting resolution backfill (RT-330, migration 0038).
-- See docs/operations/database-roles.md.
--
-- Why: `migrate` runs while the PREVIOUS release's worker and API are still up.
-- Code from before 0037 creates posting intents (worker) and re-offers
-- dead-letters (repair) without freezing a resolution. A row it writes after
-- 0038 has passed its tenant keeps a NULL resolution version and the feed's
-- pre-0037 live item-map join. Run this script AFTER the new release is up
-- (deploy step 4): from then on every writer freezes, so one pass freezes
-- every row the old code left behind.
--
-- It re-runs 0038's SQL verbatim (\ir below), so it is idempotent and safe at
-- any time: intents that already carry a version are skipped. Run it as the
-- migration owner, with the connection in libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a
-- URL argument:
--   psql -X -f docs/operations/sql/erpnext-posting-resolution-catchup.sql
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP).

\set ON_ERROR_STOP on

\ir ../../../packages/db/drizzle/0038_erpnext_posting_resolution_backfill.sql

\echo 'OK: posting resolution catch-up applied.'
