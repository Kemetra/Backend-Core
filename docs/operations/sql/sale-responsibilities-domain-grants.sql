-- Domain-role grants for sale payer responsibilities and the payer-account
-- routes (RT-418, migration 0051). See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0051, as the
-- migration owner (or any role allowed to grant on these tables). This file
-- holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/sale-responsibilities-domain-grants.sql
-- deploy/apply-domain-grants.sh runs this in step 2 of every release
-- (deploy/README.md), selected by the marker on the next line (RT-812):
-- deploy: every-release
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212);
-- with the boot check off, every capture, sale read and posting-feed pull
-- that touches a credit sale fails with 500 (permission denied), and so does
-- every worker posting intent (the worker shares this role). The tables are
-- FORCE ROW LEVEL SECURITY, so the grants give access only inside
-- runWithTenantContext.
--
-- sale_responsibilities: SELECT and INSERT only. It is part of the immutable
-- sale fact (0051 has SELECT and INSERT tenant policies and no UPDATE or
-- DELETE policy). Never grant UPDATE, DELETE or TRUNCATE: TRUNCATE is not
-- subject to row security. The auth lookup role must hold no privilege on it
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS).
--
-- payer_account: SELECT, INSERT and UPDATE. The Console routes list, create
-- and (RT-572) update payers; a credit capture locks its payer row FOR SHARE,
-- which also needs UPDATE. No route deletes a payer: never grant DELETE or TRUNCATE.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT ON sale_responsibilities TO :"domain_role";
GRANT SELECT, INSERT, UPDATE ON payer_account TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('sale_responsibilities', 'SELECT'), ('sale_responsibilities', 'INSERT'),
               ('payer_account', 'SELECT'), ('payer_account', 'INSERT'),
               ('payer_account', 'UPDATE')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('sale_responsibilities', 'SELECT'), ('sale_responsibilities', 'INSERT'),
               ('payer_account', 'SELECT'), ('payer_account', 'INSERT'),
               ('payer_account', 'UPDATE')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required sale responsibility grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'sale responsibility domain grants incomplete'; END $$;
\endif
