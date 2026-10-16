-- Domain-role grant for the Console device revoke (RT-365, on the 0040 device
-- lifecycle columns). See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0040, as the
-- migration owner (or any role allowed to grant on this table). This file
-- holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/device-lifecycle-domain-grants.sql
-- deploy/README.md runs this in step 2 of every release, after
-- sale-reprints-domain-grants.sql.
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Without this grant the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212);
-- with the boot check off, every POST /api/v1/devices/{deviceId}/revoke fails
-- with 500 (permission denied): the revoke locks the device row FOR UPDATE
-- (which needs UPDATE) and sets the revoke fields. No earlier domain path wrote
-- `devices` (pairing only INSERTs). The table is ROW LEVEL SECURITY by
-- tenant, so the grant gives access only inside runWithTenantContext.
--
-- devices: UPDATE only (SELECT and INSERT are already exercised by sign-in
-- and pairing). Never grant DELETE or TRUNCATE: a device is never deleted
-- (RESTRICT FKs from sales, shifts and cash facts) and TRUNCATE is not subject
-- to row security. The auth lookup role keeps SELECT only.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT UPDATE ON devices TO :"domain_role";

-- Verify the domain role: the row must read `t`.
SELECT 'devices' AS tbl, 'UPDATE' AS priv,
       has_table_privilege(:'domain_role', 'devices', 'UPDATE') AS granted;

SELECT has_table_privilege(:'domain_role', 'devices', 'UPDATE') AS domain_ok \gset

\if :domain_ok
  \echo 'OK: domain role holds the device lifecycle grant.'
\else
  \echo 'FAILED: the domain role is missing UPDATE on devices.'
  DO $$ BEGIN RAISE EXCEPTION 'device lifecycle domain grant incomplete'; END $$;
\endif
