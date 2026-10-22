-- Domain-role grants for tracking holds, recall, the identity expiry
-- correction and the Inventory Safety Revision (RT-449, migration 0072).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0072, as the
-- migration owner (or any role allowed to grant on these tables). This file
-- holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/inventory-safety-domain-grants.sql
-- deploy/README.md runs this in step 2 of every release, after
-- refund-executions-domain-grants.sql.
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212);
-- with the boot check off, every hold, recall and expiry correction (and a
-- tracking-profile change) fails with 500 (permission denied). Every table is
-- FORCE ROW LEVEL SECURITY, so the grants give access only inside
-- runWithTenantContext.
--
-- tenant_inventory_safety_revisions: SELECT, INSERT and UPDATE (the revision
--   is upserted; a trigger refuses any step back). No DELETE policy.
-- inventory_safety_changes, inventory_recalls,
-- tracking_identity_expiry_corrections: SELECT and INSERT only (append-only;
--   no UPDATE or DELETE policy).
-- tracking_holds: SELECT, INSERT and UPDATE (a release; a trigger lets only
--   the release be set, once). No DELETE policy.
-- tracking_identities: UPDATE added to 0045's SELECT (the expiry correction;
--   0072's guard lets only expiry_date change, and only with its correction
--   row in the same transaction). Table-level, because the boot check
--   (has_table_privilege) cannot see a column grant; the guard is the column
--   fence.
-- Never grant DELETE or TRUNCATE on any of them: TRUNCATE is not subject to
-- row security.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT, UPDATE ON tenant_inventory_safety_revisions TO :"domain_role";
GRANT SELECT, INSERT ON inventory_safety_changes TO :"domain_role";
GRANT SELECT, INSERT ON inventory_recalls TO :"domain_role";
GRANT SELECT, INSERT, UPDATE ON tracking_holds TO :"domain_role";
GRANT SELECT, INSERT ON tracking_identity_expiry_corrections TO :"domain_role";
GRANT SELECT, UPDATE ON tracking_identities TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('tenant_inventory_safety_revisions', 'SELECT'),
               ('tenant_inventory_safety_revisions', 'INSERT'),
               ('tenant_inventory_safety_revisions', 'UPDATE'),
               ('inventory_safety_changes', 'SELECT'),
               ('inventory_safety_changes', 'INSERT'),
               ('inventory_recalls', 'SELECT'),
               ('inventory_recalls', 'INSERT'),
               ('tracking_holds', 'SELECT'),
               ('tracking_holds', 'INSERT'),
               ('tracking_holds', 'UPDATE'),
               ('tracking_identity_expiry_corrections', 'SELECT'),
               ('tracking_identity_expiry_corrections', 'INSERT'),
               ('tracking_identities', 'SELECT'),
               ('tracking_identities', 'UPDATE')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('tenant_inventory_safety_revisions', 'SELECT'),
               ('tenant_inventory_safety_revisions', 'INSERT'),
               ('tenant_inventory_safety_revisions', 'UPDATE'),
               ('inventory_safety_changes', 'SELECT'),
               ('inventory_safety_changes', 'INSERT'),
               ('inventory_recalls', 'SELECT'),
               ('inventory_recalls', 'INSERT'),
               ('tracking_holds', 'SELECT'),
               ('tracking_holds', 'INSERT'),
               ('tracking_holds', 'UPDATE'),
               ('tracking_identity_expiry_corrections', 'SELECT'),
               ('tracking_identity_expiry_corrections', 'INSERT'),
               ('tracking_identities', 'SELECT'),
               ('tracking_identities', 'UPDATE')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required inventory safety grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'inventory safety domain grants incomplete'; END $$;
\endif
