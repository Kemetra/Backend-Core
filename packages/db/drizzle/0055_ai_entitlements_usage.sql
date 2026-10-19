-- 0055_ai_entitlements_usage.sql
--
-- AI plan catalog, tenant entitlements, tenant opt-outs, usage counters and
-- the single AI usage ledger (Jira RT-663 = RT-644 ENT-BC2 merged with RT-643
-- F-3). [GATED] G3 migration. The owner approved authoring it and verifying
-- it in CI / Testcontainers on 2026-10-19 (RT-663 comment 12984); applying it
-- to any lab or live database is NOT authorized by this file and remains a
-- separate owner gate.
-- Decisions: AD-AI-ENT-001 (Confluence 42926118) D-2 authority, D-3 counter
-- Option A, D-5 tenant owner opt-out, D-8 refused output not charged, D-9 UTC
-- windows, and its "Usage-store ownership" section; AD-AI-PROV-001 (42893347)
-- D-6 one usage store and E-8 per-call run metadata (AI-09).
-- Storage only: nothing reads or writes these tables until RT-664 (evaluator,
-- reserve / commit, sweeper, platform-admin grants). The contract is RT-662.
--
-- Changes, in order:
--   1. ai_plan_catalog, ai_plan_catalog_features, ai_plan_catalog_meters —
--      the code-owned, versioned plan catalogue (D-2). Platform-scoped, not
--      tenant-scoped. An unknown feature is denied because it has no row
--      (default-deny). A catalog version is immutable; a change is a new
--      version, written by a migration. Customer meters count requests only
--      in v1 (D-3), per tenant or per store (D-4), per UTC day or month
--      (D-9). The seed is ONE version, core@1, that grants no AI feature and
--      no meter: plan names, the feature-to-plan matrix and every quota
--      number are research hypotheses until RT-645 measures unit costs
--      (AD-AI-ENT-001 "No commercial commitment"), so none is seeded.
--   2. tenant_ai_entitlements — immutable entitlement revisions (D-2). One
--      tenant-wide linear chain: entitlement_version 1, 2, 3 …, each naming
--      its base_version (the writer's expected_version). Two writers on the
--      same base collide on UNIQUE (tenant_id, entitlement_version) → 23505,
--      which RT-664 maps to a conflict and never merges. Lifecycle state per
--      RT-644 §4.3 (none / trial / active / grace / expired / cancelled);
--      overrides are a bounded JSON array inside the revision, so a revision
--      and its overrides are immutable together and content_hash (SHA-256,
--      computed by RT-664) covers both. Source: a manual platform-admin grant
--      (reason + granting user) or a future Billing event (its event ref,
--      consumed once per tenant). Rollback publishes a new revision.
--      Only a platform admin may INSERT (RLS WITH CHECK on
--      app.is_platform_admin): a tenant can never grant itself (T18).
--   3. tenant_ai_feature_opt_outs — the tenant owner's subtract-only opt-out
--      source (D-5), kept apart from the grant source so the tenant write path
--      can never produce a grant. Its own tenant-wide linear chain
--      (opt_out_version / base_version, same collision rule); each row turns
--      one feature off or back on, with a reason and its author. Owner-only
--      and "never above the plan" are runtime rules (RT-664).
--   4. ai_usage_counters — one row per (tenant, store or none, meter, UTC
--      window) (D-3 Option A). `used` and `reserved` only move; the limit is
--      not stored here, it is read from the effective entitlement at
--      reservation time (`used + reserved + n <= limit`), so a downgrade
--      never needs a counter rewrite. The row's identity is frozen, and it is
--      never deleted.
--   5. ai_usage_ledger — THE single AI usage store (AD-AI-ENT-001 "One
--      store", AD-AI-PROV-001 D-6): append-only rows `reserved`, then at most
--      one `committed` or `released` per reservation. Unique (tenant_id,
--      feature_id, idempotency_key) on the reserved row (a replay returns the
--      same reservation). A terminal row is pinned to its reservation's
--      tenant, feature, counter, units and entitlement_version by a
--      composite FK. `committed` exactly for outcome `ok`; every other
--      outcome is a release and is never charged to the customer (D-8, T10).
--      The AI-09 run metadata lives here: route, prompt template and output
--      schema versions, provider and model, evidence-ref ids, tokens
--      (reported or estimated), list-price-equivalent cost (integer micros,
--      a currency and the rate-card version it was computed with), outcome
--      and provider request id. Raw prompts and completions are NOT stored
--      (E-8). No price, rate or cost-table column, and no reuse of catalog,
--      price-override, promotion or settlement tables (RT-663 scope).
--
-- Isolation: every table is RLS ENABLED + FORCED (the 0036 CASE-GUC form for
-- the tenant tables). The catalog is readable by everyone and writable only
-- under app.is_platform_admin = 'true' (the GUC runWithTenantContext sets).
-- The migration owner is not a superuser (docs/operations/database-roles.md),
-- so FORCE RLS applies to it: this migration seeds before forcing RLS, and a
-- later catalog migration sets the GUC locally (`SELECT set_config(
-- 'app.is_platform_admin', 'true', true)`) before its INSERTs. Entitlement revisions: tenant SELECT, platform-admin INSERT.
-- Opt-outs and the ledger: tenant SELECT + INSERT. Counters: tenant SELECT +
-- INSERT + UPDATE. Every table refuses DELETE and TRUNCATE for every role,
-- the owner included (42501, the 0034 precedent); all but the counters also
-- refuse UPDATE. Store scoping stays in the service layer (as for every
-- store-keyed table); the composite store FK keeps a store inside its tenant.
-- Every trigger function pins `search_path = pg_catalog, public` and
-- schema-qualifies its table references.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CONFIGURATION / OPERATIONAL-TELEMETRY class: identifiers (tenant,
-- store, users, reservations, provider request ids, evidence-ref ids),
-- timestamps, enum values, counts, token counts, an internal list-price-
-- equivalent cost (never shown to tenants, AD-AI-ENT-001 D-6) and short
-- free-text reasons (1–500 chars, no PII by contract, never logged). No
-- prompt, completion, secret, credential, customer or contact datum.
-- Retention: kept with the tenant (append-only); AI history retention after
-- expiry is a separate decision (RT-644 R-5).
--
-- Lock impact (one transaction; every lock is held until COMMIT): only new
-- tables are created. tenants, stores and users get SHARE ROW EXCLUSIVE for
-- the new FKs, taken up front under lock_timeout = 2s (the 0047 precedent):
-- their writes wait until COMMIT, reads continue. No existing table is
-- altered or scanned. Expected well under a second. On a lock timeout,
-- `migrate up` exits non-zero with nothing applied; retry when the blocking
-- transaction has ended.
-- Grants: none here — runtime grants are provisioned outside migrations
-- (docs/operations/database-roles.md) and ship with the RT-664 runtime. The
-- runtime roles get no catalog write grant: the catalog stays code-owned.
--
-- Rollback: 0055_ai_entitlements_usage.down.sql drops the seven tables and
-- their functions. Once RT-664 has written data, the down DISCARDS every
-- entitlement revision, opt-out, counter and ledger row. Roll back RT-664
-- first, and take a backup if the usage history matters.
--
-- Numbering: the latest migration on main is 0054_sale_credit_reversals
-- (0049, 0052 and 0053 are absent); this is 0055. If another migration lands
-- first, renumber these files and update EXPECTED_MIGRATIONS in
-- packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

LOCK TABLE tenants, stores, users IN SHARE ROW EXCLUSIVE MODE;

-- =============================================================================
-- 0. The shared append-only guard
-- =============================================================================

CREATE FUNCTION ai_entitlements_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'AI catalog versions, entitlement revisions, opt-outs and ledger rows are never edited or deleted; write a new one (RT-663).';
END
$$;

-- =============================================================================
-- 1. The code-owned plan catalog (platform-scoped)
-- =============================================================================

CREATE TABLE ai_plan_catalog (
  plan_code        TEXT         NOT NULL,
  catalog_version  INTEGER      NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_code, catalog_version),
  CONSTRAINT ai_plan_catalog_plan_code_format CHECK (plan_code ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT ai_plan_catalog_version_positive CHECK (catalog_version >= 1)
);

-- The features a catalog version includes; a feature without a row is denied.
CREATE TABLE ai_plan_catalog_features (
  plan_code        TEXT         NOT NULL,
  catalog_version  INTEGER      NOT NULL,
  feature_id       TEXT         NOT NULL,
  PRIMARY KEY (plan_code, catalog_version, feature_id),
  CONSTRAINT fk_ai_plan_catalog_features_catalog
    FOREIGN KEY (plan_code, catalog_version)
    REFERENCES ai_plan_catalog (plan_code, catalog_version) ON DELETE RESTRICT,
  CONSTRAINT ai_plan_catalog_features_feature_id_format
    CHECK (feature_id ~ '^ai(\.[a-z][a-z0-9_]{0,39}){1,4}$')
);

-- A feature's customer meters (D-3: requests only in v1; D-4 scope; D-9 window).
CREATE TABLE ai_plan_catalog_meters (
  plan_code        TEXT         NOT NULL,
  catalog_version  INTEGER      NOT NULL,
  feature_id       TEXT         NOT NULL,
  meter            TEXT         NOT NULL,
  unit             TEXT         NOT NULL,
  window_kind      TEXT         NOT NULL,
  meter_scope      TEXT         NOT NULL,
  limit_value      BIGINT       NOT NULL,
  PRIMARY KEY (plan_code, catalog_version, feature_id, meter),
  CONSTRAINT fk_ai_plan_catalog_meters_feature
    FOREIGN KEY (plan_code, catalog_version, feature_id)
    REFERENCES ai_plan_catalog_features (plan_code, catalog_version, feature_id) ON DELETE RESTRICT,
  CONSTRAINT ai_plan_catalog_meters_meter_format
    CHECK (meter ~ '^[a-z][a-z0-9_]{0,39}(\.[a-z][a-z0-9_]{0,39}){0,5}$'),
  CONSTRAINT ai_plan_catalog_meters_unit_valid CHECK (unit IN ('request')),
  CONSTRAINT ai_plan_catalog_meters_window_valid CHECK (window_kind IN ('day', 'month')),
  CONSTRAINT ai_plan_catalog_meters_scope_valid CHECK (meter_scope IN ('tenant', 'store')),
  CONSTRAINT ai_plan_catalog_meters_limit_non_negative CHECK (limit_value >= 0)
);

-- The default-deny seed: one version, no feature, no meter (see the header).
-- Written before RLS is forced; the platform-admin GUC is not needed here.
INSERT INTO ai_plan_catalog (plan_code, catalog_version) VALUES ('core', 1);

ALTER TABLE ai_plan_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_plan_catalog FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_plan_catalog_read ON ai_plan_catalog FOR SELECT USING (true);
CREATE POLICY ai_plan_catalog_platform_insert ON ai_plan_catalog
  FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE ai_plan_catalog_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_plan_catalog_features FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_plan_catalog_features_read ON ai_plan_catalog_features FOR SELECT USING (true);
CREATE POLICY ai_plan_catalog_features_platform_insert ON ai_plan_catalog_features
  FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE ai_plan_catalog_meters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_plan_catalog_meters FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_plan_catalog_meters_read ON ai_plan_catalog_meters FOR SELECT USING (true);
CREATE POLICY ai_plan_catalog_meters_platform_insert ON ai_plan_catalog_meters
  FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

CREATE TRIGGER ai_plan_catalog_append_only_row
  BEFORE UPDATE OR DELETE ON ai_plan_catalog
  FOR EACH ROW EXECUTE FUNCTION ai_entitlements_append_only();
CREATE TRIGGER ai_plan_catalog_append_only_truncate
  BEFORE TRUNCATE ON ai_plan_catalog
  FOR EACH STATEMENT EXECUTE FUNCTION ai_entitlements_append_only();
CREATE TRIGGER ai_plan_catalog_features_append_only_row
  BEFORE UPDATE OR DELETE ON ai_plan_catalog_features
  FOR EACH ROW EXECUTE FUNCTION ai_entitlements_append_only();
CREATE TRIGGER ai_plan_catalog_features_append_only_truncate
  BEFORE TRUNCATE ON ai_plan_catalog_features
  FOR EACH STATEMENT EXECUTE FUNCTION ai_entitlements_append_only();
CREATE TRIGGER ai_plan_catalog_meters_append_only_row
  BEFORE UPDATE OR DELETE ON ai_plan_catalog_meters
  FOR EACH ROW EXECUTE FUNCTION ai_entitlements_append_only();
CREATE TRIGGER ai_plan_catalog_meters_append_only_truncate
  BEFORE TRUNCATE ON ai_plan_catalog_meters
  FOR EACH STATEMENT EXECUTE FUNCTION ai_entitlements_append_only();

-- =============================================================================
-- 2. tenant_ai_entitlements — immutable revisions, one linear chain per tenant
-- =============================================================================

CREATE TABLE tenant_ai_entitlements (
  id                   UUID          PRIMARY KEY,
  tenant_id            UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  entitlement_version  INTEGER       NOT NULL,
  -- The writer's expected_version; NULL only for the first revision.
  base_version         INTEGER,
  -- NULL exactly for state `none` (default-deny, no plan).
  plan_code            TEXT,
  catalog_version      INTEGER,
  state                TEXT          NOT NULL,
  effective_from       TIMESTAMPTZ   NOT NULL,
  effective_until      TIMESTAMPTZ,
  -- [{feature_id, action, meter?, meter_limit_delta?, expires_at?, reason}],
  -- validated by RT-664 and covered by content_hash.
  overrides            JSONB         NOT NULL DEFAULT '[]'::jsonb,
  source               TEXT          NOT NULL,
  -- The Billing event id of a `billing_event` revision.
  source_ref           TEXT,
  reason               TEXT,
  -- The granting platform admin of a `manual_platform` revision.
  created_by_user_id   UUID          REFERENCES users(id) ON DELETE RESTRICT,
  content_hash         BYTEA         NOT NULL,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_tenant_ai_entitlements_version UNIQUE (tenant_id, entitlement_version),
  -- One Billing event becomes at most one revision (NULL refs are distinct).
  CONSTRAINT uq_tenant_ai_entitlements_source_ref UNIQUE (tenant_id, source_ref),
  CONSTRAINT fk_tenant_ai_entitlements_base
    FOREIGN KEY (tenant_id, base_version)
    REFERENCES tenant_ai_entitlements (tenant_id, entitlement_version) ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_ai_entitlements_catalog
    FOREIGN KEY (plan_code, catalog_version)
    REFERENCES ai_plan_catalog (plan_code, catalog_version) ON DELETE RESTRICT,
  CONSTRAINT tenant_ai_entitlements_version_chain CHECK (
    (entitlement_version = 1 AND base_version IS NULL)
    OR (entitlement_version > 1 AND base_version IS NOT NULL
        AND base_version = entitlement_version - 1)),
  CONSTRAINT tenant_ai_entitlements_state_valid
    CHECK (state IN ('none', 'trial', 'active', 'grace', 'expired', 'cancelled')),
  -- `none` names no plan; every other state names a whole plan version.
  CONSTRAINT tenant_ai_entitlements_plan_shape CHECK (
    (state = 'none' AND plan_code IS NULL AND catalog_version IS NULL)
    OR (state <> 'none' AND plan_code IS NOT NULL AND catalog_version IS NOT NULL)),
  CONSTRAINT tenant_ai_entitlements_trial_ends
    CHECK (state <> 'trial' OR effective_until IS NOT NULL),
  CONSTRAINT tenant_ai_entitlements_until_after_from
    CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT tenant_ai_entitlements_overrides_shape
    CHECK (jsonb_typeof(overrides) = 'array' AND jsonb_array_length(overrides) <= 100),
  CONSTRAINT tenant_ai_entitlements_source_valid
    CHECK (source IN ('manual_platform', 'billing_event')),
  -- A manual grant has a reason and its granting user (D-2); a Billing
  -- revision has its event ref.
  CONSTRAINT tenant_ai_entitlements_source_shape CHECK (
    (source = 'manual_platform' AND source_ref IS NULL
       AND reason IS NOT NULL AND created_by_user_id IS NOT NULL)
    OR (source = 'billing_event' AND source_ref IS NOT NULL)),
  CONSTRAINT tenant_ai_entitlements_source_ref_length
    CHECK (source_ref IS NULL OR char_length(source_ref) BETWEEN 1 AND 200),
  CONSTRAINT tenant_ai_entitlements_reason_length
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT tenant_ai_entitlements_content_hash_sha256
    CHECK (octet_length(content_hash) = 32)
);

ALTER TABLE tenant_ai_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_ai_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_ai_entitlements_tenant_select ON tenant_ai_entitlements
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
-- No tenant self-grant (D-2, T18): only a platform admin, inside the target
-- tenant's context, may write a revision.
CREATE POLICY tenant_ai_entitlements_platform_insert ON tenant_ai_entitlements
  FOR INSERT WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    AND tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE TRIGGER tenant_ai_entitlements_append_only_row
  BEFORE UPDATE OR DELETE ON tenant_ai_entitlements
  FOR EACH ROW EXECUTE FUNCTION ai_entitlements_append_only();
CREATE TRIGGER tenant_ai_entitlements_append_only_truncate
  BEFORE TRUNCATE ON tenant_ai_entitlements
  FOR EACH STATEMENT EXECUTE FUNCTION ai_entitlements_append_only();

-- =============================================================================
-- 3. tenant_ai_feature_opt_outs — the tenant owner's subtract-only source (D-5)
-- =============================================================================

CREATE TABLE tenant_ai_feature_opt_outs (
  id                  UUID          PRIMARY KEY,
  tenant_id           UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  opt_out_version     INTEGER       NOT NULL,
  base_version        INTEGER,
  feature_id          TEXT          NOT NULL,
  action              TEXT          NOT NULL,
  reason              TEXT          NOT NULL,
  created_by_user_id  UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_tenant_ai_feature_opt_outs_version UNIQUE (tenant_id, opt_out_version),
  CONSTRAINT fk_tenant_ai_feature_opt_outs_base
    FOREIGN KEY (tenant_id, base_version)
    REFERENCES tenant_ai_feature_opt_outs (tenant_id, opt_out_version) ON DELETE RESTRICT,
  CONSTRAINT tenant_ai_feature_opt_outs_version_chain CHECK (
    (opt_out_version = 1 AND base_version IS NULL)
    OR (opt_out_version > 1 AND base_version IS NOT NULL
        AND base_version = opt_out_version - 1)),
  CONSTRAINT tenant_ai_feature_opt_outs_feature_id_format
    CHECK (feature_id ~ '^ai(\.[a-z][a-z0-9_]{0,39}){1,4}$'),
  CONSTRAINT tenant_ai_feature_opt_outs_action_valid CHECK (action IN ('opt_out', 'opt_in')),
  CONSTRAINT tenant_ai_feature_opt_outs_reason_length
    CHECK (char_length(reason) BETWEEN 1 AND 500)
);

-- The latest row per feature (the effective opt-out state).
CREATE INDEX idx_tenant_ai_feature_opt_outs_feature
  ON tenant_ai_feature_opt_outs (tenant_id, feature_id, opt_out_version DESC);

ALTER TABLE tenant_ai_feature_opt_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_ai_feature_opt_outs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_ai_feature_opt_outs_tenant_select ON tenant_ai_feature_opt_outs
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY tenant_ai_feature_opt_outs_tenant_insert ON tenant_ai_feature_opt_outs
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE TRIGGER tenant_ai_feature_opt_outs_append_only_row
  BEFORE UPDATE OR DELETE ON tenant_ai_feature_opt_outs
  FOR EACH ROW EXECUTE FUNCTION ai_entitlements_append_only();
CREATE TRIGGER tenant_ai_feature_opt_outs_append_only_truncate
  BEFORE TRUNCATE ON tenant_ai_feature_opt_outs
  FOR EACH STATEMENT EXECUTE FUNCTION ai_entitlements_append_only();

-- =============================================================================
-- 4. ai_usage_counters — one row per (tenant, store?, meter, UTC window)
-- =============================================================================

CREATE TABLE ai_usage_counters (
  id            UUID          PRIMARY KEY,
  tenant_id     UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- The store of a per-store meter (D-4); NULL for a tenant meter.
  store_id      UUID,
  meter         TEXT          NOT NULL,
  window_kind   TEXT          NOT NULL,
  -- The UTC start of the day or month (D-9).
  window_start  TIMESTAMPTZ   NOT NULL,
  used          BIGINT        NOT NULL DEFAULT 0,
  reserved      BIGINT        NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_usage_counters_window
    UNIQUE NULLS NOT DISTINCT (tenant_id, store_id, meter, window_kind, window_start),
  -- Target of the ledger's composite FK.
  CONSTRAINT uq_ai_usage_counters_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT fk_ai_usage_counters_store
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_usage_counters_meter_format
    CHECK (meter ~ '^[a-z][a-z0-9_]{0,39}(\.[a-z][a-z0-9_]{0,39}){0,5}$'),
  CONSTRAINT ai_usage_counters_window_valid CHECK (window_kind IN ('day', 'month')),
  -- `AT TIME ZONE 'UTC'` pins the boundary to UTC whatever the session
  -- TimeZone; date_trunc(text, timestamp) is immutable.
  CONSTRAINT ai_usage_counters_window_utc_aligned CHECK (
    date_trunc(window_kind, window_start AT TIME ZONE 'UTC') = window_start AT TIME ZONE 'UTC'),
  CONSTRAINT ai_usage_counters_used_non_negative CHECK (used >= 0),
  CONSTRAINT ai_usage_counters_reserved_non_negative CHECK (reserved >= 0)
);

CREATE TRIGGER ai_usage_counters_set_updated_at BEFORE UPDATE ON ai_usage_counters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE ai_usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_usage_counters_tenant_select ON ai_usage_counters
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY ai_usage_counters_tenant_insert ON ai_usage_counters
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY ai_usage_counters_tenant_update ON ai_usage_counters
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- Only the counts move; the row's identity never changes and it is never
-- deleted (the ledger references it).
CREATE FUNCTION ai_usage_counters_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.id = OLD.id
     AND NEW.tenant_id = OLD.tenant_id
     AND NEW.store_id IS NOT DISTINCT FROM OLD.store_id
     AND NEW.meter = OLD.meter
     AND NEW.window_kind = OLD.window_kind
     AND NEW.window_start = OLD.window_start
     AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%: % is not permitted (only used and reserved change)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'A usage counter keeps its tenant, store, meter and window, and is never deleted (RT-663).';
END
$$;

CREATE TRIGGER ai_usage_counters_guard_row
  BEFORE UPDATE OR DELETE ON ai_usage_counters
  FOR EACH ROW EXECUTE FUNCTION ai_usage_counters_guard();
CREATE TRIGGER ai_usage_counters_guard_truncate
  BEFORE TRUNCATE ON ai_usage_counters
  FOR EACH STATEMENT EXECUTE FUNCTION ai_usage_counters_guard();

-- =============================================================================
-- 5. ai_usage_ledger — the single append-only AI usage store
-- =============================================================================

CREATE TABLE ai_usage_ledger (
  id                           UUID          PRIMARY KEY,
  tenant_id                    UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- A `reserved` row's own id; a terminal row's reservation.
  reservation_id               UUID          NOT NULL,
  entry_kind                   TEXT          NOT NULL,
  feature_id                   TEXT          NOT NULL,
  counter_id                   UUID          NOT NULL,
  units                        INTEGER       NOT NULL,
  -- The revisions the decision was evaluated under.
  entitlement_version          INTEGER       NOT NULL,
  opt_out_version              INTEGER,
  -- `reserved` rows only: the client Idempotency-Key and the sweeper TTL.
  idempotency_key              TEXT,
  expires_at                   TIMESTAMPTZ,
  request_id                   TEXT,
  actor_user_id                UUID          REFERENCES users(id) ON DELETE RESTRICT,
  -- AI-09 run metadata (route and versions are known at reservation).
  route_key                    TEXT,
  prompt_template_id           TEXT,
  prompt_template_version      TEXT,
  output_schema_id             TEXT,
  output_schema_version        TEXT,
  provider_key                 TEXT,
  model_id                     TEXT,
  evidence_ref_ids             TEXT[],
  -- Terminal rows only: provider usage, internal cost telemetry and outcome.
  input_tokens                 BIGINT,
  output_tokens                BIGINT,
  cached_input_tokens          BIGINT,
  token_count_source           TEXT,
  -- List-price-equivalent cost, recorded even when credits cover the call
  -- (RT-643 §7). A computed amount, not a price: no rate is stored here.
  list_equivalent_cost_micros  BIGINT,
  cost_currency                CHAR(3),
  cost_rate_card_version       TEXT,
  outcome                      TEXT,
  provider_request_id          TEXT,
  created_at                   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- Target of the terminal → reservation FK (the reservation's dimensions).
  CONSTRAINT uq_ai_usage_ledger_reservation_target
    UNIQUE (id, tenant_id, feature_id, counter_id, units, entitlement_version),
  -- A replay of the same key is the same reservation (D-3). Terminal rows
  -- carry no key, and NULLs are distinct.
  CONSTRAINT uq_ai_usage_ledger_idempotency UNIQUE (tenant_id, feature_id, idempotency_key),
  CONSTRAINT fk_ai_usage_ledger_reservation
    FOREIGN KEY (reservation_id, tenant_id, feature_id, counter_id, units, entitlement_version)
    REFERENCES ai_usage_ledger (id, tenant_id, feature_id, counter_id, units, entitlement_version)
    ON DELETE RESTRICT,
  CONSTRAINT fk_ai_usage_ledger_counter
    FOREIGN KEY (counter_id, tenant_id) REFERENCES ai_usage_counters (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ai_usage_ledger_entitlement
    FOREIGN KEY (tenant_id, entitlement_version)
    REFERENCES tenant_ai_entitlements (tenant_id, entitlement_version) ON DELETE RESTRICT,
  CONSTRAINT fk_ai_usage_ledger_opt_out
    FOREIGN KEY (tenant_id, opt_out_version)
    REFERENCES tenant_ai_feature_opt_outs (tenant_id, opt_out_version) ON DELETE RESTRICT,
  CONSTRAINT ai_usage_ledger_entry_kind_valid
    CHECK (entry_kind IN ('reserved', 'committed', 'released')),
  CONSTRAINT ai_usage_ledger_reservation_self
    CHECK ((entry_kind = 'reserved') = (reservation_id = id)),
  CONSTRAINT ai_usage_ledger_feature_id_format
    CHECK (feature_id ~ '^ai(\.[a-z][a-z0-9_]{0,39}){1,4}$'),
  CONSTRAINT ai_usage_ledger_units_positive CHECK (units > 0),
  -- A reservation has its key (the HTTP Idempotency-Key, 16–128 chars) and
  -- a TTL after it was taken; a terminal row has neither.
  CONSTRAINT ai_usage_ledger_reserved_shape CHECK (
    (entry_kind = 'reserved' AND idempotency_key IS NOT NULL AND expires_at IS NOT NULL
       AND expires_at > created_at)
    OR (entry_kind <> 'reserved' AND idempotency_key IS NULL AND expires_at IS NULL)),
  CONSTRAINT ai_usage_ledger_idempotency_key_length
    CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 16 AND 128),
  -- A reservation has no outcome and no provider usage yet.
  CONSTRAINT ai_usage_ledger_reserved_no_result CHECK (
    entry_kind <> 'reserved'
    OR (outcome IS NULL AND input_tokens IS NULL AND output_tokens IS NULL
        AND cached_input_tokens IS NULL AND token_count_source IS NULL
        AND list_equivalent_cost_micros IS NULL AND cost_currency IS NULL
        AND cost_rate_card_version IS NULL AND provider_request_id IS NULL)),
  CONSTRAINT ai_usage_ledger_outcome_valid CHECK (
    outcome IS NULL OR outcome IN ('ok', 'provider_refused', 'output_truncated', 'output_invalid',
      'provider_unavailable', 'input_rejected', 'not_attempted', 'reservation_expired')),
  -- D-8 / T10: only a validated `ok` is charged; everything else is released.
  CONSTRAINT ai_usage_ledger_outcome_by_kind CHECK (
    entry_kind = 'reserved'
    OR (entry_kind = 'committed' AND outcome IS NOT NULL AND outcome = 'ok')
    OR (entry_kind = 'released' AND outcome IS NOT NULL AND outcome <> 'ok')),
  -- Tokens are reported by the provider or estimated, and say which.
  CONSTRAINT ai_usage_ledger_token_source_valid
    CHECK (token_count_source IS NULL OR token_count_source IN ('reported', 'estimated')),
  CONSTRAINT ai_usage_ledger_tokens_sourced CHECK (
    (token_count_source IS NULL)
    = (input_tokens IS NULL AND output_tokens IS NULL AND cached_input_tokens IS NULL)),
  CONSTRAINT ai_usage_ledger_tokens_non_negative CHECK (
    (input_tokens IS NULL OR input_tokens >= 0)
    AND (output_tokens IS NULL OR output_tokens >= 0)
    AND (cached_input_tokens IS NULL OR cached_input_tokens >= 0)),
  CONSTRAINT ai_usage_ledger_cost_all_or_none CHECK (
    (list_equivalent_cost_micros IS NULL AND cost_currency IS NULL AND cost_rate_card_version IS NULL)
    OR (list_equivalent_cost_micros IS NOT NULL AND cost_currency IS NOT NULL
        AND cost_rate_card_version IS NOT NULL)),
  CONSTRAINT ai_usage_ledger_cost_non_negative
    CHECK (list_equivalent_cost_micros IS NULL OR list_equivalent_cost_micros >= 0),
  CONSTRAINT ai_usage_ledger_cost_currency_format
    CHECK (cost_currency IS NULL OR cost_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ai_usage_ledger_evidence_refs_shape CHECK (
    evidence_ref_ids IS NULL
    OR (cardinality(evidence_ref_ids) <= 256
        AND array_position(evidence_ref_ids, NULL) IS NULL
        AND char_length(array_to_string(evidence_ref_ids, ',')) <= 32768)),
  CONSTRAINT ai_usage_ledger_text_lengths CHECK (
    (request_id IS NULL OR char_length(request_id) BETWEEN 1 AND 128)
    AND (route_key IS NULL OR char_length(route_key) BETWEEN 1 AND 200)
    AND (prompt_template_id IS NULL OR char_length(prompt_template_id) BETWEEN 1 AND 200)
    AND (prompt_template_version IS NULL OR char_length(prompt_template_version) BETWEEN 1 AND 64)
    AND (output_schema_id IS NULL OR char_length(output_schema_id) BETWEEN 1 AND 200)
    AND (output_schema_version IS NULL OR char_length(output_schema_version) BETWEEN 1 AND 64)
    AND (provider_key IS NULL OR char_length(provider_key) BETWEEN 1 AND 64)
    AND (model_id IS NULL OR char_length(model_id) BETWEEN 1 AND 200)
    AND (cost_rate_card_version IS NULL OR char_length(cost_rate_card_version) BETWEEN 1 AND 64)
    AND (provider_request_id IS NULL OR char_length(provider_request_id) BETWEEN 1 AND 256))
);

-- At most one commit or release per reservation.
CREATE UNIQUE INDEX uq_ai_usage_ledger_one_terminal
  ON ai_usage_ledger (reservation_id) WHERE entry_kind <> 'reserved';
-- The TTL sweeper's scan of open reservations (T17).
CREATE INDEX idx_ai_usage_ledger_reserved_expiry
  ON ai_usage_ledger (expires_at) WHERE entry_kind = 'reserved';
-- Per-tenant, per-feature, per-period reads (usage export, spend cap).
CREATE INDEX idx_ai_usage_ledger_tenant_feature_created
  ON ai_usage_ledger (tenant_id, feature_id, created_at);
CREATE INDEX idx_ai_usage_ledger_counter ON ai_usage_ledger (counter_id);

ALTER TABLE ai_usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_usage_ledger_tenant_select ON ai_usage_ledger
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY ai_usage_ledger_tenant_insert ON ai_usage_ledger
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE TRIGGER ai_usage_ledger_append_only_row
  BEFORE UPDATE OR DELETE ON ai_usage_ledger
  FOR EACH ROW EXECUTE FUNCTION ai_entitlements_append_only();
CREATE TRIGGER ai_usage_ledger_append_only_truncate
  BEFORE TRUNCATE ON ai_usage_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION ai_entitlements_append_only();

-- A terminal row closes a `reserved` row (23514), never another terminal row:
-- the composite FK alone cannot say which kind it references. An unknown
-- reservation is 23503 here, before the end-of-statement FK, so a multi-row
-- INSERT cannot list a terminal before its reservation.
CREATE FUNCTION ai_usage_ledger_terminal_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_kind text;
BEGIN
  -- An unknown kind is left to the entry_kind CHECK (23514).
  IF NEW.entry_kind NOT IN ('committed', 'released') THEN
    RETURN NEW;
  END IF;
  SELECT l.entry_kind INTO v_kind
    FROM public.ai_usage_ledger l
   WHERE l.id = NEW.reservation_id
     AND l.tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger row % closes an unknown reservation', NEW.id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_kind <> 'reserved' THEN
    RAISE EXCEPTION 'ledger row % closes a % row, not a reservation', NEW.id, v_kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_usage_ledger_terminal_guard
  BEFORE INSERT ON ai_usage_ledger
  FOR EACH ROW EXECUTE FUNCTION ai_usage_ledger_terminal_guard();

COMMIT;
