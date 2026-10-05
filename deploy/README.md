# Backend-Core Deploy Template

Deploys the Backend-Core backend (`api` + `worker`) onto `<app-host>`, behind
`api.example.test`, using `<managed-db>` for PostgreSQL and `<redis-service>` for
Redis.

This public template intentionally avoids real deployment names. Real hostnames,
service names, secret-manager references, and provider-specific values belong in
private ops config or the host environment, not public git.

## Topology

```
Internet -> 443 -> Caddy (TLS) -> api:3000 (NestJS)
                                  |-> <redis-service>:6379 (BullMQ, sessions, locks)
                                  `-> <managed-db> (PostgreSQL, SSL required)
worker -> <redis-service> + <managed-db>
migrate (one-shot) -> <managed-db>  (runs before api/worker)
```

PostgreSQL is expected to be an external managed service, not a container in this
compose stack. Redis is containerized by default.

## Prerequisites

1. Docker + Compose v2 installed on `<app-host>`.
2. Firewall: ports 80 + 443 inbound open where Caddy will terminate TLS.
3. DNS: `api.example.test` points to `<app-host>`.
4. `<managed-db>` allows connections from `<app-host>`.
5. A secret manager or host-level environment injection mechanism is available.
   If using 1Password CLI (`op`), authenticate it outside public git:
   ```bash
   export OP_SERVICE_ACCOUNT_TOKEN=...   # set on the host; never commit this value
   op whoami                              # verify
   ```
6. A `deploy/prod.env` (copied from `deploy/prod.env.example`) containing only
   secret-manager references plus non-secret config. Do not commit real values.
7. Three distinct database roles on `<managed-db>` (migration owner, domain
   runtime, auth lookup), provisioned per
   [`docs/operations/database-roles.md`](../docs/operations/database-roles.md).
   Create the lookup role from
   [`docs/operations/sql/auth-lookup-role.sql`](../docs/operations/sql/auth-lookup-role.sql)
   after the first `migrate up`. The API and worker refuse to boot when a role's
   posture or grants are wrong.

## Deploy

```bash
gh repo clone <owner>/<repo>                    # or: git pull on an existing clone
cd Backend-Core
git checkout <deploy-ref>                       # the reconciled origin/main commit being deployed

cp deploy/prod.env.example deploy/prod.env      # then set private references/values
cp deploy/grants.env.example deploy/grants.env  # then set private references/values
```

Then run the release sequence. Use it for the first deploy **and** for every
redeploy of a new ref:

```bash
# 1. Apply migrations on their own first.
op run --env-file=deploy/prod.env -- \
  docker compose -f docker-compose.prod.yml run --rm --build migrate

# 2. Domain-role grants for tables added by migrations. Runtime grants are not
#    part of migrations (docs/operations/database-roles.md). The scripts are
#    idempotent; run them on every deploy. Each one exits non-zero on failure,
#    so stop here if one does. psql takes the migration-owner connection from
#    the PG* variables in deploy/grants.env, never from a command-line URL.
op run --env-file=deploy/grants.env -- sh -c \
  'psql -X -v domain_role="$DOMAIN_DB_ROLE" \
        -f docs/operations/sql/cashier-admissions-domain-grants.sql'

# 3. Start everything (migrate re-runs as a no-op, then api/worker start).
op run --env-file=deploy/prod.env -- \
  docker compose -f docker-compose.prod.yml up -d --build
```

`op run` resolves private references into the container env in memory only. The
`migrate` service runs `migrate up` against `<managed-db>` and must exit 0 before
`api`/`worker` start (compose `service_completed_successfully` gate).

Step 2 must run between the migration and the app start. The API boot check
verifies the domain role's cashier-admissions table grants (RT-212) and its
`SELECT` on `tenants`, which POS device authentication reads (RT-213). If
step 2 is skipped, the API refuses to start, and the error names each missing
grant.

Step 2 needs a `psql` client on the deploy host. It reads the connection from
`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` and `PGSSLMODE` in
`deploy/grants.env`, which uses the same migration-owner credential as
`MIGRATION_DATABASE_URL`. Never pass that URL to `psql` as an argument: the
full command line, password included, is readable by other users through
`/proc/<pid>/cmdline`. `DOMAIN_DB_ROLE` is the role name in `DATABASE_URL`; it
is a name, not a secret.

## Verify

```bash
docker compose -f docker-compose.prod.yml ps          # all healthy; migrate Exited(0)
curl -sS https://api.example.test/api/v1/health/live    # {"status":"ok"}: the edge and the process are up
curl -sS https://api.example.test/api/v1/health/ready   # 200 ready / 503 not_ready, with per-check ok|failed
op run --env-file=deploy/prod.env -- \
  docker compose -f docker-compose.prod.yml run --rm migrate node dist/cli/migrate.js status
```

## Operations

```bash
# logs
docker compose -f docker-compose.prod.yml logs -f api
# redeploy a new ref: pull, then run the full release sequence from "Deploy"
# (1. migrate, 2. grants, 3. up). A bare `up` skips the grant step.
git pull
op run --env-file=deploy/prod.env -- docker compose -f docker-compose.prod.yml run --rm --build migrate
op run --env-file=deploy/grants.env -- sh -c \
  'psql -X -v domain_role="$DOMAIN_DB_ROLE" -f docs/operations/sql/cashier-admissions-domain-grants.sql'
op run --env-file=deploy/prod.env -- docker compose -f docker-compose.prod.yml up -d --build
# stop
docker compose -f docker-compose.prod.yml down            # keeps volumes (redis AOF, caddy certs)
```

### Worker schedules

The worker registers its repeatable jobs in Redis at boot. Each schedule is
idempotent, so restarts and replicas share one schedule.

| Job | Default cadence | Override |
|---|---|---|
| Audit retention sweep | 24 h | none |
| Outbox retention sweep | 24 h | none |
| ERPNext stock reconciliation run sweep (RT-179) | 24 h | `ERPNEXT_STOCK_RECONCILIATION_SWEEP_INTERVAL_MS` |
| Cashier-admission replay purge (RT-209) | 1 h | `CASHIER_ADMISSION_REPLAY_PURGE_INTERVAL_MS` |

The stock sweep creates one `scheduled` stock reconciliation run for every store
that has an active `stock` warehouse map. A store is skipped when it already has
a `running` stock run, or when it already has a scheduled run in the current
period. It is also skipped when, at creation time, its tenant is no longer
active, the store is inactive or deleted, or its stock map is retired; the
sweep re-checks these with row locks just before creating the run. Periods are the interval aligned to the Unix epoch. For the daily
default, that is the UTC day. Ticks are anchored on those boundaries: a new
schedule first fires at the next boundary (for the daily default, the next UTC
midnight), and each tick counts for the period it was scheduled in even if it
is processed late. The run then waits for the connector's Bin
snapshot, the same as an on-demand run.

`ERPNEXT_STOCK_RECONCILIATION_SWEEP_INTERVAL_MS` must be a whole number of
milliseconds, at least `300000` (5 minutes). Any other value stops the worker
from booting. `docker-compose.prod.yml` does not pass this variable to the
worker yet, so production runs the daily default. To override it, add it to
the worker's `environment` block.

The replay purge deletes every tenant's expired `cashier_admission_requests`
rows, in batches of 500, under each tenant's own RLS context. These rows hold
the replayable `admitted` response, including the cashier's display name, and
the api stops replaying a row once it expires. Before this sweep, the api
deleted a device's expired rows only when that same device saved another
request. The purge uses the worker's `DATABASE_URL` (domain) role and needs no
grant beyond those the api already has on that table (`SELECT`, `INSERT`,
`UPDATE`, `DELETE`) and `SELECT` on `tenants`. It logs counts only.
`CASHIER_ADMISSION_REPLAY_PURGE_INTERVAL_MS` must be a whole number of
milliseconds, at least `60000` (1 minute). Any other value stops the worker
from booting. `docker-compose.prod.yml` does not pass it, so production runs
the hourly default.

## Known follow-ups (not in this artifact)

- **Hardening:** run containers as a non-root user; add resource limits; offsite backups
  for `<managed-db>`; monitoring/alerting; log shipping.
- **Console** (`<console-host>`) is a separate later deployment.
