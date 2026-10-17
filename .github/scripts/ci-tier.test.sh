#!/usr/bin/env bash
# Self-test for ci-tier.sh (RT-582). Runs in the `changes` job before the
# real classification, so a broken rule fails `changes` and every gated job
# then runs (they skip only on an explicit 'false').
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CI_TIER_TEST_INPUTS=$'docs/observability/signals.md\nspecs/009-inventory-stock-ledger/data-model.md\n.specify/memory/redaction-matrix.md'
fails=0

# expect "<tier> <fast> <db> <schemathesis>" path...
expect() {
  local want="$1"
  shift
  local got
  got="$(printf '%s\0' "$@" | bash "$HERE/ci-tier.sh" 2>/dev/null |
    sed -n 's/^[a-z_]*=//p' | paste -sd' ' -)"
  if [[ "$got" == "$want" ]]; then
    echo "ok    [$want] $*"
  else
    echo "FAIL  [$*] want '$want' got '$got'"
    fails=$((fails + 1))
  fi
}

LOW="low false false false"
MED_NOAPI="medium true true false"
MED_API="medium true true true"
HIGH="high true true true"

# Low
expect "$LOW" README.md
expect "$LOW" docs/operations/runbook.md docs/assets/brand/icons/catalog.svg
expect "$LOW" specs/012-foo/spec.md specs/012-foo/plan.md
expect "$LOW" .claude/settings.json
expect "$LOW" "docs/a file with spaces.md"
expect "$LOW" apps/api/src/catalog/README.md

# Medium
expect "$MED_NOAPI" apps/worker/src/jobs/foo.ts
expect "$MED_NOAPI" apps/worker/src/jobs/foo.ts docs/x.md
expect "$MED_API" apps/api/src/catalog/catalog.service.ts
expect "$MED_API" packages/shared/src/logger/pino.ts
expect "$MED_API" apps/worker/src/jobs/foo.ts packages/db/src/helpers/x.ts

# High: explicit paths
expect "$HIGH" packages/contracts/openapi/catalog/unknown-items.yaml
expect "$HIGH" packages/db/drizzle/0051_sale_responsibilities.sql
expect "$HIGH" packages/auth/src/passwords.ts
expect "$HIGH" pnpm-lock.yaml
expect "$HIGH" apps/api/package.json
expect "$HIGH" .github/workflows/ci.yml
expect "$HIGH" .github/PULL_REQUEST_TEMPLATE.md
expect "$HIGH" tools/schemathesis/run.sh
expect "$HIGH" tools/oasdiff/README.md
expect "$HIGH" Dockerfile
expect "$HIGH" docker-compose.prod.yml
expect "$HIGH" tools/schemathesis/compose.yml

# High: risk keywords under apps/ and packages/
expect "$HIGH" apps/api/src/tenancy/tenant-context.ts
expect "$HIGH" apps/api/src/settlement/money.ts
expect "$HIGH" apps/worker/src/outbox/drainer.ts
expect "$HIGH" apps/api/src/pricing/resolve.ts
expect "$HIGH" apps/api/src/catalog/sync/pull.ts
expect "$HIGH" apps/api/src/erpnext/posting-feed.ts
expect "$HIGH" packages/db/src/RLS/policies.ts

# High: docs that code or tests read
expect "$HIGH" docs/operations/sql/auth-lookup-role.sql
expect "$HIGH" docs/operations/sql/sale-responsibilities-feed-rehead.sql
expect "$HIGH" specs/009-inventory-stock-ledger/data-model.md
expect "$HIGH" .specify/memory/redaction-matrix.md
expect "$HIGH" docs/observability/signals.md
expect "$LOW" docs/observability/other.md

# High: unmatched paths and the empty set
expect "$HIGH" tsconfig.base.json
expect "$HIGH" tools/eslint-rules/no-unscoped-tenant-query.js
expect "$HIGH" loadtests/k6/smoke.js
expect "$HIGH" .specify/templates/plan-template.sh
expect "$HIGH"

# A rename lists both sides (--no-renames): moving a migration into docs/ stays High.
expect "$HIGH" docs/old-migration.sql packages/db/drizzle/0051_sale_responsibilities.sql

# Highest tier wins regardless of order
expect "$HIGH" docs/x.md apps/worker/src/a.ts .github/workflows/ci.yml

# The live test-input scan (no override) must still find a docs file a test
# reads, or a broken grep would quietly turn those docs Low.
live="$(printf '%s\0' docs/observability/signals.md |
  env -u CI_TIER_TEST_INPUTS bash "$HERE/ci-tier.sh" 2>/dev/null | sed -n 's/^tier=//p')"
if [[ "$live" == high ]]; then
  echo "ok    live test-input scan finds docs/observability/signals.md"
else
  echo "FAIL  live test-input scan: docs/observability/signals.md classified '$live'"
  fails=$((fails + 1))
fi

if ((fails > 0)); then
  echo "$fails ci-tier case(s) failed"
  exit 1
fi
echo "all ci-tier cases passed"
