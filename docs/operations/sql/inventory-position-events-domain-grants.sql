-- Domain-role grants for inventory status moves, relocations and the tenant
-- inventory settings (RT-435, migration 0055).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0055, as the
-- migration owner (or any role allowed to grant on these tables). This file
-- holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/inventory-position-events-domain-grants.sql
-- deploy/README.md runs this in step 2 of every release, after
-- sale-credit-reversals-domain-grants.sql.
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212);
-- with the boot check off, every status move, relocation and return landing
-- policy read or write fails with 500 (permission denied). Both tables are
-- FORCE ROW LEVEL SECURITY, so the grants give access only inside
-- runWithTenantContext.
--
-- inventory_position_events: SELECT and INSERT only. It has no UPDATE or
-- DELETE policy; an event record is append-only.
-- tenant_inventory_settings: SELECT, INSERT and UPDATE (the setting is
-- upserted). It has no DELETE policy.
-- Never grant DELETE or TRUNCATE on either: TRUNCATE is not subject to row
-- security.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT ON inventory_position_events TO :"domain_role";
GRANT SELECT, INSERT, UPDATE ON tenant_inventory_settings TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('inventory_position_events', 'SELECT'),
               ('inventory_position_events', 'INSERT'),
               ('tenant_inventory_settings', 'SELECT'),
               ('tenant_inventory_settings', 'INSERT'),
               ('tenant_inventory_settings', 'UPDATE')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('inventory_position_events', 'SELECT'),
               ('inventory_position_events', 'INSERT'),
               ('tenant_inventory_settings', 'SELECT'),
               ('tenant_inventory_settings', 'INSERT'),
               ('tenant_inventory_settings', 'UPDATE')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required inventory position event grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'inventory position events domain grants incomplete'; END $$;
\endif
