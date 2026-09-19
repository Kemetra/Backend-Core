# Backend-Core production image — multi-stage build for a pnpm workspace.
#
# Targets:
#   - api      : NestJS HTTP API (node dist/main.js), listens PORT(3000) + METRICS_PORT(9464)
#   - worker   : standalone BullMQ consumer (no HTTP server)
#   - migrate  : one-shot DB migration CLI (packages/db -> node dist/cli/migrate.js up)
#
# Build a specific target with:  docker build --target api -t dp2-api .
# Compose builds all three via per-service `target:` (see docker-compose.prod.yml).
#
# glibc (bookworm-slim), NOT alpine: pg + NestJS native deps are more reliable on glibc.

# ---- base: node 20 + pnpm via corepack ----------------------------------------
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
# pnpm deploy needs workspace packages injected so internal deps (@data-pulse-2/*)
# are bundled into the pruned output rather than left as unresolved workspace links.
ENV npm_config_inject_workspace_packages=true
RUN corepack enable
WORKDIR /repo

# ---- build: install full workspace, compile, prune per-app --------------------
FROM base AS build
# lockfile + workspace manifest + shared tsconfig first for better layer caching.
# tsconfig.base.json is REQUIRED: every package extends ../../tsconfig.base.json
# (it carries skipLibCheck + shared compiler options). Omitting it makes every
# package's `extends` resolve to a missing file, silently dropping skipLibCheck
# and breaking `tsc` on transitive .d.ts (e.g. @clerk/shared optional deps).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
# compile every workspace package (tsc -> dist/)
RUN pnpm -r run build
# produce self-contained, prod-only bundles for each runtime target
# workspace deps resolved via npm_config_inject_workspace_packages (set in base);
# pnpm 9.15 `deploy` has no --legacy flag — the env handles injection.
RUN pnpm --filter=@data-pulse-2/api    deploy --prod /out/api
RUN pnpm --filter=@data-pulse-2/worker deploy --prod /out/worker
RUN pnpm --filter=@data-pulse-2/db     deploy --prod /out/db

# ---- api runtime --------------------------------------------------------------
FROM base AS api
WORKDIR /app
COPY --from=build /out/api ./
# The OpenAPI loader resolves contracts relative to the monorepo layout:
#   /app/dist/openapi/loader.js -> ../../../../packages/contracts/openapi == /packages/contracts/openapi
# The pruned bundle has no such tree, so place the static contract YAMLs there.
COPY --from=build /repo/packages/contracts/openapi /packages/contracts/openapi
# The migration-status gauge (app.module.ts countMigrationFiles) reads the drizzle
# SQL dir; without it the pruned image reports db_migration_status pending forever.
# Ship the migrations and point DB_MIGRATIONS_DIR at them (set in compose).
COPY --from=build /repo/packages/db/drizzle /packages/db/drizzle
ENV NODE_ENV=production
# 3000 = HTTP API, 9464 = Prometheus metrics (also used as the liveness probe)
EXPOSE 3000 9464
CMD ["node", "dist/main.js"]

# ---- worker runtime -----------------------------------------------------------
FROM base AS worker
WORKDIR /app
COPY --from=build /out/worker ./
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]

# ---- migrate (one-shot) -------------------------------------------------------
FROM base AS migrate
WORKDIR /app
COPY --from=build /out/db ./
ENV NODE_ENV=production
# migrations resolved relative to the bundled db package
CMD ["node", "dist/cli/migrate.js", "up"]
