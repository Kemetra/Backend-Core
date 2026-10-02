# @data-pulse-2/worker

NestJS standalone worker runtime for asynchronous Retail Tower OS Backend-Core jobs.
The current implemented queue is `email`, transported through BullMQ and
Redis.

## Current Surface

- Standalone Nest application context in `src/main.ts`.
- `WorkerModule` with worker factory wiring.
- BullMQ-backed production worker factory when `REDIS_URL` is present.
- No-op worker factory for local and test runs without Redis.
- Email processor, email worker, templates, and provider-adapter seam.
- Graceful shutdown handling for `SIGTERM` and `SIGINT`.

Additional processors for audit fanout, session revocation, soft-delete
sweeps, and retention are staged through the active foundation specification.

## Runtime Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `REDIS_URL` | Production | Subscribes BullMQ workers to Redis-backed queues. |

Production startup fails when `REDIS_URL` is missing so the worker cannot
silently run without consuming jobs.

## Commands

```bash
pnpm --filter @data-pulse-2/worker build
pnpm --filter @data-pulse-2/worker test
pnpm --filter @data-pulse-2/worker start
```

## Boundaries

- Depends on `@data-pulse-2/shared`.
- Does not import from `apps/api`.
- Does not expose HTTP endpoints.
- Does not own durable domain truth; PostgreSQL remains authoritative.
