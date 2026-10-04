-- Domain-role grants for the cashier-admissions tables (RT-113 BC2, migration
-- 0035). See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0035, as the
-- migration owner (or any role allowed to grant on these tables). This file
-- holds NO credential. Replace `domain_runtime` below with the name of the
-- environment's DATABASE_URL role, e.g. with psql:
--   psql "$MIGRATION_DATABASE_URL" -v domain_role=<role> \
--        -f docs/operations/sql/cashier-admissions-domain-grants.sql
--
-- Without these grants the three /api/pos/v1/cashier-admissions routes fail
-- with 500 (permission denied). The tables are FORCE ROW LEVEL SECURITY, so the
-- grants give access only inside runWithTenantContext.
--
-- `cashier_admissions` has no DELETE grant: admissions are ended, never
-- removed. `cashier_admission_requests` needs DELETE to purge expired replay
-- entries.
--
-- Never grant the auth lookup role anything on these tables: the API refuses
-- to boot if it holds any grant on them (AUTH_LOOKUP_FORBIDDEN_GRANTS in
-- apps/api/src/auth/database-pools.ts).

\if :{?domain_role}
\else
  \set domain_role domain_runtime
\endif

GRANT SELECT, INSERT, UPDATE         ON cashier_admissions         TO :"domain_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON cashier_admission_requests TO :"domain_role";

-- Verify: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('cashier_admissions', 'SELECT'), ('cashier_admissions', 'INSERT'),
               ('cashier_admissions', 'UPDATE'),
               ('cashier_admission_requests', 'SELECT'), ('cashier_admission_requests', 'INSERT'),
               ('cashier_admission_requests', 'UPDATE'), ('cashier_admission_requests', 'DELETE'))
       AS t(tbl, priv);
