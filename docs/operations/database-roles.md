# Database runtime roles

Production uses four independent PostgreSQL credentials.

| Environment variable | Purpose | Required posture |
| --- | --- | --- |
| `MIGRATION_DATABASE_URL` | One-shot schema migration | DDL-capable owner, `NOSUPERUSER NOCREATEROLE`; never injected into API or worker |
| `DATABASE_URL` | Tenant/domain runtime | Non-superuser, `NOBYPASSRLS`; tenant access only inside `runWithTenantContext`; no `UPDATE` or `DELETE` on `audit_events` (RT-353) |
| `AUTH_LOOKUP_DATABASE_URL` | Pre-tenant authentication/bootstrap | Distinct non-superuser role with only the table operations listed below |
| `AUDIT_RETENTION_DATABASE_URL` | The worker's audit retention sweep only | `audit_retention_worker`: non-superuser, `NOBYPASSRLS`, only `SELECT` and `UPDATE (retention_marked_at)` on `audit_events`, member of no role (RT-353) |

The auth lookup credential exists because a device token, session, or bearer
token must be resolved before a tenant GUC can be established. It must not be
used by domain services.

A resolved device is accepted only while its tenant is active (RT-213). That
tenant-status read runs on the domain role, inside the device's own tenant
context, so the lookup role needs no grant on `tenants` and must not be given
one: with `BYPASSRLS` it would see every tenant row. The API refuses to boot if
the lookup role holds any privilege on `tenants` (`AUTH_LOOKUP_FORBIDDEN_GRANTS`).

## Before the first migration: `audit_retention_worker`

Migration `0005_audit_retention_privileges` grants the audit-retention
privileges to the role `audit_retention_worker`, and creates it (as `NOLOGIN`)
only when it does not exist yet. Creating a role needs `CREATEROLE`, and the
migration owner does not have it: it keeps least privilege (RT-345), so it is
also not a superuser (a superuser bypasses the `CREATEROLE` check). So a
superuser (on managed PostgreSQL, the provider's admin user or any role with
`CREATEROLE`) creates the role **once per database cluster, before the first
`migrate up`**.

The worker's retention sweep connects as this role through
`AUDIT_RETENTION_DATABASE_URL` (RT-353), so it is created with `LOGIN`. In
`psql`, set its password with `\password`, which prompts and sends only a
hash, so the password never appears in a command, the shell history or the
server log:

```sql
CREATE ROLE audit_retention_worker LOGIN;
\password audit_retention_worker
```

Store the resulting `AUDIT_RETENTION_DATABASE_URL` in the secret manager, like
the other database URLs.

Without the role, the first `migrate up` stops at 0005 with `permission denied
to create role`; the earlier migrations stay applied, and re-running after
creating the role resumes at 0005. 0005 then issues its grants, as the owner of
`audit_events` and of the database. Do not grant the role anything else: the
worker refuses to boot if it holds any other privilege on `audit_events`
(`MAINTAIN` included, on PostgreSQL 17+) or is a member of any role, even
without `INHERIT`.

**Existing databases** (deployed before RT-353). Before upgrading:

1. Give the role `LOGIN` and a password, once. Run this as a superuser or, on
   managed PostgreSQL, as the admin user that created the role (from
   PostgreSQL 16, `CREATEROLE` alone is not enough: the user also needs
   `ADMIN OPTION` on the role, which the role's creator has):

   ```sql
   ALTER ROLE audit_retention_worker LOGIN;
   \password audit_retention_worker
   ```

2. Check that the domain role cannot mark retention. As the table owner:

   ```sql
   SELECT has_column_privilege('<domain role>', 'audit_events', 'retention_marked_at', 'UPDATE');
   ```

   If it returns `t` (typical when the role was given DML on every table),
   revoke it. The API only inserts audit rows, and the append-only triggers
   (0034) refuse every other update or delete anyway:

   ```sql
   REVOKE UPDATE, DELETE ON audit_events FROM <domain role>;
   ```

   Otherwise the worker refuses to boot, and with it audit fan-out, sale
   processing, the outbox drainer and email.

3. Set `AUDIT_RETENTION_DATABASE_URL` in the secret manager and in
   `deploy/prod.env`. Until it is set, `docker compose` refuses every command
   for this file (its interpolation requires the variable), and a worker
   started without it refuses to boot in production.

Rolling 0005 back (`0005_audit_retention_privileges.down.sql`) revokes the
grants on `audit_events` and `public` and then drops the role, in one
transaction. The revokes need the objects' owner and the drop needs
`CREATEROLE`, so neither the migration owner nor a managed-PostgreSQL admin
user can run it alone:

- `migrate down` uses `MIGRATION_DATABASE_URL`, so roll 0005 back only with a
  true superuser connection.
- On managed PostgreSQL without a superuser, rolling 0005 back is not
  supported: leave it applied. It only adds the retention role's grants (and
  the role, if it did not exist); roll back the migrations above it as usual.
- After 0005 is rolled back, the role no longer exists, so the production
  worker refuses to boot (its retention boot check cannot connect). Re-create
  the role with `LOGIN` and a new password before 0005 is applied again, and
  update the stored `AUDIT_RETENTION_DATABASE_URL`.
- Roles are cluster-wide but grants are per database: if another database in
  the cluster still grants privileges to the role, `DROP ROLE` fails until
  those grants are revoked.

## Boot-time verification

In production (or with `VERIFY_DATABASE_POOL_BOUNDARY=1`) both processes check
their credentials before serving and refuse to start on a violation:

- **API, domain role:** it is not a superuser, does not have `BYPASSRLS`, is
  distinct from the lookup role, and holds every required table grant
  (RT-212, `DOMAIN_REQUIRED_GRANTS`). The required list starts with the tables
  whose grants are provisioned as a separate deploy step:
  - `cashier_admissions`: `SELECT`, `INSERT`, `UPDATE`
  - `cashier_admission_requests`: `SELECT`, `INSERT`, `UPDATE`, `DELETE`
  - `tenants`: `SELECT` (RT-213: POS device authentication reads the
    device's tenant status on this role)
  - `memberships`, `roles`: `SELECT` (RT-343: sign-in reads the user's
    memberships on this role, as `/context/me` does)
  - `shifts`: `SELECT`, `INSERT`, `UPDATE`; `shift_closes`,
    `shift_cash_movements`, `shift_refund_claims`: `SELECT`, `INSERT`
    (RT-17, migration 0036)
  - `erpnext_posting_resolution`: `SELECT`, `INSERT` (RT-330, migration 0037)

  A deploy that skips that grant step now fails to boot, and the error names
  each missing privilege and table, instead of starting healthy with those
  routes returning 500.
- **API, lookup role:** it is not a superuser, has `BYPASSRLS`, holds every
  grant listed below, and holds none of the forbidden grants (RT-143,
  `AUTH_LOOKUP_REQUIRED_GRANTS` / `AUTH_LOOKUP_FORBIDDEN_GRANTS`). The
  forbidden check covers every table privilege (`SELECT`, `INSERT`, `UPDATE`,
  `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`) on the sales, receivables,
  cashier-admission, shift cash-up (RT-17), tenants (RT-213), inventory, audit,
  idempotency and outbox tables, and every privilege except `SELECT` on `memberships` and
  `store_access` (RT-212).
  `TRUNCATE` matters most: it is not subject to row security.

  All three lists are in `apps/api/src/auth/database-pools.ts`.
- **Worker, domain role:** its `DATABASE_URL` role is not a superuser and does
  not have `BYPASSRLS` (RT-143), and cannot `UPDATE`
  `audit_events.retention_marked_at` (RT-353). The retention decision record
  allows the API's role only to read and insert audit rows. The API shares
  this role but does not run this check itself: in production the worker's
  check covers it, because both use the same `DATABASE_URL`. A deployment
  that runs the API without this worker, or with a different `DATABASE_URL`,
  is not covered. The check counts inherited privileges only, so a
  `NOINHERIT` membership in a role that can mark retention is not detected.
- **Worker, audit retention role:** its `AUDIT_RETENTION_DATABASE_URL` role is
  a different role from `DATABASE_URL`, is not a superuser, does not have
  `BYPASSRLS`, holds `SELECT` and `UPDATE (retention_marked_at)` on
  `audit_events`, holds no other privilege on that table, and is a member of
  no role (RT-353). Its grants on other tables are not checked: grant it
  nothing else.

  Both worker checks are in `apps/worker/src/database-role-verifier.ts`.

Provision the lookup login outside migrations because login credentials belong
to the deployment environment. A template with the exact grants and a verify
query is in [`sql/auth-lookup-role.sql`](sql/auth-lookup-role.sql); it holds no
password. Grant only the operations required by the auth boundary:

- `users`: `SELECT`, `UPDATE`
- `sessions`: `SELECT`, `INSERT`, `UPDATE`
- `auth_tokens`: `SELECT`, `INSERT`, `UPDATE`
- `devices`: `SELECT`
- `stores`: `SELECT` (resolve a supplied store id to its tenant before RLS)
- `external_identity_links`: `SELECT`
- `connector_registration`: `SELECT` (connector-token bootstrap only)
- `pairing_codes`: `SELECT` (anonymous pairing-code bootstrap only)

Tables protected by `FORCE ROW LEVEL SECURITY` require the lookup login to have
`BYPASSRLS`; the restricted table grants above are therefore the primary
privilege boundary for that credential. Never grant it access to sales,
receivables, inventory, audit, membership mutation, idempotency, or outbox
tables. The domain role remains `NOBYPASSRLS` and is the only pool injected into
tenant/domain services.

## Domain-role grants for new tables

Runtime grants are provisioned outside migrations, so a migration that adds a
table the domain role must use needs a matching grant step at deploy time.

- **Migration `0035_cashier_admissions` (RT-113 BC2).** Run
  [`sql/cashier-admissions-domain-grants.sql`](sql/cashier-admissions-domain-grants.sql)
  after `migrate up` and before the API starts. That is step 2 of the deploy
  sequence in [`deploy/README.md`](../../deploy/README.md#deploy).
  `-v domain_role=<role>` is required. It grants the domain role:
  - `cashier_admissions`: `SELECT`, `INSERT`, `UPDATE`
  - `cashier_admission_requests`: `SELECT`, `INSERT`, `UPDATE`, `DELETE`
  - `tenants`: `SELECT` (RT-213). Every device-authenticated POS request
    reads its tenant's status on the domain role; without this grant every
    till would be refused at once, so the API refuses to boot instead.

  The script runs with `ON_ERROR_STOP` and exits non-zero if a grant fails or
  if the verification finds a missing grant. Without these grants the API
  refuses to boot (`DOMAIN_REQUIRED_GRANTS`, see
  [Boot-time verification](#boot-time-verification)).

  The auth lookup role must hold no privilege on either table, nor on
  `tenants` (RT-213). The API refuses to boot if it holds any table privilege
  on one, `TRUNCATE`, `REFERENCES` and `TRIGGER` included. Pass
  `-v lookup_role=<role>` to the script to run the same check at deploy time.

- **Migration `0036_shift_cash_up` (RT-17).** Run
  [`sql/shift-cash-up-domain-grants.sql`](sql/shift-cash-up-domain-grants.sql)
  after `migrate up` and before the API starts, in the same step 2 of
  [`deploy/README.md`](../../deploy/README.md#deploy), with the same
  `-v domain_role=<role>`. It grants the domain role:
  - `shifts`: `SELECT`, `INSERT`, `UPDATE`. `UPDATE` is needed because a
    close moves the shift to closed, an open may adopt the audit-ingest row
    of the same shift, and the 0036 triggers lock the shift row
    `FOR SHARE` / `FOR UPDATE`, which requires `UPDATE`. No `DELETE`: a
    cash-up shift is never deleted.
  - `shift_closes`, `shift_cash_movements`, `shift_refund_claims`: `SELECT`,
    `INSERT`. They are append-only for every role.

  It runs with `ON_ERROR_STOP` and exits non-zero if a grant fails or the
  verification finds a missing grant. Without these grants the API refuses
  to boot (`DOMAIN_REQUIRED_GRANTS`). The auth lookup role must hold no
  privilege on any of the four tables (`AUTH_LOOKUP_FORBIDDEN_GRANTS`); pass
  `-v lookup_role=<role>` to run the same check at deploy time.

- **Migration `0037_erpnext_posting_resolution` (RT-330).** Run
  [`sql/erpnext-posting-resolution-domain-grants.sql`](sql/erpnext-posting-resolution-domain-grants.sql)
  after `migrate up` and before the API starts, in the same step 2 of
  [`deploy/README.md`](../../deploy/README.md#deploy), with the same
  `-v domain_role=<role>`. It grants the domain role `SELECT`, `INSERT` on
  `erpnext_posting_resolution`, which is append-only for every role (a
  correction is a new `resolution_version`). The worker freezes each posting
  intent's resolution with it, and the connector feed and posting repair read
  it. Without the grants the API refuses to boot (`DOMAIN_REQUIRED_GRANTS`).
  After the new release is up, deploy step 4 runs
  [`sql/erpnext-posting-resolution-catchup.sql`](sql/erpnext-posting-resolution-catchup.sql)
  as the migration owner: it re-runs the idempotent 0038 backfill to freeze
  any intent the previous release's worker or repair wrote during the
  migration.

- **Sign-in memberships (RT-343).** Run
  [`sql/signin-memberships-domain-grants.sql`](sql/signin-memberships-domain-grants.sql)
  in the same step 2, with the same `-v domain_role=<role>`. It grants the
  domain role `SELECT` on `memberships` and `roles`: sign-in reads the user's
  memberships on this role (as `/context/me` does). Without the grants the API
  refuses to boot (`DOMAIN_REQUIRED_GRANTS`) rather than failing every Console
  sign-in with 500.

## Redis credential

`docker-compose.prod.yml` requires `REDIS_PASSWORD` and starts Redis with
`requirepass`. The password is written to a mode-600 config file inside the
container and removed from the server's environment before `redis-server`
starts, so it does not appear in the process command line or the logs. It is
still visible to anyone who can run `docker inspect` on the host, like the
database URLs; restrict Docker access on the host accordingly.

## audit_events is append-only for every role

Migration `0034_audit_events_append_only` (RT-133) adds triggers that refuse
`UPDATE`, `DELETE` and `TRUNCATE` on `audit_events` for **every** role,
including the domain role, the platform-admin GUC path and the table owner.
Grants alone cannot provide this guarantee, because runtime role grants are
provisioned outside migrations. Only two writes besides `INSERT` remain:

- **Retention marking:** `retention_marked_at` may be set once, from `NULL` to
  a timestamp, with every other column unchanged. The column grant from
  `0005_audit_retention_privileges` keeps this to `audit_retention_worker`,
  which the worker's sweep connects as (`AUDIT_RETENTION_DATABASE_URL`,
  RT-353). The trigger itself allows the marker write for any role, so the
  worker refuses to boot if the domain role holds that `UPDATE`.
  Retention never deletes audit rows.
- **`ON DELETE SET NULL`:** hard-deleting a referenced user or store nulls
  `actor_user_id` / `store_id` through the foreign key's referential action.
  The audit row itself is kept.

Anything else fails with SQLSTATE `42501` and an `append-only` message.
Break-glass requires a deliberate DDL step (dropping or disabling the
triggers), performed with the migration credential, never from the API or
worker.
