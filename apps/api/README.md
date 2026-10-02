# @data-pulse-2/api

NestJS HTTP API for Retail Tower OS Backend-Core.

## Current Surface

- `AuthModule` for sign-in, sign-out, refresh, password reset, session
  persistence, auth token lookup, and email job enqueueing.
- `ContextModule` for active tenant and store context selection.
- Global request ID, logging, context, exception envelope, and Zod validation
  infrastructure.
- OpenAPI contract loading from `packages/contracts/openapi`.
- Helmet and cookie parsing middleware.

The remaining domain modules for tenants, stores, memberships, invitations,
and audit are staged through the active foundation specification.

## Runtime Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Creates the PostgreSQL pool used by auth and context repositories. |
| `REDIS_URL` | Production email jobs | Wires the BullMQ email producer. Non-production falls back to a no-op enqueuer when missing. |
| `PORT` | No | HTTP port, default `3000`. |
| `LOG_LEVEL` | No | pino log level, default `info`. |

## Commands

```bash
pnpm --filter @data-pulse-2/api build
pnpm --filter @data-pulse-2/api test
pnpm --filter @data-pulse-2/api start
```

## Boundaries

- Depends on `@data-pulse-2/auth`, `@data-pulse-2/db`,
  `@data-pulse-2/shared`, and `@data-pulse-2/contracts`.
- Does not import from `apps/worker`.
- Does not own the dashboard UI. Dashboard work is a separate feature.
- Must keep backend authorization authoritative; frontend visibility is never a
  permission model.
