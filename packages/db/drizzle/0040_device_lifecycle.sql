-- 0040_device_lifecycle.sql
--
-- Device lifecycle columns (Jira RT-364, RT-287 F1). [GATED] migration —
-- owner-authorized in-session on 2026-10-11 ("go" on `Execute RT-364`, after
-- ratifying the RT-287 decisions in RT-287 comment 11499).
--
-- Schema only — an EXPAND step. No route, guard, contract or Drizzle schema
-- change ships with it: revoke (RT-365), pairing-code issue/replace (RT-367),
-- retire (RT-368), rotate (RT-369) and last-seen/expiry enforcement (RT-370)
-- add the behaviour. Every existing auth path keeps reading `token_hash` +
-- `revoked_at` exactly as before; nothing here enforces expiry.
--
-- Deploy coupling: `packages/db/src/schema/devices.ts` deliberately does NOT
-- declare these columns yet. The device lookup uses Drizzle `select()`, which
-- names every declared column, so declaring them here would make the running
-- API fail on a database without 0040 (and make rolling 0040 back break every
-- till). RT-365 declares them, and ships after 0040 is applied everywhere.
-- Until then this migration and its down can be applied independently of any
-- API release.
--
-- Changes:
--   1. devices.expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + 90 days
--      (RT-138 L2). The default is STABLE, so ADD COLUMN evaluates it once:
--      every existing device gets now() + 90 days (the RT-138 backfill) without
--      a table rewrite, and a device inserted by the current pairing path
--      (which does not name the column) gets its own issue time + 90 days.
--   2. devices.last_seen_at TIMESTAMPTZ NULL (RT-138 L7; written by RT-370).
--   3. Revoke attribution (RT-138 L3, RT-287 D-Q3): revoked_by, revoke_reason
--      (closed enum), revoke_note. Revoke fields may only be set on a revoked
--      device, and `other` requires a note. A reason is NOT required by the
--      database: a revoke made before this migration, or by the interim SQL
--      procedure in use until RT-365 ships (POS runbook §7), has no recorded
--      reason, and that stays NULL rather than a guessed value. RT-365 makes
--      the reason mandatory for every revoke through the API. revoked_by stays
--      nullable for the same reason (actor unknown).
--   4. Rotation overlap (RT-138 L4): previous_token_hash + previous_valid_until,
--      set together, with a partial UNIQUE index so the auth lookup by the
--      previous hash is one index probe.
--   5. Retire (RT-287 D-Q2): retired_at, retired_by, retire_reason. Retire is
--      terminal and implies revoke (CHECK); a retired row carries a reason.
--   6. pairing_codes.replaces_device_id UUID NULL (RT-138 L5, RT-287 D-Q1).
--      Deliberately NOT a FK to devices(id), for the same reason as
--      pairing_codes.device_id (0024): a later-migration FK onto devices breaks
--      0001's isolated down-migration test (`cannot drop table devices`).
--      RT-367 validates the target in the same transaction as the pair.
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): SECURITY-class (credential
-- lifecycle). previous_token_hash is a SHA-256 hash, never a recoverable
-- secret. revoke_note / retire_reason are operator free text: they must never
-- carry a token, PIN or secret, and they never enter audit metadata (RT-135
-- allowlist; enforced by RT-365/RT-368). No PII by design, no money.
-- Grants: none — auth_lookup already holds table-level SELECT on devices and
-- pairing_codes (docs/operations/sql/auth-lookup-role.sql); no new table.
-- Lock duration: ACCESS EXCLUSIVE on devices and pairing_codes. Every ADD COLUMN
-- is catalog-only (nullable, or a STABLE default); the CHECKs validate over two
-- small tables; no row is rewritten.
-- Reversible via 0040_device_lifecycle.down.sql.

BEGIN;

-- 1–5. devices ---------------------------------------------------------------

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL
    DEFAULT (now() + interval '90 days'),
  ADD COLUMN IF NOT EXISTS last_seen_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by            UUID,
  ADD COLUMN IF NOT EXISTS revoke_reason         TEXT,
  ADD COLUMN IF NOT EXISTS revoke_note           TEXT,
  ADD COLUMN IF NOT EXISTS previous_token_hash   BYTEA,
  ADD COLUMN IF NOT EXISTS previous_valid_until  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retired_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retired_by            UUID,
  ADD COLUMN IF NOT EXISTS retire_reason         TEXT;

ALTER TABLE devices
  ADD CONSTRAINT devices_revoke_reason_valid
    CHECK (revoke_reason IS NULL OR revoke_reason IN (
      'lost', 'stolen', 'suspected_compromise', 'hardware_failure',
      'replaced', 'moved', 'retired', 'admin_error', 'other')),
  ADD CONSTRAINT devices_revoke_attribution_when_revoked
    CHECK (revoked_at IS NOT NULL
           OR (revoke_reason IS NULL AND revoked_by IS NULL AND revoke_note IS NULL)),
  ADD CONSTRAINT devices_revoke_note_shape
    CHECK (revoke_note IS NULL
           OR (length(btrim(revoke_note)) > 0 AND length(revoke_note) <= 500)),
  ADD CONSTRAINT devices_revoke_other_requires_note
    CHECK (revoke_reason IS DISTINCT FROM 'other' OR revoke_note IS NOT NULL),
  ADD CONSTRAINT devices_previous_token_pair
    CHECK ((previous_token_hash IS NULL) = (previous_valid_until IS NULL)),
  ADD CONSTRAINT devices_retired_implies_revoked
    CHECK (retired_at IS NULL OR revoked_at IS NOT NULL),
  ADD CONSTRAINT devices_retire_fields_when_retired
    CHECK (CASE WHEN retired_at IS NULL
                THEN retired_by IS NULL AND retire_reason IS NULL
                ELSE retire_reason IS NOT NULL END),
  ADD CONSTRAINT devices_retire_reason_shape
    CHECK (retire_reason IS NULL
           OR (length(btrim(retire_reason)) > 0 AND length(retire_reason) <= 500));

-- Auth lookup by the previous hash during the rotation overlap (RT-369).
CREATE UNIQUE INDEX IF NOT EXISTS devices_previous_token_hash_uk
  ON devices (previous_token_hash) WHERE previous_token_hash IS NOT NULL;

-- 6. pairing_codes -------------------------------------------------------------

ALTER TABLE pairing_codes
  ADD COLUMN IF NOT EXISTS replaces_device_id UUID;

-- Cancel-pending-codes-for-a-device cascade (RT-365) and the replace lookup.
CREATE INDEX IF NOT EXISTS pairing_codes_replaces_pending_idx
  ON pairing_codes (tenant_id, replaces_device_id)
  WHERE status = 'pending' AND replaces_device_id IS NOT NULL;

COMMIT;
