# Database runtime roles

Production uses four independent PostgreSQL credentials.

| Environment variable | Purpose | Required posture |
| --- | --- | --- |
| `MIGRATION_DATABASE_URL` | One-shot schema migration | DDL-capable owner, `NOSUPERUSER NOCREATEROLE`; never injected into API or worker |
| `DATABASE_URL` | Tenant/domain runtime | Non-superuser, `NOBYPASSRLS`; tenant access only inside `runWithTenantContext`; no `UPDATE` or `DELETE` on `audit_events` (the worker's boot check enforces no `UPDATE` on `retention_marked_at`, RT-353) |
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
without `INHERIT` or `SET` (a conservative rule: such a membership could
otherwise reach more privileges through `SET ROLE`).

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

   Re-run the check. A `REVOKE` removes only grants made to that role
   directly: if the check still returns `t`, the privilege comes from
   `PUBLIC` or from a role the domain role inherits (see `\dp audit_events`
   and `\drg <domain role>` in `psql`), so revoke it there.

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
their credentials before serving and refuse to start on a violation.

Every check below first requires the URL to log in as the checked role itself
(`session_user = current_user`, RT-357). A URL that logs in as another role and
switches with `options=-c role=…` is refused, naming the variable: every other
check reads `current_user`, which would pass, while `RESET ROLE` would restore
the login's own privileges (a superuser, `BYPASSRLS`, or the migration owner).
Legitimate deployments never set a role option.

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
  - `sale_reprints`: `SELECT`, `INSERT` (RT-539, migration 0047)
  - `devices`: `UPDATE` (RT-365: the Console device revoke)
  - `pairing_codes`: `SELECT`, `INSERT`, `UPDATE` (RT-367: the Console
    pairing codes and the redemption)
  - `sale_responsibilities`: `SELECT`, `INSERT`; `payer_account`: `SELECT`,
    `INSERT`, `UPDATE` (RT-418, migration 0051)
  - `cash_variance_policy_revisions`, `shift_close_approver_checks`: `SELECT`,
    `INSERT` (RT-387, migration 0050)

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
  is not covered. As a conservative rule, the check also refuses a role
  that is a member, even without `INHERIT`, of any role that can mark
  retention. Such a membership can reach the privilege through `SET ROLE`
  unless it was granted `WITH SET FALSE` (PostgreSQL 16+); the check does not
  make that distinction.
- **Worker, audit retention role:** its `AUDIT_RETENTION_DATABASE_URL` login is
  the role itself (RT-353, the first such check), reaches
  the same database as `DATABASE_URL` (same name, OID and server), is a
  different role from `DATABASE_URL`, is not a superuser, does not have
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
- `pairing_codes`: `SELECT` (anonymous pairing-code bootstrap only; every
  other privilege is forbidden and fails boot, RT-367)

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

- **Migration `0042_inventory_effects_journal` (RT-425).** Run
  [`sql/inventory-effect-integration-domain-grants.sql`](sql/inventory-effect-integration-domain-grants.sql)
  after `migrate up` and before the API starts, in the same step 2 of
  [`deploy/README.md`](../../deploy/README.md#deploy), with the same
  `-v domain_role=<role>`. It grants the domain role `SELECT`, `INSERT` and
  `UPDATE` on `inventory_effect_integration`, the mutable per-effect
  integration state (it has no `DELETE` policy; never grant `DELETE` or
  `TRUNCATE`). Every manual movement, transfer and count writes its effect's
  record with it, and the movement list reads it. Without the grants the API
  refuses to boot (`DOMAIN_REQUIRED_GRANTS`). The auth lookup role must hold
  no privilege on it (`AUTH_LOOKUP_FORBIDDEN_GRANTS`). After the new release
  is up, deploy step 4 runs
  [`sql/inventory-effect-integration-catchup.sql`](sql/inventory-effect-integration-catchup.sql)
  as the migration owner: it re-runs the idempotent 0043 backfill to record
  `not_posted` for any movement the previous release wrote during the
  migration.

- **Migration `0044_stock_locations_position_grain` (RT-432).** Run
  [`sql/stock-locations-domain-grants.sql`](sql/stock-locations-domain-grants.sql)
  after `migrate up` and before the API starts, in the same step 2 of
  [`deploy/README.md`](../../deploy/README.md#deploy), with the same
  `-v domain_role=<role>`. It grants the domain role `SELECT` and `INSERT` on
  `stock_locations`. Every manual movement, transfer and count resolves its
  effect's stock location with `SELECT`, and the movement list, on-hand and
  location list read it. `INSERT` is used only by the
  `stores_create_primary_location` trigger, which creates a store's primary
  location in the store's own transaction under the inserting role. The table
  has no `UPDATE` or `DELETE` policy and a location's identity is immutable;
  never grant `UPDATE`, `DELETE` or `TRUNCATE`. Without the grants the API
  refuses to boot (`DOMAIN_REQUIRED_GRANTS`). The auth lookup role must hold no
  privilege on it (`AUTH_LOOKUP_FORBIDDEN_GRANTS`). 0044 makes a location and
  status mandatory on every new movement, so between step 1 and step 3 an
  inventory write from the previous release is rejected (nothing is written);
  there is no catch-up step. Run it in the maintenance window 0042 requires.

- **Migration `0045_tracking_foundation` (RT-448).** Run
  [`sql/tracking-foundation-domain-grants.sql`](sql/tracking-foundation-domain-grants.sql)
  after `migrate up` and before the API starts, in the same step 2 of
  [`deploy/README.md`](../../deploy/README.md#deploy), with the same
  `-v domain_role=<role>`. It grants the domain role `SELECT` on
  `tracking_identities`, which the tracking-identity list reads. Nothing writes
  identities or `erpnext_tracking_map` in this release (identity birth is
  RT-453), so no `INSERT` and no edge-map privilege is granted yet. Neither
  table has an `UPDATE` or `DELETE` policy; never grant `UPDATE`, `DELETE` or
  `TRUNCATE`. Without the grant the API refuses to boot
  (`DOMAIN_REQUIRED_GRANTS`). The auth lookup role must hold no privilege on
  either table (`AUTH_LOOKUP_FORBIDDEN_GRANTS`). The Tracking Profile columns
  live on `tenant_products`, which the domain role already reads and writes.
  0045 needs no maintenance window: its new columns have defaults or are
  nullable, and the previous release keeps working.

- **Sign-in memberships (RT-343).** Run
  [`sql/signin-memberships-domain-grants.sql`](sql/signin-memberships-domain-grants.sql)
  in the same step 2, with the same `-v domain_role=<role>`. It grants the
  domain role `SELECT` on `memberships` and `roles`: sign-in reads the user's
  memberships on this role (as `/context/me` does). Without the grants the API
  refuses to boot (`DOMAIN_REQUIRED_GRANTS`) rather than failing every Console
  sign-in with 500.

- **Migration `0047_sale_history_capture` (RT-538 storage, RT-539 runtime).** Run
  [`sql/sale-reprints-domain-grants.sql`](sql/sale-reprints-domain-grants.sql)
  after `migrate up` (0047 and 0048) and before the API starts, in the same
  step 2 of [`deploy/README.md`](../../deploy/README.md#deploy), with the same
  `-v domain_role=<role>`. It grants the domain role `SELECT` and `INSERT` on
  `sale_reprints`, the append-only receipt reprint record: `recordSaleReprint`
  writes one row per reprint and reads the sale's rows for the next server copy
  number. The table has no `UPDATE` or `DELETE` policy; never grant `UPDATE`,
  `DELETE` or `TRUNCATE`. Without the grants the API refuses to boot
  (`DOMAIN_REQUIRED_GRANTS`). The auth lookup role must hold no privilege on it
  (`AUTH_LOOKUP_FORBIDDEN_GRANTS`). The new `sales.receipt_*` and
  `sale_lines.line_seq` columns live on tables the domain role already reads
  and writes.

- **Migration `0051_sale_responsibilities` (RT-418).** Run
  [`sql/sale-responsibilities-domain-grants.sql`](sql/sale-responsibilities-domain-grants.sql)
  after `migrate up` and before the API and worker start, in the same step 2
  of [`deploy/README.md`](../../deploy/README.md#deploy), with the same
  `-v domain_role=<role>`. It grants the domain role `SELECT` and `INSERT` on
  `sale_responsibilities` (part of the immutable sale fact: a credit capture
  writes it; the sale read and the posting feed and worker read it) and
  `SELECT`, `INSERT` and `UPDATE` on `payer_account` (the Console payer
  routes list, create and, from RT-572, update payers; a credit capture
  locks its payer row `FOR SHARE`, which also needs `UPDATE`). Never grant `UPDATE`, `DELETE` or `TRUNCATE` on
  `sale_responsibilities`, nor `DELETE` or `TRUNCATE` on `payer_account`.
  Without the grants the API refuses to boot (`DOMAIN_REQUIRED_GRANTS`). The
  auth lookup role must hold no privilege on `sale_responsibilities`
  (`AUTH_LOOKUP_FORBIDDEN_GRANTS`). The new `sales.responsibility_count` and
  `erpnext_posting_resolution.payer_external_ref` columns live on tables the
  domain role already reads and writes.

- **Shift variance policy (RT-387, on migration `0050_shift_variance_policy`).**
  Run
  [`sql/shift-variance-policy-domain-grants.sql`](sql/shift-variance-policy-domain-grants.sql)
  after `migrate up` and before the API starts, in the same step 2 of
  [`deploy/README.md`](../../deploy/README.md#deploy), with the same
  `-v domain_role=<role>`. It grants the domain role `SELECT` and `INSERT` on
  `cash_variance_policy_revisions` (the Console publishes revisions; the POS
  policy read, the Console reads and the cash-up open's accept-and-flag check
  read them) and on `shift_close_approver_checks` (a close's approver verdict,
  written once after the commit and read back by the close replay and the
  admin shift-close reads). Both tables are append-only: never grant `UPDATE`,
  `DELETE` or `TRUNCATE`. Without the grants the API refuses to boot
  (`DOMAIN_REQUIRED_GRANTS`). The auth lookup role must hold no privilege on
  either (`AUTH_LOOKUP_FORBIDDEN_GRANTS`). The new `shifts.frozen_policy_*`
  and `shift_closes.approval_*` columns live on tables the domain role already
  reads and writes.

- **AI entitlements (RT-664, on migration `0055_ai_entitlements_usage`) —
  OWNER-GATED.** [`sql/ai-entitlements-domain-grants.sql`](sql/ai-entitlements-domain-grants.sql)
  grants the domain role `SELECT` on the three code-owned catalogue tables
  (`ai_plan_catalog`, `ai_plan_catalog_features`, `ai_plan_catalog_meters`;
  never `INSERT`: a catalogue version is a migration), `SELECT` and `INSERT`
  on `tenant_ai_entitlements` (platform-admin revisions), on
  `tenant_ai_feature_opt_outs` (the owner's opt-out chain) and on
  `ai_usage_ledger` (append-only: never `UPDATE`; the runtime serialises
  terminal writes and adjustments on advisory locks, not row locks), and
  `SELECT`, `INSERT` and `UPDATE` on `ai_usage_counters`. Never `DELETE` or
  `TRUNCATE` on any of them. The worker's reservation sweep uses the same
  grants. Unlike the scripts above, it is NOT part of the routine step 2: running it
  on any lab or live database is a separate owner decision (the owner chose
  this on 2026-10-20). The tables are NOT in `DOMAIN_REQUIRED_GRANTS`, so the
  API boots without them. Until the script runs, the AI entitlement read and
  opt-out answer 503 `entitlement_unavailable`, and every AI gateway run
  fails closed with `entitlement_unavailable` and no provider call. The auth
  lookup role needs no privilege on any of them.

- **Migration `0054_sale_credit_reversals` (RT-577).** Run
  [`sql/sale-credit-reversals-domain-grants.sql`](sql/sale-credit-reversals-domain-grants.sql)
  after `migrate up` and before the API starts, in the same step 2 of
  [`deploy/README.md`](../../deploy/README.md#deploy), with the same
  `-v domain_role=<role>`. It grants the domain role `SELECT` and `INSERT` on
  `sale_credit_reversals` and `sale_credit_reversal_tenders` (a credit
  reversal writes them; its projection and replay read them) and on
  `sale_approval_uses` (the shared single-use ledger of approval ids: a
  cash-paying credit return writes its id and reads the ledger). All three are
  append-only: never grant `UPDATE`, `DELETE` or `TRUNCATE`. A void's ledger
  row is written by the `SECURITY DEFINER` trigger
  `sale_voids_record_approval_use`, so voids recorded between `migrate up` and
  the grants keep working. Without the grants the API refuses to boot
  (`DOMAIN_REQUIRED_GRANTS`). The auth lookup role must hold no privilege on
  any of them (`AUTH_LOOKUP_FORBIDDEN_GRANTS`).

- **Migration `0056_inventory_position_events` (RT-435).** Run
  [`sql/inventory-position-events-domain-grants.sql`](sql/inventory-position-events-domain-grants.sql)
  after `migrate up` and before the API starts, in the same step 2 of
  [`deploy/README.md`](../../deploy/README.md#deploy), with the same
  `-v domain_role=<role>`. It grants the domain role `SELECT` and `INSERT` on
  `inventory_position_events` (a status move or relocation writes its event
  record; a replay reads it back) and `SELECT`, `INSERT` and `UPDATE` on
  `tenant_inventory_settings` (the return landing policy is read and
  upserted). The event record is append-only: never grant `UPDATE`, `DELETE`
  or `TRUNCATE` on it; never grant `DELETE` or `TRUNCATE` on the settings.
  Without the grants the API refuses to boot (`DOMAIN_REQUIRED_GRANTS`). The
  auth lookup role must hold no privilege on either
  (`AUTH_LOOKUP_FORBIDDEN_GRANTS`). 0056 needs no maintenance window: both
  tables are new and only the new routes use them.

- **Console device revoke (RT-365, on migration `0040_device_lifecycle`).** Run
  [`sql/device-lifecycle-domain-grants.sql`](sql/device-lifecycle-domain-grants.sql)
  after `migrate up` and before the API starts, in the same step 2 of
  [`deploy/README.md`](../../deploy/README.md#deploy), with the same
  `-v domain_role=<role>`. It grants the domain role `UPDATE` on `devices`:
  `POST /api/v1/devices/{deviceId}/revoke` locks the device row `FOR UPDATE`
  and sets the revoke fields. No earlier domain path wrote `devices`, so an
  environment provisioned before RT-365 lacks it. Equivalent statement:
  `GRANT UPDATE ON devices TO <DATABASE_URL role>;`. Never grant `DELETE` or
  `TRUNCATE`. Without the grant the API refuses to boot
  (`DOMAIN_REQUIRED_GRANTS`) rather than failing every revoke with 500. The
  shift-open path does not need it (its device lifecycle lock is an advisory
  lock).

- **Console pairing codes (RT-367, on migrations `0024` / `0040`).** The same
  script also grants the domain role `SELECT`, `INSERT`, `UPDATE` on
  `pairing_codes`. `INSERT` is new: `POST /api/v1/pairing-codes` issues a code
  as the domain role, where until RT-367 only the owner-run CLI inserted codes
  as the table owner. `SELECT` serves the list, the cancel and the
  one-replacement check; `UPDATE` the cancel and the redemption's attempt
  count and burn. Equivalent statement:
  `GRANT SELECT, INSERT, UPDATE ON pairing_codes TO <DATABASE_URL role>;`.
  Never grant `DELETE` or `TRUNCATE` (spent codes are retained). Without it
  the API refuses to boot (`DOMAIN_REQUIRED_GRANTS`) rather than failing every
  issue with 500. The lookup role keeps `SELECT` only on `pairing_codes`
  (`AUTH_LOOKUP_FORBIDDEN_GRANTS`).

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
