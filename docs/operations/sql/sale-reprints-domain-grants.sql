-- Domain-role grants for the receipt reprint record (RT-539, migration 0047).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0047 and 0048, as
-- the migration owner (or any role allowed to grant on this table). This file
-- holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/sale-reprints-domain-grants.sql
-- deploy/README.md runs this in step 2 of every release, after
-- signin-memberships-domain-grants.sql.
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212);
-- with the boot check off, recordSaleReprint fails with 500 (permission
-- denied). The table is FORCE ROW LEVEL SECURITY, so the grants give access
-- only inside runWithTenantContext.
--
-- sale_reprints: SELECT and INSERT only. It is append-only (0047 has SELECT
-- and INSERT tenant policies and no UPDATE or DELETE policy): a reprint is
-- never changed or removed. Never grant UPDATE, DELETE or TRUNCATE: TRUNCATE
-- is not subject to row security. The auth lookup role must hold no privilege
-- on it (AUTH_LOOKUP_FORBIDDEN_GRANTS).

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT ON sale_reprints TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('sale_reprints', 'SELECT'), ('sale_reprints', 'INSERT')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('sale_reprints', 'SELECT'), ('sale_reprints', 'INSERT')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required sale reprint grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'sale reprint domain grants incomplete'; END $$;
\endif
