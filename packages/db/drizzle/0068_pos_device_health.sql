-- 0068_pos_device_health.sql
--
-- RT-327 (RT-323 F1, AD-DEVICE-001 D-1, D-2, D-4) — `[GATED]` migration under
-- the owner's PR + CI-only authorization (RT-327 comments 13279, 13360, 13393).
-- NEVER applied to a lab or live database by this change.
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/pos-device-health.openapi.yaml  (RT-327 step 1)
--   - packages/db/src/schema/device-health.ts, pos-version-policy.ts
--   - packages/db/__tests__/migration/0068-pos-device-health.spec.ts
--
-- Creates TWO tables:
--
--   device_health        the current heartbeat READ-MODEL of one paired POS
--                        terminal: exactly one row per device, created by the
--                        first stored heartbeat. Last-write-wins, no history,
--                        so raw telemetry retention is bounded by construction.
--   pos_version_policy   the GLOBAL POS version policy: one row per update
--                        channel (lab | canary | stable), platform-level, not
--                        tenant-editable and not overridable per tenant.
--
-- device_health
--   * `last_seen_at` is the DATABASE SERVER clock at the last stored beat; the
--     only input of liveness. `source_clock_at` is the terminal's own clock,
--     kept as provenance for skew diagnosis, never used for liveness or
--     compliance.
--   * Every self-reported field is nullable (NULL = unknown) and bounded: the
--     version and channel/state columns carry the contract's pattern or enum,
--     `schema_head` is the contract's migration-name pattern, so no free text
--     can be stored. No user, cashier, sale, hostname, machine id, IP, path or
--     credential column exists (§XIV).
--   * Identity is REFERENCED, never copied: PK = FK -> devices(id). A device is
--     never deleted (RESTRICT, as every other table that names a device).
--   * RLS: ENABLE + FORCE, tenant policies on the empty-GUC CASE guard (a bare
--     ::uuid cast throws 22P02 on an unset GUC). INSERT and UPDATE also require
--     the device to be a device of the SAME tenant: the EXISTS reads `devices`
--     under that table's own tenant RLS, so a tenant context can never write a
--     health row for another tenant's device even with its own tenant_id
--     (devices has no (tenant_id, id) unique key to hang a composite FK on, and
--     this migration does not alter `devices`). NO DELETE policy.
--
-- pos_version_policy
--   * Three versions (semantic version without build metadata, 5..32 chars,
--     the contract's `AppVersion`), the grace instant, a revision (>= 1) bumped
--     by every effective change, and the author (a user id, never an email).
--     The order `min <= recommended <= latest` is semantic-version precedence
--     and is enforced by the API (422), not here.
--   * RLS: ENABLE + FORCE. SELECT is open to every context (the heartbeat and
--     the console reads run in a tenant context and join the policy; it is
--     global, non-sensitive configuration, as `global_products`). INSERT and
--     UPDATE need `app.is_platform_admin = 'true'`, which only the platform
--     routes set. NO DELETE policy.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (§XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS operational telemetry: a last-seen instant, version numbers,
-- enumerations and a migration name. NO PII, NO money, NO secret. One row per
-- device, replaced by every stored beat; retained while the device exists.
-- Reclassify and re-trigger the §XIV review if a later change admits any
-- free-text, user, host or location field.
-- ---------------------------------------------------------------------------
--
-- Reversal: 0068_pos_device_health.down.sql. It drops ONLY these two tables
-- (with their policies, indexes and constraints) and so DISCARDS the stored
-- heartbeat telemetry and the version policy.
--
-- Runtime grants are provisioned outside migrations:
-- docs/operations/sql/pos-device-health-domain-grants.sql (step 2 of
-- deploy/README.md), BEFORE the API that needs it starts.

BEGIN;

CREATE TABLE IF NOT EXISTS device_health (
  device_id        UUID         PRIMARY KEY REFERENCES devices(id) ON DELETE RESTRICT,
  tenant_id        UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- Server clock at the last stored beat. The only input of liveness.
  last_seen_at     TIMESTAMPTZ  NOT NULL,
  app_version      TEXT,
  update_channel   TEXT,
  update_state     TEXT,
  pending_version  TEXT,
  schema_head      TEXT,
  -- The terminal's own clock; provenance only, never liveness or compliance.
  source_clock_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT device_health_app_version_shape CHECK (
    app_version IS NULL OR (
      length(app_version) BETWEEN 5 AND 32
      AND app_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
    )
  ),
  CONSTRAINT device_health_pending_version_shape CHECK (
    pending_version IS NULL OR (
      length(pending_version) BETWEEN 5 AND 32
      AND pending_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
    )
  ),
  CONSTRAINT device_health_update_channel_valid CHECK (
    update_channel IS NULL OR update_channel IN ('lab', 'canary', 'stable')
  ),
  CONSTRAINT device_health_update_state_valid CHECK (
    update_state IS NULL OR update_state IN (
      'idle', 'checking', 'downloading', 'downloaded', 'verify_failed',
      'verify_unavailable', 'compat_blocked', 'update_pending', 'installing', 'error'
    )
  ),
  CONSTRAINT device_health_schema_head_shape CHECK (
    schema_head IS NULL OR (
      length(schema_head) BETWEEN 1 AND 64
      AND schema_head ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
    )
  )
);

-- The console list is per tenant.
CREATE INDEX IF NOT EXISTS idx_device_health_tenant
  ON device_health (tenant_id);

ALTER TABLE device_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_health FORCE  ROW LEVEL SECURITY;

CREATE POLICY device_health_tenant_read ON device_health
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY device_health_tenant_insert ON device_health
  FOR INSERT
  WITH CHECK (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
    AND EXISTS (
      SELECT 1 FROM devices d
       WHERE d.id = device_health.device_id AND d.tenant_id = device_health.tenant_id
    )
  );

-- UPDATE serves the last-write-wins upsert (INSERT ... ON CONFLICT DO UPDATE).
-- NO DELETE policy: a health row is never removed by the application.
CREATE POLICY device_health_tenant_update ON device_health
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END)
  WITH CHECK (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
    AND EXISTS (
      SELECT 1 FROM devices d
       WHERE d.id = device_health.device_id AND d.tenant_id = device_health.tenant_id
    )
  );

CREATE TABLE IF NOT EXISTS pos_version_policy (
  channel                    TEXT         PRIMARY KEY,
  latest_version             TEXT         NOT NULL,
  recommended_version        TEXT         NOT NULL,
  min_supported_version      TEXT         NOT NULL,
  min_supported_grace_until  TIMESTAMPTZ  NOT NULL,
  -- Bumped by every effective change; the `expectedRevision` of the next one.
  revision                   INTEGER      NOT NULL DEFAULT 1,
  updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- A user id, never an email.
  updated_by_user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT pos_version_policy_channel_valid CHECK (channel IN ('lab', 'canary', 'stable')),
  CONSTRAINT pos_version_policy_revision_positive CHECK (revision >= 1),
  CONSTRAINT pos_version_policy_latest_shape CHECK (
    length(latest_version) BETWEEN 5 AND 32
    AND latest_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
  ),
  CONSTRAINT pos_version_policy_recommended_shape CHECK (
    length(recommended_version) BETWEEN 5 AND 32
    AND recommended_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
  ),
  CONSTRAINT pos_version_policy_min_supported_shape CHECK (
    length(min_supported_version) BETWEEN 5 AND 32
    AND min_supported_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
  )
);

ALTER TABLE pos_version_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_version_policy FORCE  ROW LEVEL SECURITY;

-- Global, non-sensitive configuration: any context may read it.
CREATE POLICY pos_version_policy_read ON pos_version_policy
  FOR SELECT
  USING (true);

-- Only the platform-admin context (`app.is_platform_admin`, set by
-- runWithTenantContext on the platform routes) may create or change a policy.
CREATE POLICY pos_version_policy_platform_insert ON pos_version_policy
  FOR INSERT
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY pos_version_policy_platform_update ON pos_version_policy
  FOR UPDATE
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

COMMIT;
