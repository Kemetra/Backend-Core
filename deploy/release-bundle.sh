#!/usr/bin/env bash
# RT-533: assemble the Backend-Core release bundle + digest manifest.
#
# Run from a checkout of the exact release SHA. Makes no network calls and
# touches nothing outside --out. The bundle is an ALLOWLIST: only the files
# listed below, plus a generated release.env (three non-secret image refs),
# release-manifest.json and SHA256SUMS. Real .env files are never included.
#
# Outputs in --out:
#   backend-core-release-<sha12>.tar.gz   the bundle
#   release-manifest.json                 copy of the manifest inside the bundle
#   SHA256SUMS                            checksums of the two files above
set -euo pipefail

# Files shipped in the bundle. The SQL entries must stay identical to the
# `psql -f` scripts in the Deploy section of deploy/README.md (a test checks).
# auth-lookup-role.sql is NOT listed: README prerequisite 7 runs it once after
# the first `migrate up`, it is not part of the per-deploy sequence.
# The packages/db/drizzle entries are the migrations the catch-up scripts pull
# in with `\ir`; they keep their repo paths so `\ir` resolves in the bundle.
ALLOWLIST=(
  docker-compose.prod.yml
  docker-compose.release.yml
  Caddyfile
  deploy/console-smoke.sh
  docs/operations/sql/cashier-admissions-domain-grants.sql
  docs/operations/sql/shift-cash-up-domain-grants.sql
  docs/operations/sql/erpnext-posting-resolution-domain-grants.sql
  docs/operations/sql/inventory-effect-integration-domain-grants.sql
  docs/operations/sql/stock-locations-domain-grants.sql
  docs/operations/sql/tracking-foundation-domain-grants.sql
  docs/operations/sql/signin-memberships-domain-grants.sql
  docs/operations/sql/sale-reprints-domain-grants.sql
  docs/operations/sql/device-lifecycle-domain-grants.sql
  docs/operations/sql/sale-responsibilities-domain-grants.sql
  docs/operations/sql/sale-responsibilities-feed-rehead.sql
  docs/operations/sql/erpnext-posting-resolution-catchup.sql
  docs/operations/sql/inventory-effect-integration-catchup.sql
  packages/db/drizzle/0038_erpnext_posting_resolution_backfill.sql
  packages/db/drizzle/0043_inventory_effect_integration_backfill.sql
)

fail() { echo "release-bundle: $*" >&2; exit 1; }

SHA="" PUBLISHED="" DIGEST_KIND="" OUT=""
API_DIGEST="" WORKER_DIGEST="" MIGRATE_DIGEST=""
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || fail "missing value for $1"
  case "$1" in
    --sha) SHA="$2" ;;
    --published) PUBLISHED="$2" ;;
    --digest-kind) DIGEST_KIND="$2" ;;
    --out) OUT="$2" ;;
    --api-digest) API_DIGEST="$2" ;;
    --worker-digest) WORKER_DIGEST="$2" ;;
    --migrate-digest) MIGRATE_DIGEST="$2" ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift 2
done

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "--sha must be 40 lowercase hex characters"
case "$PUBLISHED" in true|false) ;; *) fail "--published must be true or false" ;; esac
case "$DIGEST_KIND" in
  registry-manifest-digest|local-image-id) ;;
  *) fail "--digest-kind must be registry-manifest-digest or local-image-id" ;;
esac
# A published release must carry registry digests; a dry run must not claim to.
if [ "$PUBLISHED" = "true" ] && [ "$DIGEST_KIND" != "registry-manifest-digest" ]; then
  fail "a published release requires --digest-kind registry-manifest-digest"
fi
if [ "$PUBLISHED" = "false" ] && [ "$DIGEST_KIND" != "local-image-id" ]; then
  fail "a dry run (--published false) requires --digest-kind local-image-id"
fi
[ -n "$OUT" ] || fail "--out is required"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

HEAD_SHA="$(git rev-parse HEAD)"
[ "$HEAD_SHA" = "$SHA" ] || fail "checkout HEAD ($HEAD_SHA) does not match --sha"

IMAGE_RE='^ghcr\.io/kemetra/backend-core-(api|worker|migrate)@sha256:[0-9a-f]{64}$'
ref_for() { # target digest -> validated ref
  local ref="ghcr.io/kemetra/backend-core-$1@$2"
  [[ "$ref" =~ $IMAGE_RE ]] || fail "image ref for $1 is not a valid digest ref (got digest '$2')"
  [ "${BASH_REMATCH[1]}" = "$1" ] || fail "image ref target mismatch for $1"
  printf '%s' "$ref"
}
API_REF="$(ref_for api "$API_DIGEST")"
WORKER_REF="$(ref_for worker "$WORKER_DIGEST")"
MIGRATE_REF="$(ref_for migrate "$MIGRATE_DIGEST")"

for f in "${ALLOWLIST[@]}"; do
  [ -f "$f" ] || fail "allowlisted file missing: $f"
done

SHA12="${SHA:0:12}"
NAME="backend-core-release-$SHA12"
RELEASE_TAG="backend-core-$SHA12"
IMAGE_TAG="sha-$SHA"
SOURCE_DATE_EPOCH="$(git show -s --format=%ct "$SHA")"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$OUT"
[ -z "$(ls -A "$OUT")" ] || fail "--out must be empty: $OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/$NAME"
mkdir -p "$STAGE"

for f in "${ALLOWLIST[@]}"; do
  mkdir -p "$STAGE/$(dirname "$f")"
  cp -p "$f" "$STAGE/$f"
done

{
  if [ "$PUBLISHED" = "false" ]; then
    echo "# DRY RUN: these are local image IDs, NOT registry digests. Do not deploy."
  fi
  echo "# Release $SHA. Non-secret image refs only."
  echo "DP2_MIGRATE_IMAGE=$MIGRATE_REF"
  echo "DP2_API_IMAGE=$API_REF"
  echo "DP2_WORKER_IMAGE=$WORKER_REF"
} > "$STAGE/release.env"

FILES=("${ALLOWLIST[@]}" release.env)
FILES_JSON="$(cd "$STAGE" && sha256sum "${FILES[@]}" \
  | jq -Rn '[inputs | capture("^(?<h>[0-9a-f]{64}) [ *](?<p>.+)$")] | map({(.p): .h}) | add')"

jq -n \
  --arg sha "$SHA" --arg tag "$RELEASE_TAG" --arg created "$CREATED_AT" \
  --arg kind "$DIGEST_KIND" --arg itag "$IMAGE_TAG" \
  --argjson published "$PUBLISHED" --argjson files "$FILES_JSON" \
  --arg api "$API_DIGEST" --arg worker "$WORKER_DIGEST" --arg migrate "$MIGRATE_DIGEST" \
  --arg aref "$API_REF" --arg wref "$WORKER_REF" --arg mref "$MIGRATE_REF" '
  def img($t; $d; $r): {repository: ("ghcr.io/kemetra/backend-core-" + $t), tag: $itag, digest: $d, ref: $r};
  {
    schemaVersion: 1,
    repository: "Kemetra/Backend-Core",
    sha: $sha,
    releaseTag: $tag,
    published: $published,
    digestKind: $kind,
    createdAt: $created,
    images: {api: img("api"; $api; $aref), worker: img("worker"; $worker; $wref), migrate: img("migrate"; $migrate; $mref)},
    files: $files
  }
  + (if $published then {} else {note: "DRY RUN: digests are local image IDs, not registry digests; nothing was pushed."} end)
' > "$STAGE/release-manifest.json"

(cd "$STAGE" && sha256sum "${FILES[@]}" release-manifest.json > SHA256SUMS)

# Deterministic archive: sorted names, fixed owner, mtime = commit time, no gzip timestamp.
tar --sort=name --owner=0 --group=0 --numeric-owner \
    --mtime="@$SOURCE_DATE_EPOCH" -C "$WORK" -cf - "$NAME" | gzip -n > "$OUT/$NAME.tar.gz"
cp "$STAGE/release-manifest.json" "$OUT/release-manifest.json"
(cd "$OUT" && sha256sum "$NAME.tar.gz" release-manifest.json > SHA256SUMS)

echo "release-bundle: wrote $OUT/$NAME.tar.gz (published=$PUBLISHED, digestKind=$DIGEST_KIND)"
