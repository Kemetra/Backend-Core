# Contributing

Thanks for helping make Data-Pulse-2 better. This repository is governed by
the foundation specification and Constitution checks in the pull request
template, so changes should stay small, reviewed, and testable.

## Before You Start

1. Read [CLAUDE.md](CLAUDE.md) for the active feature, stack defaults, and
   ownership boundaries.
2. Read the relevant artifact under `specs/001-foundation-auth-tenant-store`
   before changing behavior.
3. Confirm whether the change touches tenant isolation, backend authority,
   contracts, workers, observability, or migrations.
4. For project rules and architectural decisions, see
   [.specify/memory/constitution.md](.specify/memory/constitution.md). The
   `.specify/` directory holds governance artifacts — Constitution, architecture
   impact rules, and decision records. These are not product runtime code.

## Local Setup

```bash
pnpm install
pnpm db:up
pnpm build
pnpm test
```

Use these local service URLs when running the API and worker:

```bash
DATABASE_URL=postgres://dp2:dp2_dev_password@localhost:5432/data_pulse_2
REDIS_URL=redis://localhost:6379
```

## Development Rules

- Apps can depend on packages; packages must not import from `apps/*`.
- `apps/api` and `apps/worker` should not import from each other.
- Keep PostgreSQL as the source of truth. Redis is disposable runtime support.
- Keep OpenAPI YAML in `packages/contracts/openapi` aligned with API behavior.
- Add tests for behavior changes. Cross-tenant and cross-store isolation tests
  are required when tenant-owned data is touched.
- Do not introduce dashboard UI, POS app code, analytics, billing, inventory,
  or unrelated domains without an explicit spec update.

## Pull Requests

Every PR should include:

- A short summary of what changed and why.
- A completed Constitution Check from `.github/pull_request_template.md`.
- A test plan with commands run locally.
- Migration/deployment notes when schema, queues, environment variables, or
  runtime wiring changes.

Prefer small PRs that map to a specific spec task or reviewable behavior slice.

### CodeRabbit review

CodeRabbit is the primary AI reviewer, but it is capped at about one review per
hour, so `.coderabbit.yaml` reviews only the first push of a PR automatically
(`auto_incremental_review: false`). Add the `skip-coderabbit` label to opt a PR
out. For High-tier PRs (the risk tiers in `.github/scripts/ci-tier.sh`,
RT-582), comment `@coderabbitai review` on the final head once it is pushed.
