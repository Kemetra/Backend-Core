-- Catch-up for the inventory effect integration backfill (RT-425, migration
-- 0043). See docs/operations/database-roles.md.
--
-- Why: `migrate` runs while the PREVIOUS release's API is still up. Code from
-- before 0042 appends manual movements, transfers and count corrections
-- without an inventory_effect_integration record. A movement it writes after
-- 0043 has passed its tenant has no integration record, and the movement list
-- projects its integrationState as null. Run this script AFTER the new release
-- is up (deploy step 4): from then on every writer records `not_posted` in the
-- same transaction, so one pass covers every row the old code left behind.
--
-- It re-runs 0043's SQL verbatim (\ir below), so it is idempotent and safe at
-- any time: effects that already have a record are skipped. Run it as the
-- migration owner, with the connection in libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a
-- URL argument:
--   psql -X -f docs/operations/sql/inventory-effect-integration-catchup.sql
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP).

\set ON_ERROR_STOP on

\ir ../../../packages/db/drizzle/0043_inventory_effect_integration_backfill.sql

\echo 'OK: inventory effect integration catch-up applied.'
