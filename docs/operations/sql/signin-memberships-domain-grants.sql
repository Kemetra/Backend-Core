-- Domain-role grants for the sign-in memberships read (RT-343).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up`, as the migration owner (or any
-- role allowed to grant on these tables). This file holds NO credential. Give
-- psql the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a
-- URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/signin-memberships-domain-grants.sql
-- deploy/README.md runs this in step 2 of every release, after
-- erpnext-posting-resolution-domain-grants.sql.
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Sign-in reads the user's memberships, joined to roles and tenants, on the
-- domain role (as GET /api/v1/context/me already does). Without these grants
-- the API refuses to boot in production (DOMAIN_REQUIRED_GRANTS in
-- apps/api/src/auth/database-pools.ts); with the boot check off, every Console
-- sign-in fails with 500. `tenants` SELECT is granted by
-- cashier-admissions-domain-grants.sql (RT-213). The tables are row-level
-- secured, so the grants give access only inside runWithTenantContext.
--
-- SELECT only: sign-in never writes these tables. Never grant TRUNCATE:
-- TRUNCATE is not subject to row security.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT ON memberships TO :"domain_role";
GRANT SELECT ON roles       TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('memberships', 'SELECT'),
               ('roles', 'SELECT')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('memberships', 'SELECT'),
               ('roles', 'SELECT')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required sign-in memberships grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'sign-in memberships domain grants incomplete'; END $$;
\endif
