# Database runtime roles

Production uses three independent PostgreSQL credentials.

| Environment variable | Purpose | Required posture |
| --- | --- | --- |
| `MIGRATION_DATABASE_URL` | One-shot schema migration | DDL-capable owner; never injected into API or worker |
| `DATABASE_URL` | Tenant/domain runtime | Non-superuser, `NOBYPASSRLS`; tenant access only inside `runWithTenantContext` |
| `AUTH_LOOKUP_DATABASE_URL` | Pre-tenant authentication/bootstrap | Distinct non-superuser role with only the table operations listed below |

The auth lookup credential exists because a device token, session, or bearer
token must be resolved before a tenant GUC can be established. It must not be
used by domain services. The API verifies at startup that the domain role is
not a superuser, does not have `BYPASSRLS`, and is distinct from the lookup
role.

Provision the lookup login outside migrations because login credentials belong
to the deployment environment. Grant only the operations required by the auth
boundary:

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
