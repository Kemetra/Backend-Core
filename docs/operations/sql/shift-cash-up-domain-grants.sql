-- Domain-role grants for the shift cash-up tables (RT-17, migration 0036).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0036, as the
-- migration owner (or any role allowed to grant on these tables). This file
-- holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/shift-cash-up-domain-grants.sql
-- deploy/README.md runs this in step 2 of every release, after
-- cashier-admissions-domain-grants.sql.
-- Optionally also pass -v lookup_role=<AUTH_LOOKUP_DATABASE_URL role> to check
-- that the lookup role holds no privilege of any kind on these tables.
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant or a
-- lookup-role privilege, so deployment automation cannot accept a failed step.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212);
-- with the boot check off, the shift cash-up routes (POST /api/pos/v1/shifts
-- and /api/pos/v1/shifts/{shift_id}/cash-movements) fail with 500 (permission
-- denied). The tables are FORCE ROW LEVEL SECURITY, so the grants give access
-- only inside runWithTenantContext.
--
-- `shifts` needs UPDATE (RT-17 comment 10930): a close moves the shift to
-- closed, an open may adopt the audit-ingest row of the same shift, and the
-- 0036 triggers lock the shift row FOR SHARE (movement) / FOR UPDATE (close),
-- which requires UPDATE. No DELETE: a cash-up shift is never deleted.
-- The three fact tables are append-only: SELECT and INSERT only (their
-- triggers refuse UPDATE, DELETE and TRUNCATE for every role anyway). Never
-- grant TRUNCATE on any of them: TRUNCATE is not subject to row security.
--
-- The auth lookup role must hold no privilege on these tables. At boot the API
-- refuses to start if it holds any table privilege on one, TRUNCATE,
-- REFERENCES and TRIGGER included (AUTH_LOOKUP_FORBIDDEN_GRANTS in
-- apps/api/src/auth/database-pools.ts, RT-212). The optional lookup_role check
-- below runs the same check at deploy time.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT, UPDATE ON shifts               TO :"domain_role";
GRANT SELECT, INSERT         ON shift_closes         TO :"domain_role";
GRANT SELECT, INSERT         ON shift_cash_movements TO :"domain_role";
GRANT SELECT, INSERT         ON shift_refund_claims  TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('shifts', 'SELECT'), ('shifts', 'INSERT'), ('shifts', 'UPDATE'),
               ('shift_closes', 'SELECT'), ('shift_closes', 'INSERT'),
               ('shift_cash_movements', 'SELECT'), ('shift_cash_movements', 'INSERT'),
               ('shift_refund_claims', 'SELECT'), ('shift_refund_claims', 'INSERT'))
       AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('shifts', 'SELECT'), ('shifts', 'INSERT'), ('shifts', 'UPDATE'),
               ('shift_closes', 'SELECT'), ('shift_closes', 'INSERT'),
               ('shift_cash_movements', 'SELECT'), ('shift_cash_movements', 'INSERT'),
               ('shift_refund_claims', 'SELECT'), ('shift_refund_claims', 'INSERT'))
       AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required shift cash-up grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'shift cash-up domain grants incomplete'; END $$;
\endif

-- Optional: the lookup role must hold no privilege of any kind on these tables.
\if :{?lookup_role}
  SELECT NOT bool_or(has_table_privilege(:'lookup_role', t.tbl, p.priv)) AS lookup_ok
    FROM (VALUES ('shifts'), ('shift_closes'), ('shift_cash_movements'),
                 ('shift_refund_claims')) AS t(tbl)
   CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                      ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv) \gset
  \if :lookup_ok
    \echo 'OK: lookup role holds no privilege on the shift cash-up tables.'
  \else
    \echo 'FAILED: the lookup role holds a privilege on a shift cash-up table.'
    DO $$ BEGIN RAISE EXCEPTION 'lookup role holds a shift cash-up privilege'; END $$;
  \endif
\endif
