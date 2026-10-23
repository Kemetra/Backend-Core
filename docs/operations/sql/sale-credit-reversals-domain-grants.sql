-- Domain-role grants for credit-sale reversals (RT-577, migration 0054).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0054, as the
-- migration owner (or any role allowed to grant on these tables). This file
-- holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/sale-credit-reversals-domain-grants.sql
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
-- with the boot check off, every credit reversal fails with 500 (permission
-- denied). The tables are FORCE ROW LEVEL SECURITY, so the grants give access
-- only inside runWithTenantContext.
--
-- All three tables: SELECT and INSERT only. sale_credit_reversals and
-- sale_credit_reversal_tenders are append-only reversal facts (0054 has SELECT
-- and INSERT tenant policies and no UPDATE or DELETE policy).
-- sale_approval_uses is the shared single-use ledger of approval ids: a
-- cash-paying credit return writes its id and reads the ledger to refuse a
-- reuse. A void's ledger row is written by the SECURITY DEFINER sale_voids
-- trigger, which needs no grant. Never grant UPDATE, DELETE or TRUNCATE:
-- TRUNCATE is not subject to row security, and a deleted ledger row would make
-- an approval id reusable. The auth lookup role must hold no privilege on any
-- of them (AUTH_LOOKUP_FORBIDDEN_GRANTS).

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT ON sale_credit_reversals TO :"domain_role";
GRANT SELECT, INSERT ON sale_credit_reversal_tenders TO :"domain_role";
GRANT SELECT, INSERT ON sale_approval_uses TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('sale_credit_reversals', 'SELECT'), ('sale_credit_reversals', 'INSERT'),
               ('sale_credit_reversal_tenders', 'SELECT'), ('sale_credit_reversal_tenders', 'INSERT'),
               ('sale_approval_uses', 'SELECT'), ('sale_approval_uses', 'INSERT')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('sale_credit_reversals', 'SELECT'), ('sale_credit_reversals', 'INSERT'),
               ('sale_credit_reversal_tenders', 'SELECT'), ('sale_credit_reversal_tenders', 'INSERT'),
               ('sale_approval_uses', 'SELECT'), ('sale_approval_uses', 'INSERT')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required credit reversal grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'credit reversal domain grants incomplete'; END $$;
\endif
