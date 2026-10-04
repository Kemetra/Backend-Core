-- Domain-role grants for the cashier-admissions tables (RT-113 BC2, migration
-- 0035) and for the tenant-status read of device auth (RT-213). See
-- docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0035, as the
-- migration owner (or any role allowed to grant on these tables). This file
-- holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/cashier-admissions-domain-grants.sql
-- deploy/README.md runs this as step 2 of every release.
-- Optionally also pass -v lookup_role=<AUTH_LOOKUP_DATABASE_URL role> to check
-- that the lookup role holds no privilege of any kind on these tables.
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant or a
-- lookup-role privilege, so deployment automation cannot accept a failed step.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212);
-- with the boot check off, the three /api/pos/v1/cashier-admissions routes fail
-- with 500 (permission denied). The tables are FORCE ROW LEVEL SECURITY, so the
-- grants give access only inside runWithTenantContext.
--
-- RT-213: every device-authenticated POS request reads its tenant's status
-- (`tenants.status`, `deleted_at`) on the domain role, inside that tenant's RLS
-- context. Without SELECT on `tenants` every till is refused at once; the
-- API refuses to boot instead (DOMAIN_REQUIRED_GRANTS).
--
-- `cashier_admissions` has no DELETE grant: admissions are ended, never
-- removed. `cashier_admission_requests` needs DELETE to purge expired replay
-- entries. Never grant TRUNCATE on either table: TRUNCATE is not subject to
-- row security.
--
-- The auth lookup role must hold no privilege on these tables. At boot the API
-- refuses to start if it holds any table privilege on either one, TRUNCATE,
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

GRANT SELECT, INSERT, UPDATE         ON cashier_admissions         TO :"domain_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON cashier_admission_requests TO :"domain_role";
GRANT SELECT                         ON tenants                    TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('cashier_admissions', 'SELECT'), ('cashier_admissions', 'INSERT'),
               ('cashier_admissions', 'UPDATE'),
               ('cashier_admission_requests', 'SELECT'), ('cashier_admission_requests', 'INSERT'),
               ('cashier_admission_requests', 'UPDATE'), ('cashier_admission_requests', 'DELETE'),
               ('tenants', 'SELECT'))
       AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('cashier_admissions', 'SELECT'), ('cashier_admissions', 'INSERT'),
               ('cashier_admissions', 'UPDATE'),
               ('cashier_admission_requests', 'SELECT'), ('cashier_admission_requests', 'INSERT'),
               ('cashier_admission_requests', 'UPDATE'), ('cashier_admission_requests', 'DELETE'),
               ('tenants', 'SELECT'))
       AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'cashier-admissions domain grants incomplete'; END $$;
\endif

-- Optional: the lookup role must hold no privilege of any kind on these tables.
\if :{?lookup_role}
  SELECT NOT bool_or(has_table_privilege(:'lookup_role', t.tbl, p.priv)) AS lookup_ok
    FROM (VALUES ('cashier_admissions'), ('cashier_admission_requests')) AS t(tbl)
   CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                      ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv) \gset
  \if :lookup_ok
    \echo 'OK: lookup role holds no privilege on the cashier-admissions tables.'
  \else
    \echo 'FAILED: the lookup role holds a privilege on a cashier-admissions table.'
    DO $$ BEGIN RAISE EXCEPTION 'lookup role holds a cashier-admissions privilege'; END $$;
  \endif
\endif
