# Backend-Core Deploy Template

Deploys the Backend-Core backend (`api` + `worker`) onto `<app-host>`, behind
`api.example.test`, using `<managed-db>` for PostgreSQL and `<redis-service>` for
Redis. The same Caddy origin also serves the Admin Console (RT-336): `/api/*`
goes to the API and every other path to the pinned Console release.

This public template intentionally avoids real deployment names. Real hostnames,
service names, secret-manager references, and provider-specific values belong in
private ops config or the host environment, not public git.

## Topology

```
Internet -> 443 -> Caddy (TLS, one origin)
                   |-> /api, /api/*  -> api:3000 (NestJS)
                   |                    |-> <redis-service>:6379 (BullMQ, sessions, locks)
                   |                    `-> <managed-db> (PostgreSQL, SSL required)
                   `-> everything else -> /srv/console/current (Admin Console static release)
worker -> <redis-service> + <managed-db>
migrate (one-shot) -> <managed-db>  (runs before api/worker)
```

The Admin Console calls the API on its own origin with the `dp2_session` cookie,
so CORS stays off (`ALLOWED_ORIGINS` empty) and no cross-origin auth is needed.

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
8. An Admin Console releases directory on `<app-host>` (for example
   `/opt/dp2-console`), set as `CONSOLE_RELEASES_DIR` in `deploy/prod.env`. Compose
   refuses to start without it. It must hold at least one verified release and a
   `current` symlink before the first `up`: run steps 1-3 of
   [Admin Console release](#admin-console-release) first, and its smoke test (step 4)
   after `up`.

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
        -f docs/operations/sql/cashier-admissions-domain-grants.sql &&
   psql -X -v domain_role="$DOMAIN_DB_ROLE" \
        -f docs/operations/sql/shift-cash-up-domain-grants.sql &&
   psql -X -v domain_role="$DOMAIN_DB_ROLE" \
        -f docs/operations/sql/erpnext-posting-resolution-domain-grants.sql'

# 3. Start everything (migrate re-runs as a no-op, then api/worker start).
op run --env-file=deploy/prod.env -- \
  docker compose -f docker-compose.prod.yml up -d --build

# 4. Freeze any posting intent the previous release wrote during step 1
#    (RT-330). Idempotent; exits non-zero on failure.
op run --env-file=deploy/grants.env -- \
  psql -X -f docs/operations/sql/erpnext-posting-resolution-catchup.sql
```

`op run` resolves private references into the container env in memory only.
Run every `docker compose -f docker-compose.prod.yml` command under it, including
`ps`, `logs` and `down`, which only inspect or stop containers. Compose resolves
the file's required `${VAR:?...}` variables whenever it loads the project, so
without the env loader any command fails with
`required variable ... is missing a value`. The `migrate` service runs
`migrate up` against `<managed-db>` and must exit 0 before `api`/`worker` start
(compose `service_completed_successfully` gate).

Step 2 must run between the migration and the app start. The API boot check
verifies the domain role's cashier-admissions table grants (RT-212), its
`SELECT` on `tenants`, which POS device authentication reads (RT-213), and its
shift cash-up table grants (RT-17, migration 0036). If step 2 is skipped, the
API refuses to start, and the error names each missing grant.

Step 2 needs a `psql` client on the deploy host. It reads the connection from
`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` and `PGSSLMODE` in
`deploy/grants.env`, which uses the same migration-owner credential as
`MIGRATION_DATABASE_URL`. Never pass that URL to `psql` as an argument: the
full command line, password included, is readable by other users through
`/proc/<pid>/cmdline`. `DOMAIN_DB_ROLE` is the role name in `DATABASE_URL`; it
is a name, not a secret.

## Admin Console release

The Admin Console is a static bundle built and published by `Kemetra/Admin-Console`
(RT-337): release tag `admin-console-<sha12>` with `admin-console-<sha12>.tar.gz`
and its `.sha256`. Caddy serves `/srv/console/current`, which is a **relative**
symlink inside `CONSOLE_RELEASES_DIR`, so a release or rollback is a symlink swap
with no Caddy restart (and no interruption of API or POS traffic).

Run this from the Backend-Core checkout. `op run` passes `deploy/prod.env` only
to its child process, so set the (non-secret) directory explicitly here, with
the same value as `CONSOLE_RELEASES_DIR` in `deploy/prod.env`.

```bash
CONSOLE_RELEASES_DIR=/opt/dp2-console   # same value as in deploy/prod.env
REL=admin-console-<sha12>

# Steps 1-3 run in a subshell: it stops at the first failure, and this shell
# stays in the repo checkout. Paste the whole block at once.
(
  set -e
  cd "$CONSOLE_RELEASES_DIR"

  # 1. Fetch the pinned release and verify its checksum.
  gh release download "$REL" --repo Kemetra/Admin-Console --dir incoming
  (cd incoming && sha256sum -c "$REL.tar.gz.sha256")

  # 2. Unpack into its own directory and check what it is.
  mkdir -p "releases/$REL"
  tar -xzf "incoming/$REL.tar.gz" -C "releases/$REL"
  cat "releases/$REL/version.json"   # sha + backendContractPin

  # 3. Switch atomically (relative target, resolved inside the container too).
  ln -sfn "releases/$REL" current.next && mv -Tf current.next current
)
# Keep the subshell out of an `&&` list: bash ignores `set -e` inside it there.
if [ $? -eq 0 ]; then
  echo "Console release $REL is now current."
else
  echo "Console release aborted; current was not switched." >&2
fi
```

4. Smoke-test the origin from the repo checkout (read-only, no credentials) once
   the block above reported success. Caddy must be running: on a redeploy run it
   now; on the **first deploy** run it after step 3 of [Deploy](#deploy) (`up`),
   as part of [Verify](#verify).

```bash
deploy/console-smoke.sh https://api.example.test
```

Record every deployment as a pair: the Console `sha` and `backendContractPin` from
`version.json`, plus the Backend-Core commit (`<deploy-ref>`) and image digests.
Only pair a Console release with a Backend-Core release whose API contract it was
built against.

**Rollback:** point `current` back at the previously recorded release, then rerun
the smoke test from the repo checkout. Keep previous release directories until
the new one is accepted.

```bash
CONSOLE_RELEASES_DIR=/opt/dp2-console   # same value as in deploy/prod.env
(cd "$CONSOLE_RELEASES_DIR" && ln -sfn releases/<previous-release> current.next && mv -Tf current.next current) &&
  deploy/console-smoke.sh https://api.example.test
```

`index.html` and `version.json` are served `no-cache` and `/assets/*` (content-
hashed) as immutable, so browsers pick up a new release on the next load.

## Verify

```bash
op run --env-file=deploy/prod.env -- \
  docker compose -f docker-compose.prod.yml ps          # all healthy; migrate Exited(0)
curl -sS https://api.example.test/api/v1/health/live    # {"status":"ok"}: the edge and the process are up
curl -sS https://api.example.test/api/v1/health/ready   # 200 ready / 503 not_ready, with per-check ok|failed
deploy/console-smoke.sh https://api.example.test        # Console at /, API at /api/*, headers, SPA fallback
op run --env-file=deploy/prod.env -- \
  docker compose -f docker-compose.prod.yml run --rm migrate node dist/cli/migrate.js status
```

## Operations

```bash
# logs
op run --env-file=deploy/prod.env -- docker compose -f docker-compose.prod.yml logs -f api
# redeploy a new ref: pull, then run the full release sequence from "Deploy"
# (1. migrate, 2. grants, 3. up, 4. catch-up). A bare `up` skips the grant step.
git pull
op run --env-file=deploy/prod.env -- docker compose -f docker-compose.prod.yml run --rm --build migrate
op run --env-file=deploy/grants.env -- sh -c \
  'psql -X -v domain_role="$DOMAIN_DB_ROLE" -f docs/operations/sql/cashier-admissions-domain-grants.sql &&
   psql -X -v domain_role="$DOMAIN_DB_ROLE" -f docs/operations/sql/shift-cash-up-domain-grants.sql &&
   psql -X -v domain_role="$DOMAIN_DB_ROLE" -f docs/operations/sql/erpnext-posting-resolution-domain-grants.sql'
op run --env-file=deploy/prod.env -- docker compose -f docker-compose.prod.yml up -d --build
op run --env-file=deploy/grants.env -- psql -X -f docs/operations/sql/erpnext-posting-resolution-catchup.sql
# stop
op run --env-file=deploy/prod.env -- docker compose -f docker-compose.prod.yml down   # keeps volumes (redis AOF, caddy certs)
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
