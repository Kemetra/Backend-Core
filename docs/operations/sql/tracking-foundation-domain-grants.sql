-- Domain-role grants for the tracking foundation (RT-448, migration 0045).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0045, as the
-- migration owner (or any role allowed to grant on this table). This file
-- holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/tracking-foundation-domain-grants.sql
-- deploy/apply-domain-grants.sh runs this in step 2 of every release
-- (deploy/README.md), selected by the marker on the next line (RT-812):
-- deploy: every-release
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Without this grant the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212);
-- with the boot check off, listTrackingIdentities fails with 500 (permission
-- denied). The table is FORCE ROW LEVEL SECURITY, so the grant gives access
-- only inside runWithTenantContext.
--
-- tracking_identities: SELECT only in this release. Identities are ERP-born
-- (G7-2); the API never creates them yet, and the ingest path that will
-- (a later Gate 7 issue) brings its own INSERT grant. erpnext_tracking_map
-- needs no API grant yet. Never grant UPDATE, DELETE or TRUNCATE: an
-- identity is immutable, and TRUNCATE is not subject to row security.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT ON tracking_identities TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('tracking_identities', 'SELECT')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('tracking_identities', 'SELECT')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required tracking foundation grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'tracking foundation domain grants incomplete'; END $$;
\endif
