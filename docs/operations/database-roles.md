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

## Boot-time verification

In production (or with `VERIFY_DATABASE_POOL_BOUNDARY=1`) both processes check
their credentials before serving and refuse to start on a violation:

- **API, domain role:** it is not a superuser, does not have `BYPASSRLS`, is
  distinct from the lookup role, and holds every required table grant
  (RT-212, `DOMAIN_REQUIRED_GRANTS`). The required list starts with the tables
  whose grants are provisioned as a separate deploy step:
  - `cashier_admissions`: `SELECT`, `INSERT`, `UPDATE`
  - `cashier_admission_requests`: `SELECT`, `INSERT`, `UPDATE`, `DELETE`

  A deploy that skips that grant step now fails to boot, and the error names
  each missing privilege and table, instead of starting healthy with those
  routes returning 500.
- **API, lookup role:** it is not a superuser, has `BYPASSRLS`, holds every
  grant listed below, and holds none of the forbidden grants (RT-143,
  `AUTH_LOOKUP_REQUIRED_GRANTS` / `AUTH_LOOKUP_FORBIDDEN_GRANTS`). The
  forbidden check covers every table privilege (`SELECT`, `INSERT`, `UPDATE`,
  `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`) on the sales, receivables,
  cashier-admission, inventory, audit, idempotency and outbox tables, and every
  privilege except `SELECT` on `memberships` and `store_access` (RT-212).
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
