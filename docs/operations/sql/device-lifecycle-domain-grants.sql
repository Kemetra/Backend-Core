-- Domain-role grants for the Console device revoke (RT-365, on the 0040 device
-- lifecycle columns) and the Console pairing codes (RT-367). See
-- docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0040, as the
-- migration owner (or any role allowed to grant on this table). This file
-- holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/device-lifecycle-domain-grants.sql
-- deploy/apply-domain-grants.sh runs this in step 2 of every release
-- (deploy/README.md), selected by the marker on the next line (RT-812):
-- deploy: every-release
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
--
-- pairing_codes (RT-367): SELECT, INSERT, UPDATE. INSERT is new: until RT-367
-- only the owner-run CLI inserted codes, as the table owner, so without it
-- every POST /api/v1/pairing-codes fails with 500 (permission denied). SELECT
-- (list, cancel, the one-replacement check) and UPDATE (cancel, the
-- redemption's attempt count and burn) are granted here too so a fresh
-- environment does not rely on an earlier base grant. Never DELETE or
-- TRUNCATE: spent codes are retained for audit (0024 has no DELETE policy).
-- RLS by tenant, ENABLE + FORCE.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT UPDATE ON devices TO :"domain_role";
GRANT SELECT, INSERT, UPDATE ON pairing_codes TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT v.tbl, v.priv, has_table_privilege(:'domain_role', v.tbl, v.priv) AS granted
  FROM (VALUES ('devices', 'UPDATE'),
               ('pairing_codes', 'SELECT'),
               ('pairing_codes', 'INSERT'),
               ('pairing_codes', 'UPDATE')) AS v(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', v.tbl, v.priv)) AS domain_ok
  FROM (VALUES ('devices', 'UPDATE'),
               ('pairing_codes', 'SELECT'),
               ('pairing_codes', 'INSERT'),
               ('pairing_codes', 'UPDATE')) AS v(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds the device lifecycle grants.'
\else
  \echo 'FAILED: the domain role is missing UPDATE on devices or SELECT/INSERT/UPDATE on pairing_codes.'
  DO $$ BEGIN RAISE EXCEPTION 'device lifecycle domain grant incomplete'; END $$;
\endif
