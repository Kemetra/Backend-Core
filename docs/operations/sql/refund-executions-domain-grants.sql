-- Domain-role grants for refund executions (RT-787, migration 0067).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0067, as the
-- migration owner (or any role allowed to grant on this table). This file
-- holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/refund-executions-domain-grants.sql
-- deploy/README.md runs this in step 2 of every release, after
-- inventory-anchors-domain-grants.sql.
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212);
-- with the boot check off, every return, return read and refund execution
-- fails with 500 (permission denied). The table is FORCE ROW LEVEL SECURITY,
-- so the grants give access only inside runWithTenantContext.
--
-- SELECT and INSERT only. refund_executions holds append-only payout facts
-- (0067 has SELECT and INSERT tenant policies and no UPDATE or DELETE
-- policy): a settled execution is never edited or rolled back. Never grant
-- UPDATE, DELETE or TRUNCATE: TRUNCATE is not subject to row security, and a
-- deleted execution would reopen a refund the drawer already paid. The new
-- columns on sale_return_tenders and sale_returns are covered by those
-- tables' existing grants. The auth lookup role must hold no privilege on
-- refund_executions (AUTH_LOOKUP_FORBIDDEN_GRANTS).

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT ON refund_executions TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('refund_executions', 'SELECT'), ('refund_executions', 'INSERT')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('refund_executions', 'SELECT'), ('refund_executions', 'INSERT')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required refund execution grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'refund execution domain grants incomplete'; END $$;
\endif
