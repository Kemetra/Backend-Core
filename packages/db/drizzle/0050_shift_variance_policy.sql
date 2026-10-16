-- 0050_shift_variance_policy.sql
--
-- Shift variance policy storage (Jira RT-385, AD-CASH-001 F2).
-- [GATED] migration — needs the owner's approval before merge (RT-385
-- acceptance criteria). Deploying or running it in any environment is not
-- authorized by this file.
-- Contract (RT-384, #778, owner-ratified): cash-variance-policy.openapi.yaml
-- 1.0.0-draft, pos-shifts.openapi.yaml 1.2.0-draft (frozenPolicy on open,
-- the derived close values), shift-closes.openapi.yaml 1.1.0-draft.
-- Storage only: no runtime path writes the new columns or tables until
-- RT-387. The existing open and close writers keep working unchanged.
--
-- Changes, in order:
--   1. cash_variance_policy_revisions — immutable policy revisions (D-3):
--      the tenant default (scope 'tenant') and the store override (scope
--      'store', kind 'set' | 'clear'), value mode 'none' | 'limit' with an
--      exact-decimal limit and its currency (D-1), a reason, Apply Now
--      (effective_from = created_at, DR-12), an optional store expiry, the
--      DR-4 permanent flag (no expiry, or one more than 90 × 24 h after
--      publish — elapsed time, so DST-safe) and the publishing owner as its
--      approver (coordinator decision 2: owner-only, single call). Each
--      scope's history is ONE linear chain (supersedes_revision_id): the
--      optimistic-concurrency backstop for `expectedRevisionId` (two publishes
--      on the same predecessor → 23505, mapped to 409 by RT-387). Effective
--      state (current / superseded / expired) is derived at read, never
--      stored. Narrow by design so RT-284 can absorb it (decision 1).
--   2. shifts gains the frozen policy of a cash-up open (pos-shifts
--      `frozenPolicy` + its `policyFlags`, D-6), set at insert or adoption
--      and never changed after (shifts_cash_up_guard). Accept-and-flag: only
--      structural CHECKs; an unknown revision id (no FK), a value that differs
--      from its revision and a currency other than the shift's are stored with
--      their flags, never refused. All-or-none; cash_up rows only.
--   3. shift_closes gains approval_required_by_policy and approval_missing
--      ('yes' | 'no' | 'unknown', D-7), NOT NULL DEFAULT 'unknown'. The
--      constant default is metadata-only (no rewrite, no trigger fires): every
--      existing close and every close written before RT-387 reads 'unknown',
--      which is exact — the strict open body refuses frozenPolicy until RT-387,
--      so no such shift froze a policy (contract: "unknown exactly when the
--      shift carries no frozenPolicy"). No policy is fabricated.
--      - row CHECK: approval_missing follows approval_required_by_policy and
--        the recorded approver (ApprovalMissingMatches);
--      - shift_closes_require_open_shift (replaced) also checks the close
--        against the shift's frozen policy: 'unknown' exactly when none was
--        frozen; 'no' under a frozen 'none'; under a frozen 'limit', 'yes'
--        exactly when |variance| > limit (D-1). A frozen limit in a currency
--        other than the shift's cannot be compared, and FAILS SAFE to 'yes'
--        (coordinator decision, owner to ratify; a flag, never a refusal).
--        A close left at the 'unknown' default on a shift that froze a policy
--        (the pre-RT-387 writer after an RT-387 rollback, or a mixed-version
--        deploy) gets the two values DERIVED there instead of being refused,
--        so no POS close is ever stuck and 'unknown' never survives on a
--        frozen-policy close.
--      The close's policy revision id is the shift's frozen one, read through
--      the 1:1 shift_id join; it is not duplicated on shift_closes.
--   4. shift_close_approver_checks — the persisted approverCheck verdict
--      (D-7, K-4), one per close, append-only. A close with NO verdict row
--      reads by the contract rule (coordinator decision 4): no recorded
--      approver → not_applicable; an approver → unverified /
--      check_unavailable. That one rule is the legacy value, the pre-RT-387
--      value and the close-time placeholder, so shift_closes stays
--      append-only and nothing is backfilled; the awaited post-commit check
--      INSERTs the verdict once (a failed check writes nothing and keeps the
--      placeholder). A composite FK pins the verdict to the close's own
--      recorded approver.
--
-- Isolation: both new tables are tenant-RLS ENABLED + FORCED with SELECT and
-- INSERT policies only (the 0036 CASE-GUC form), and append-only for every
-- role, the owner included (UPDATE / DELETE / TRUNCATE raise 42501, the 0034
-- precedent). Store scoping stays in the service layer (as for every
-- store-keyed table); composite FKs keep each store inside its tenant.
-- Every trigger function pins `search_path = pg_catalog, public` and
-- schema-qualifies its table references.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CONFIGURATION / FINANCIAL-OPERATIONAL class: identifiers (tenant,
-- store, users, revisions), timestamps, exact-decimal limits, enum values and
-- one short free-text `reason` (1–200 chars, documented "no PII" in the
-- contract, never logged). No PIN, secret, token, customer or contact datum.
-- Retained with the shift cash-up facts they explain; never deleted
-- (append-only).
--
-- Lock impact (one transaction; every lock is held until COMMIT). The locks
-- are taken up front, in the runtime's order (shifts before shift_closes, as
-- the close path does), under lock_timeout = 2s per lock request (the 0047
-- precedent): if a lock cannot be taken in time, for example behind a
-- long-running transaction, the migration fails and rolls back instead of
-- leaving a queued ACCESS EXCLUSIVE request that blocks POS traffic behind it.
--   - tenants, stores, users: SHARE ROW EXCLUSIVE for the new FKs; their
--     writes wait until COMMIT, reads continue.
--   - shifts, shift_closes: ACCESS EXCLUSIVE for the ADD COLUMNs (nullable,
--     or a constant default: metadata-only, no rewrite), the NOT VALID CHECKs
--     (no scan: every existing row is NULL / 'unknown' by construction) and
--     the function replacement. Every read and write of the two tables waits
--     until COMMIT.
--   - uq_shift_closes_approver_target (the verdict FK's target) is built
--     inside that window, not CONCURRENTLY: CREATE INDEX CONCURRENTLY needs a
--     single-statement file of its own (the 0048 pattern) plus a third file
--     for the verdict FK, and the ACCESS EXCLUSIVE window above is held
--     anyway. shift_closes has one row per closed cash-up shift (pilot
--     volume: hundreds to low thousands), so the build is one short pass.
-- Expected well under a second at pilot volume; run with no POS sync in
-- flight. On a lock timeout, `migrate up` exits non-zero with nothing
-- applied; retry when the blocking transaction has ended.
-- Grants: none here — runtime grants are provisioned outside migrations
-- (docs/operations/database-roles.md) and ship with the RT-387 runtime.
--
-- Rollback: 0050_shift_variance_policy.down.sql drops the two tables, the
-- new columns and constraints, and restores the 0036 function bodies. Once
-- RT-387 has written data, the down DISCARDS every policy revision, every
-- frozen policy and flag, every derived close value and every approver
-- verdict. Roll back RT-387 first.
--
-- Numbering: RT-418 (payer runtime) claims 0049 in parallel; this is 0050.
-- Whichever merges second renumbers its files if needed and updates
-- EXPECTED_MIGRATIONS in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

LOCK TABLE tenants, stores, users IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE shifts, shift_closes IN ACCESS EXCLUSIVE MODE;

-- =============================================================================
-- 1. cash_variance_policy_revisions
-- =============================================================================

CREATE TABLE cash_variance_policy_revisions (
  id                      UUID          PRIMARY KEY,
  tenant_id               UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  scope                   TEXT          NOT NULL,
  -- The store of a store-scope revision; NULL for the tenant default.
  store_id                UUID,
  kind                    TEXT          NOT NULL,
  -- The value (D-1); all NULL for a `clear`.
  mode                    TEXT,
  limit_amount            NUMERIC(19,4),
  currency_code           CHAR(3),
  reason                  TEXT          NOT NULL,
  -- Server time at publish (Apply Now, DR-12).
  effective_from          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- A store `set`'s optional expiry.
  effective_until         TIMESTAMPTZ,
  permanent               BOOLEAN       NOT NULL,
  -- The publishing owner of a permanent override; NULL otherwise.
  approved_by_user_id     UUID          REFERENCES users(id) ON DELETE RESTRICT,
  -- The scope's previous latest revision (the publish's expectedRevisionId).
  supersedes_revision_id  UUID,
  created_by_user_id      UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- Target of the predecessor FK.
  CONSTRAINT uq_cash_variance_policy_revisions_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT fk_cash_variance_policy_revisions_store
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  -- A predecessor of the same tenant (same scope and store: the chain guard).
  CONSTRAINT fk_cash_variance_policy_revisions_supersedes
    FOREIGN KEY (supersedes_revision_id, tenant_id)
    REFERENCES cash_variance_policy_revisions (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT cash_variance_policy_revisions_scope_valid CHECK (scope IN ('tenant', 'store')),
  CONSTRAINT cash_variance_policy_revisions_kind_valid CHECK (kind IN ('set', 'clear')),
  CONSTRAINT cash_variance_policy_revisions_mode_valid
    CHECK (mode IS NULL OR mode IN ('none', 'limit')),
  CONSTRAINT cash_variance_policy_revisions_store_iff_store_scope
    CHECK ((scope = 'store') = (store_id IS NOT NULL)),
  -- A tenant revision is always a `set` with no expiry.
  CONSTRAINT cash_variance_policy_revisions_tenant_set_only
    CHECK (scope = 'store' OR (kind = 'set' AND effective_until IS NULL)),
  -- A `clear` has no value and no expiry; a `set` has a well-formed value.
  -- (`mode IS NOT NULL` keeps a NULL mode from passing as an unknown result.)
  CONSTRAINT cash_variance_policy_revisions_value_shape CHECK (
    (kind = 'clear' AND mode IS NULL AND limit_amount IS NULL AND currency_code IS NULL
       AND effective_until IS NULL)
    OR (kind = 'set' AND mode IS NOT NULL AND mode = 'none'
        AND limit_amount IS NULL AND currency_code IS NULL)
    OR (kind = 'set' AND mode IS NOT NULL AND mode = 'limit'
        AND limit_amount IS NOT NULL AND currency_code IS NOT NULL)),
  CONSTRAINT cash_variance_policy_revisions_limit_non_negative
    CHECK (limit_amount IS NULL OR limit_amount >= 0),
  CONSTRAINT cash_variance_policy_revisions_limit_not_nan
    CHECK (limit_amount IS NULL OR limit_amount <> 'NaN'::numeric),
  -- Format only: V1's EGP-only rule (K-5) is a runtime 422, not an invariant.
  CONSTRAINT cash_variance_policy_revisions_currency_code_format
    CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT cash_variance_policy_revisions_reason_length
    CHECK (char_length(reason) BETWEEN 1 AND 200),
  -- Apply Now only (DR-12); a scheduled publish would drop this CHECK.
  CONSTRAINT cash_variance_policy_revisions_apply_now CHECK (effective_from = created_at),
  CONSTRAINT cash_variance_policy_revisions_until_after_from
    CHECK (effective_until IS NULL OR effective_until > effective_from),
  -- DR-4: permanent = a store `set` with no expiry, or one MORE than 90 × 24 h
  -- after publish. `+ interval '2160 hours'` is elapsed time; `+ '90 days'`
  -- would follow the session TimeZone across DST.
  CONSTRAINT cash_variance_policy_revisions_permanent_derived CHECK (
    permanent = (scope = 'store' AND kind = 'set'
                 AND (effective_until IS NULL
                      OR effective_until > effective_from + interval '2160 hours'))),
  -- A permanent override names its approving owner, who published it.
  CONSTRAINT cash_variance_policy_revisions_approver_iff_permanent
    CHECK (permanent = (approved_by_user_id IS NOT NULL)),
  CONSTRAINT cash_variance_policy_revisions_approver_is_publisher
    CHECK (approved_by_user_id IS NULL OR approved_by_user_id = created_by_user_id),
  CONSTRAINT cash_variance_policy_revisions_not_self
    CHECK (supersedes_revision_id IS NULL OR supersedes_revision_id <> id)
);

-- One linear chain per scope: one first revision per scope, and a revision
-- is superseded at most once.
CREATE UNIQUE INDEX uq_cash_variance_policy_revisions_tenant_first
  ON cash_variance_policy_revisions (tenant_id)
  WHERE scope = 'tenant' AND supersedes_revision_id IS NULL;
CREATE UNIQUE INDEX uq_cash_variance_policy_revisions_store_first
  ON cash_variance_policy_revisions (tenant_id, store_id)
  WHERE scope = 'store' AND supersedes_revision_id IS NULL;
CREATE UNIQUE INDEX uq_cash_variance_policy_revisions_supersedes
  ON cash_variance_policy_revisions (supersedes_revision_id)
  WHERE supersedes_revision_id IS NOT NULL;

-- The revision lists (newest first, keyset) and the latest-of-scope read.
CREATE INDEX idx_cash_variance_policy_revisions_scope_history
  ON cash_variance_policy_revisions (tenant_id, scope, store_id, created_at DESC, id DESC);

ALTER TABLE cash_variance_policy_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_variance_policy_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY cash_variance_policy_revisions_tenant_select ON cash_variance_policy_revisions
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY cash_variance_policy_revisions_tenant_insert ON cash_variance_policy_revisions
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE FUNCTION cash_variance_policy_revisions_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'A policy revision is never edited or deleted; publish a new one (RT-385).';
END
$$;

CREATE TRIGGER cash_variance_policy_revisions_append_only_row
  BEFORE UPDATE OR DELETE ON cash_variance_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION cash_variance_policy_revisions_append_only();
CREATE TRIGGER cash_variance_policy_revisions_append_only_truncate
  BEFORE TRUNCATE ON cash_variance_policy_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION cash_variance_policy_revisions_append_only();

-- A predecessor must already exist in the tenant (23503: checked here, not
-- only by the end-of-statement FK, so a multi-row INSERT cannot list a child
-- before its parent and slip past the scope check), be of the same scope and
-- store (23514: the composite FK cannot say so, since MATCH SIMPLE skips a
-- NULL store_id), and not be newer than its successor (23514: `now()` is the
-- transaction start, so a publish whose transaction began before its
-- predecessor committed would otherwise date itself earlier and reverse the
-- newest-first history; the publish is refused and retried as a 409).
CREATE FUNCTION cash_variance_policy_revisions_chain_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_scope text;
  v_store uuid;
  v_created timestamptz;
BEGIN
  IF NEW.supersedes_revision_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT r.scope, r.store_id, r.created_at INTO v_scope, v_store, v_created
    FROM public.cash_variance_policy_revisions r
   WHERE r.id = NEW.supersedes_revision_id
     AND r.tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision % supersedes an unknown revision', NEW.id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_scope <> NEW.scope OR v_store IS DISTINCT FROM NEW.store_id THEN
    RAISE EXCEPTION 'revision % supersedes a revision of another scope', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.created_at < v_created THEN
    RAISE EXCEPTION 'revision % is dated before the revision it supersedes', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER cash_variance_policy_revisions_chain_guard
  BEFORE INSERT ON cash_variance_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION cash_variance_policy_revisions_chain_guard();

-- =============================================================================
-- 2. shifts — the frozen policy of a cash-up open
-- =============================================================================

ALTER TABLE shifts
  ADD COLUMN frozen_policy_source        TEXT,
  -- No FK: an unknown revision is accepted and flagged (D-6).
  ADD COLUMN frozen_policy_revision_id   UUID,
  ADD COLUMN frozen_policy_mode          TEXT,
  ADD COLUMN frozen_policy_limit_amount  NUMERIC(19,4),
  ADD COLUMN frozen_policy_currency_code CHAR(3),
  -- The accept-and-flag findings; '{}' when none.
  ADD COLUMN frozen_policy_flags         TEXT[];

ALTER TABLE shifts
  ADD CONSTRAINT shifts_frozen_policy_all_or_none CHECK (
    (frozen_policy_source IS NULL AND frozen_policy_revision_id IS NULL
       AND frozen_policy_mode IS NULL AND frozen_policy_limit_amount IS NULL
       AND frozen_policy_currency_code IS NULL AND frozen_policy_flags IS NULL)
    OR (frozen_policy_source IS NOT NULL AND frozen_policy_mode IS NOT NULL
       AND frozen_policy_flags IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT shifts_frozen_policy_cash_up_only
    CHECK (source = 'cash_up' OR frozen_policy_source IS NULL) NOT VALID,
  ADD CONSTRAINT shifts_frozen_policy_source_valid
    CHECK (frozen_policy_source IS NULL
           OR frozen_policy_source IN ('system', 'tenant', 'store', 'fallback')) NOT VALID,
  -- A revision id exactly for source tenant / store.
  ADD CONSTRAINT shifts_frozen_policy_revision_iff_source CHECK (
    frozen_policy_source IS NULL
    OR (frozen_policy_revision_id IS NULL) = (frozen_policy_source IN ('system', 'fallback'))) NOT VALID,
  ADD CONSTRAINT shifts_frozen_policy_value_shape CHECK (
    frozen_policy_mode IS NULL
    OR (frozen_policy_mode = 'none' AND frozen_policy_limit_amount IS NULL
        AND frozen_policy_currency_code IS NULL)
    OR (frozen_policy_mode = 'limit' AND frozen_policy_limit_amount IS NOT NULL
        AND frozen_policy_currency_code IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT shifts_frozen_policy_limit_non_negative
    CHECK (frozen_policy_limit_amount IS NULL OR frozen_policy_limit_amount >= 0) NOT VALID,
  ADD CONSTRAINT shifts_frozen_policy_limit_not_nan
    CHECK (frozen_policy_limit_amount IS NULL
           OR frozen_policy_limit_amount <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT shifts_frozen_policy_currency_code_format
    CHECK (frozen_policy_currency_code IS NULL
           OR frozen_policy_currency_code ~ '^[A-Z]{3}$') NOT VALID,
  -- Known flags only, each at most once, no NULL element.
  ADD CONSTRAINT shifts_frozen_policy_flags_valid CHECK (
    frozen_policy_flags IS NULL
    OR (frozen_policy_flags <@ ARRAY['policy_revision_unknown', 'policy_revision_superseded',
                                     'policy_value_mismatch']::text[]
        AND array_position(frozen_policy_flags, NULL) IS NULL
        AND cardinality(array_positions(frozen_policy_flags, 'policy_revision_unknown')) <= 1
        AND cardinality(array_positions(frozen_policy_flags, 'policy_revision_superseded')) <= 1
        AND cardinality(array_positions(frozen_policy_flags, 'policy_value_mismatch')) <= 1)) NOT VALID;

-- The 0036 guard, with the frozen policy columns in the adoption list: an
-- adopted open sets them (or not) together with the cash-up columns. Every
-- other rule is unchanged; the close transition already freezes them.
CREATE OR REPLACE FUNCTION shifts_cash_up_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  cash_up_columns CONSTANT text[] := ARRAY['source', 'currency_code', 'opening_float',
    'business_date', 'received_at', 'recorded_by_user_id', 'payload_hash', 'updated_at',
    'frozen_policy_source', 'frozen_policy_revision_id', 'frozen_policy_mode',
    'frozen_policy_limit_amount', 'frozen_policy_currency_code', 'frozen_policy_flags'];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'shifts holds cash-up facts: TRUNCATE is not permitted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.source = 'cash_up' AND NEW.lifecycle_state <> 'open' THEN
      RAISE EXCEPTION 'a cash-up shift is recorded open; it closes with its close'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.source = 'cash_up' THEN
      RAISE EXCEPTION 'a cash-up shift is never deleted'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE of a legacy row.
  IF OLD.source = 'legacy' THEN
    IF NEW.source = 'legacy' THEN
      RETURN NEW;
    END IF;
    -- Adoption: open legacy → open cash_up, every cash-up column set, and
    -- nothing else changed (id, tenant, store, device, opened_at, opening
    -- user, lifecycle, created_at).
    IF OLD.lifecycle_state = 'open'
       AND NEW.lifecycle_state = 'open'
       AND NEW.currency_code IS NOT NULL AND NEW.opening_float IS NOT NULL
       AND NEW.business_date IS NOT NULL AND NEW.received_at IS NOT NULL
       AND NEW.recorded_by_user_id IS NOT NULL AND NEW.payload_hash IS NOT NULL
       AND (to_jsonb(NEW) - cash_up_columns) = (to_jsonb(OLD) - cash_up_columns) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a legacy shift is adopted only while open, setting the cash-up columns only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- UPDATE of a cash_up row.
  IF NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'a cash-up shift never becomes legacy'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.lifecycle_state = 'open'
     AND NEW.lifecycle_state IN ('closed', 'closed_forced')
     AND (to_jsonb(NEW) - 'lifecycle_state' - 'updated_at')
         = (to_jsonb(OLD) - 'lifecycle_state' - 'updated_at')
     AND EXISTS (
       SELECT 1 FROM public.shift_closes c
        WHERE c.shift_id = NEW.shift_id
          AND c.tenant_id = NEW.tenant_id
          AND c.close_kind = CASE NEW.lifecycle_state
                               WHEN 'closed' THEN 'normal'
                               ELSE 'forced' END) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'a cash-up shift only moves open → closed once, with its close recorded'
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- =============================================================================
-- 3. shift_closes — the derived tri-states
-- =============================================================================

ALTER TABLE shift_closes
  ADD COLUMN approval_required_by_policy TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN approval_missing            TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE shift_closes
  ADD CONSTRAINT shift_closes_approval_required_valid
    CHECK (approval_required_by_policy IN ('yes', 'no', 'unknown')) NOT VALID,
  ADD CONSTRAINT shift_closes_approval_missing_valid
    CHECK (approval_missing IN ('yes', 'no', 'unknown')) NOT VALID,
  -- ApprovalMissingMatches: unknown ⇔ unknown; not required → not missing;
  -- required → missing exactly when no approver was recorded.
  ADD CONSTRAINT shift_closes_approval_missing_derived CHECK (
    (approval_required_by_policy = 'unknown' AND approval_missing = 'unknown')
    OR (approval_required_by_policy = 'no' AND approval_missing = 'no')
    OR (approval_required_by_policy = 'yes'
        AND approval_missing = CASE WHEN variance_approved_by_user_id IS NULL
                                    THEN 'yes' ELSE 'no' END)) NOT VALID,
  -- Target of the approver verdict's composite FK.
  ADD CONSTRAINT uq_shift_closes_approver_target
    UNIQUE (shift_id, tenant_id, store_id, variance_approved_by_user_id);

-- The 0036 close guard, plus the shift-side derivation of
-- approval_required_by_policy (the shift row is already locked FOR UPDATE).
CREATE OR REPLACE FUNCTION shift_closes_require_open_shift() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state    text;
  v_currency text;
  v_mode     text;
  v_limit    numeric;
  v_policy_currency text;
  v_required text;
BEGIN
  SELECT s.lifecycle_state, s.currency_code, s.frozen_policy_mode,
         s.frozen_policy_limit_amount, s.frozen_policy_currency_code
    INTO v_state, v_currency, v_mode, v_limit, v_policy_currency
    FROM public.shifts s
   WHERE s.shift_id = NEW.shift_id
     AND s.tenant_id = NEW.tenant_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF v_state <> 'open' THEN
    RAISE EXCEPTION 'shift % is not open: it cannot be closed again', NEW.shift_id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- RT-385. No frozen policy: the close is 'unknown' (a 'yes' / 'no' is refused).
  IF v_mode IS NULL THEN
    IF NEW.approval_required_by_policy <> 'unknown' THEN
      RAISE EXCEPTION 'close %: the shift froze no policy, so approval_required_by_policy is unknown', NEW.shift_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- The frozen value decides the close (D-1): approval is required exactly
  -- under a 'limit' with |variance| > limitAmount, never under 'none'. A
  -- frozen limit in a currency other than the shift's (flagged
  -- policy_value_mismatch at open) cannot be compared with the variance: it
  -- FAILS SAFE to 'yes' (coordinator decision, owner to ratify), never a
  -- refusal. With a frozen policy the value is never 'unknown'
  -- (ShiftPolicyMatchesClose): a writer that leaves BOTH values at the
  -- 'unknown' default (the pre-RT-387 writer after an RT-387 rollback, or
  -- during a mixed-version deploy) gets them derived here instead of a
  -- refused close; any other value must match (a half-'unknown' pair is
  -- refused). BEFORE INSERT only: shift_closes has no UPDATE path.
  v_required := CASE
                  WHEN v_mode = 'none' THEN 'no'
                  WHEN v_policy_currency IS DISTINCT FROM v_currency THEN 'yes'
                  WHEN abs(NEW.variance) > v_limit THEN 'yes'
                  ELSE 'no' END;
  IF NEW.approval_required_by_policy = 'unknown' AND NEW.approval_missing = 'unknown' THEN
    NEW.approval_required_by_policy := v_required;
    NEW.approval_missing := CASE WHEN v_required = 'yes'
                                      AND NEW.variance_approved_by_user_id IS NULL
                                 THEN 'yes' ELSE 'no' END;
  ELSIF NEW.approval_required_by_policy <> v_required THEN
    RAISE EXCEPTION 'close %: approval_required_by_policy does not follow the frozen policy', NEW.shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =============================================================================
-- 4. shift_close_approver_checks — the persisted approverCheck verdict
-- =============================================================================

CREATE TABLE shift_close_approver_checks (
  shift_id          UUID         PRIMARY KEY,
  tenant_id         UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id          UUID         NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  -- The close's recorded approver (variance_approved_by_user_id).
  approver_user_id  UUID         NOT NULL REFERENCES users(id)   ON DELETE RESTRICT,
  status            TEXT         NOT NULL,
  reason            TEXT,
  checked_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fk_shift_close_approver_checks_close
    FOREIGN KEY (shift_id, tenant_id, store_id, approver_user_id)
    REFERENCES shift_closes (shift_id, tenant_id, store_id, variance_approved_by_user_id)
    ON DELETE RESTRICT,
  -- not_applicable and the unverified / check_unavailable placeholder are
  -- never stored: they are what a close with no verdict row reads as.
  CONSTRAINT shift_close_approver_checks_status_valid
    CHECK (status IN ('verified', 'unverified')),
  CONSTRAINT shift_close_approver_checks_reason_iff_unverified CHECK (
    (status = 'verified' AND reason IS NULL)
    OR (status = 'unverified' AND reason IS NOT NULL
        AND reason IN ('approver_is_closer', 'inactive_membership', 'not_manager',
                       'no_store_access')))
);

ALTER TABLE shift_close_approver_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_close_approver_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_close_approver_checks_tenant_select ON shift_close_approver_checks
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY shift_close_approver_checks_tenant_insert ON shift_close_approver_checks
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE FUNCTION shift_close_approver_checks_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'An approver verdict is recorded once and never changed (RT-385).';
END
$$;

CREATE TRIGGER shift_close_approver_checks_append_only_row
  BEFORE UPDATE OR DELETE ON shift_close_approver_checks
  FOR EACH ROW EXECUTE FUNCTION shift_close_approver_checks_append_only();
CREATE TRIGGER shift_close_approver_checks_append_only_truncate
  BEFORE TRUNCATE ON shift_close_approver_checks
  FOR EACH STATEMENT EXECUTE FUNCTION shift_close_approver_checks_append_only();

COMMIT;
