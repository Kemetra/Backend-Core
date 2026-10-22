-- Domain-role grants for platform support sessions (RT-414, migration 0062).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0062, as the
-- migration owner (or any role allowed to grant on this table). This file
-- holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/platform-support-sessions-domain-grants.sql
-- deploy/README.md runs this in step 2 of every release, after
-- inventory-position-events-domain-grants.sql.
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212);
-- with the boot check off, every platform-admin request into a non-member
-- tenant fails with 500 (permission denied). The table is FORCE ROW LEVEL
-- SECURITY with a platform-admin-only policy, so the grants give access only
-- under app.is_platform_admin = 'true'.
--
-- platform_support_sessions: SELECT, INSERT and UPDATE. A support session is
-- opened (INSERT), renewed and ended (UPDATE; the renew and end lock the row
-- FOR UPDATE), and read on every covered request (SELECT). Rows are never
-- deleted (0062's trigger refuses it for every role): never grant DELETE or
-- TRUNCATE. The auth lookup role must hold no privilege on it
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS).

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT, UPDATE ON platform_support_sessions TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('platform_support_sessions', 'SELECT'),
               ('platform_support_sessions', 'INSERT'),
               ('platform_support_sessions', 'UPDATE')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('platform_support_sessions', 'SELECT'),
               ('platform_support_sessions', 'INSERT'),
               ('platform_support_sessions', 'UPDATE')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required platform support session grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'platform support session domain grants incomplete'; END $$;
\endif
