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

## Deploy

```bash
gh repo clone <owner>/<repo>                    # or: git pull on an existing clone
cd Backend-Core
git checkout <deploy-ref>                       # the reconciled origin/main commit being deployed

cp deploy/prod.env.example deploy/prod.env      # then set private references/values
op run --env-file=deploy/prod.env -- \
  docker compose -f docker-compose.prod.yml up -d --build
```

`op run` resolves private references into the container env in memory only. The
`migrate` service runs `migrate up` against `<managed-db>` and must exit 0 before
`api`/`worker` start (compose `service_completed_successfully` gate).

## Verify

```bash
docker compose -f docker-compose.prod.yml ps          # all healthy; migrate Exited(0)
curl -sS -o /dev/null -w "%{http_code}\n" https://api.example.test/
# any app response (e.g. 401/404 from NestJS) proves the edge is live; TCP timeout = not live
op run --env-file=deploy/prod.env -- \
  docker compose -f docker-compose.prod.yml run --rm migrate node dist/cli/migrate.js status
```

## Operations

```bash
# logs
docker compose -f docker-compose.prod.yml logs -f api
# redeploy a new ref
git pull && op run --env-file=deploy/prod.env -- docker compose -f docker-compose.prod.yml up -d --build
# stop
docker compose -f docker-compose.prod.yml down            # keeps volumes (redis AOF, caddy certs)
```

## Known follow-ups (not in this artifact)

- **Add a public `GET /health` route** to `apps/api`; currently healthchecks use the
  unauthenticated Prometheus metrics listener on `:9464`.
- **Hardening:** run containers as a non-root user; add resource limits; offsite backups
  for `<managed-db>`; monitoring/alerting; log shipping.
- **Console** (`<console-host>`) is a separate later deployment.
