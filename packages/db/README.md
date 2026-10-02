# @data-pulse-2/db

PostgreSQL schema, migrations, tenant context middleware, and tenant-scoped
query helpers for Backend-Core.

## Current Surface

- Drizzle schema files under `src/schema`.
- Explicit SQL migrations under `drizzle`, including `0000_initial.sql` and
  `0000_initial.down.sql`.
- Migration runner CLI under `src/cli/migrate.ts`.
- Tenant-scoped query helper in `src/helpers/with-tenant.ts`.
- Database tenant context middleware in `src/middleware/tenant-context.ts`.

## Commands

```bash
pnpm --filter @data-pulse-2/db build
pnpm --filter @data-pulse-2/db test
pnpm --filter @data-pulse-2/db migrate:up
pnpm --filter @data-pulse-2/db migrate:down
pnpm --filter @data-pulse-2/db migrate:status
```

Migration commands run against `DATABASE_URL` after the package is built.

## Design Principles

- PostgreSQL is the source of truth.
- Tenant-owned access must be scoped at the database and API layers.
- Migrations are reviewable release artifacts, not incidental generated output.
- Redis-backed helpers may support runtime behavior, but durable state belongs
  in PostgreSQL.
