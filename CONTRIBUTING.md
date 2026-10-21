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

### Changelog entries and contract-only operations (RT-805)

Parallel PRs must not edit shared lines, so a merge never makes its siblings
conflict:

- **Changelog.** Do not edit `CHANGELOG.md`. Add one file per entry,
  `changelog.d/RT-<number>-<slug>.md`, holding one `### Added` / `Changed` /
  `Deprecated` / `Removed` / `Fixed` / `Security` heading and the entry. See
  [changelog.d/README.md](changelog.d/README.md). `node tools/changelog/assemble.cjs`
  validates them, and `--migrate` moves an entry written into `[Unreleased]`
  by mistake. The release runs `--release <version>`.
- **Contract-only operations.** Mark the operation `x-runtime-status:
  contract-only` with an `x-runtime-note` naming the ticket that ships the
  runtime. That is the whole registration: the route-conformance spec derives
  the set from the markers. When the runtime ships, delete both keys. The
  spec fails if a marked operation already has a route, or if an unmarked one
  has none.
- **Console rate-limit classes.** Every `cookieAuth` operation, runtime or
  contract-only, has its class in its contract's own file,
  `apps/api/test/console-rate-limit/classes/<contract>.rate-limit.yaml`
  (`audit.openapi.yaml` → `audit.rate-limit.yaml`; subdirectories mirror
  `packages/contracts/openapi/`). Add the entry with the contract. Shipping
  the runtime removes only the `x-runtime-status` marker; the class entry
  stays, and the ratchet then checks that the handler resolves to it. The
  ratchet fails on an unclassified operation, a class mismatch, a
  contract-only operation that is routed, or a stale, duplicated or unknown
  entry.

### CodeRabbit review

CodeRabbit is the primary AI reviewer, but it is capped at about one review per
hour, so `.coderabbit.yaml` reviews only the first push of a PR automatically
(`auto_incremental_review: false`). Add the `skip-coderabbit` label to opt a PR
out. For High-tier PRs (the risk tiers in `.github/scripts/ci-tier.sh`,
RT-582), comment `@coderabbitai review` on the final head once it is pushed.
