-- Domain-role grants for the shift variance policy (RT-387, on migration
-- 0050_shift_variance_policy from RT-385). See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0050, as the
-- migration owner (or any role allowed to grant on these tables). This file
-- holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/shift-variance-policy-domain-grants.sql
-- deploy/README.md runs this in step 2 of every release, after
-- sale-responsibilities-domain-grants.sql.
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212);
-- with the boot check off, every policy read and publish, every POS policy
-- read, every cash-up open that carries a frozen policy and every close with
-- an approver fails with 500 (permission denied). The tables are FORCE ROW
-- LEVEL SECURITY, so the grants give access only inside runWithTenantContext.
--
-- cash_variance_policy_revisions: SELECT and INSERT only. Revisions are
-- immutable (0050 has SELECT and INSERT tenant policies, no UPDATE or DELETE
-- policy, and a trigger refuses UPDATE / DELETE / TRUNCATE).
--
-- shift_close_approver_checks: SELECT and INSERT only. The verdict on a
-- close's approver is written once after the close commits and read back by
-- the close replay and the admin shift-close reads; append-only as above.
--
-- Never grant UPDATE, DELETE or TRUNCATE on either: TRUNCATE is not subject to
-- row security. The auth lookup role must hold no privilege on them
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS). The 0050 columns on `shifts` and
-- `shift_closes` live on tables the domain role already reads and writes
-- (shift-cash-up-domain-grants.sql grants them table-wide).

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT ON cash_variance_policy_revisions TO :"domain_role";
GRANT SELECT, INSERT ON shift_close_approver_checks TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('cash_variance_policy_revisions', 'SELECT'), ('cash_variance_policy_revisions', 'INSERT'),
               ('shift_close_approver_checks', 'SELECT'), ('shift_close_approver_checks', 'INSERT')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('cash_variance_policy_revisions', 'SELECT'), ('cash_variance_policy_revisions', 'INSERT'),
               ('shift_close_approver_checks', 'SELECT'), ('shift_close_approver_checks', 'INSERT')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required shift variance policy grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'shift variance policy domain grants incomplete'; END $$;
\endif
