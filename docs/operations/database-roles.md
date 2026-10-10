# Database runtime roles

Production uses three independent PostgreSQL credentials.

| Environment variable | Purpose | Required posture |
| --- | --- | --- |
| `MIGRATION_DATABASE_URL` | One-shot schema migration | DDL-capable owner; never injected into API or worker |
| `DATABASE_URL` | Tenant/domain runtime | Non-superuser, `NOBYPASSRLS`; tenant access only inside `runWithTenantContext` |
| `AUTH_LOOKUP_DATABASE_URL` | Pre-tenant authentication/bootstrap | Distinct non-superuser role with only the table operations listed below |

The auth lookup credential exists because a device token, session, or bearer
token must be resolved before a tenant GUC can be established. It must not be
used by domain services.

A resolved device is accepted only while its tenant is active (RT-213). That
tenant-status read runs on the domain role, inside the device's own tenant
context, so the lookup role needs no grant on `tenants` and must not be given
one: with `BYPASSRLS` it would see every tenant row. The API refuses to boot if
the lookup role holds any privilege on `tenants` (`AUTH_LOOKUP_FORBIDDEN_GRANTS`).

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
- **Worker:** its `DATABASE_URL` role is not a superuser and does not have
  `BYPASSRLS` (RT-143, `apps/worker/src/database-role-verifier.ts`).

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
  `0005_audit_retention_privileges` keeps this to `audit_retention_worker`.
  Retention never deletes audit rows.
- **`ON DELETE SET NULL`:** hard-deleting a referenced user or store nulls
  `actor_user_id` / `store_id` through the foreign key's referential action.
  The audit row itself is kept.

Anything else fails with SQLSTATE `42501` and an `append-only` message.
Break-glass requires a deliberate DDL step (dropping or disabling the
triggers), performed with the migration credential, never from the API or
worker.
