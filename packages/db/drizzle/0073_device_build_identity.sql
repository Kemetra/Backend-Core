-- 0073_device_build_identity.sql
--
-- POS build identity per device (Jira RT-719, RT-709 decision O-8; fleet
-- baseline for the RT-713 POS compatibility matrix). `[GATED]` migration under
-- the owner's PR + CI-only authorization (RT-719 comment 13394). NEVER applied
-- to a lab or live database by this change.
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/pos-terminal-pairing.openapi.yaml
--       ("Build identity report (RT-719)": the three optional X-POS-* headers)
--   - packages/contracts/openapi/devices.openapi.yaml        (`buildIdentity`)
--   - packages/contracts/openapi/console-device-builds.openapi.yaml
--   - packages/db/__tests__/migration/0073-device-build-identity.spec.ts
--
-- Adds FOUR NULLABLE columns to `devices`, all self-reported by the terminal and
-- stored by the same best-effort throttled write as `last_seen_at` (RT-370):
--
--   reported_build_commit   the POS git commit, 40 lower-case hex: the anchor
--   reported_app_version    the POS semantic version (no build metadata, <= 32)
--   reported_contract_pin   the Backend-Core commit in the build's PIN, 40 hex
--   build_reported_at       the SERVER clock when the identity was last stored
--
-- UNKNOWN IS NEVER A DEFAULT: every column is NULL until a terminal reports; a
-- reporting request without a valid commit stores NULL in all four (an older
-- build must never read as the newer build it replaced). A CHECK ties them
-- together: either all four are NULL (unknown), or the commit and the server
-- time are set (the version and the pin may each be NULL). Every value is a
-- bounded pattern, so no free text, PII, hostname, path or secret can be stored.
-- It is an inventory signal, never trust: nothing reads these columns for an
-- authorization or a refusal.
--
-- ADDITIVE: no existing row, policy or constraint changes. RLS is the existing
-- tenant policy on `devices` (ENABLE + FORCE); a tenant never reads or writes
-- another tenant's identity. No new table, so NO new grant: the domain role
-- already holds UPDATE on `devices` (device-lifecycle-domain-grants.sql, which
-- the RT-370 activity write uses). The auth lookup role is untouched.
--
-- Deploy coupling: `packages/db/src/schema/devices.ts` deliberately does NOT
-- declare these columns (as 0040 did until RT-365): the device lookup uses
-- Drizzle `select()`, which names every declared column, so declaring them
-- would make every till's authentication fail on a database without 0073. The
-- runtime reads and writes them with raw SQL. Apply 0073 before the API that
-- reads them is rolled (migrate is step 1 of every release); on a database
-- without it only the reporting write (logged and dropped) and the Console
-- devices reads that name the columns are affected.
--
-- Lock: ACCESS EXCLUSIVE on `devices` for the length of the statement. Every
-- ADD COLUMN is nullable with no default (catalog only, no rewrite) and the
-- CHECKs validate over a small table.
--
-- DATA-LIFECYCLE CLASSIFICATION (§XIV): BUSINESS-class inventory telemetry: two
-- commit ids, a version and a server timestamp per device, replaced by every
-- stored report; retained while the device row exists. Reclassify and re-trigger
-- the §XIV review if a later change admits a free-text, user, host or location
-- field.
--
-- Reversal: 0073_device_build_identity.down.sql drops ONLY these four columns
-- and their constraints and so DISCARDS every reported build identity.

BEGIN;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS reported_build_commit  TEXT,
  ADD COLUMN IF NOT EXISTS reported_app_version   TEXT,
  ADD COLUMN IF NOT EXISTS reported_contract_pin  TEXT,
  ADD COLUMN IF NOT EXISTS build_reported_at      TIMESTAMPTZ;

ALTER TABLE devices
  ADD CONSTRAINT devices_reported_build_commit_shape
    CHECK (reported_build_commit IS NULL OR reported_build_commit ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT devices_reported_contract_pin_shape
    CHECK (reported_contract_pin IS NULL OR reported_contract_pin ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT devices_reported_app_version_shape
    CHECK (
      reported_app_version IS NULL OR (
        length(reported_app_version) BETWEEN 5 AND 32
        AND reported_app_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
      )
    ),
  ADD CONSTRAINT devices_build_identity_consistent
    CHECK (
      (reported_build_commit IS NULL
        AND reported_app_version IS NULL
        AND reported_contract_pin IS NULL
        AND build_reported_at IS NULL)
      OR (reported_build_commit IS NOT NULL AND build_reported_at IS NOT NULL)
    );

COMMIT;
