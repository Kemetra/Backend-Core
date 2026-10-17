-- 0054_sale_credit_reversals.sql
--
-- Credit-sale reversals (Jira RT-577). [GATED] migration: authored under the
-- coordinator's delegation from the owner; owner approval is required on the
-- PR before merge.
--
-- Source-of-truth decisions:
--   - owner-approved V1 decision (RT-577, 2026-10-17): a sale with payer
--     responsibilities is reversed only by a Manager/Admin through an audited
--     contract; never pay out a credit-funded or uncollected amount;
--   - owner rulings 2026-10-17: D6 (a credit return that pays out cash needs a
--     second, distinct approver), D7 (pro-rata allocation with floor rounding),
--     D8 (a credit void refunds by mirroring the collected tenders);
--   - contract `pos-sales/sales.yaml` 1.11.0-draft (PR #803):
--     `recordCreditSaleReversal`, `CreditSaleReversal`,
--     `CreditReversalRefundTender`, `ReceivableAdjustment`.
--
-- A credit reversal REUSES the ordinary reversal rows: a credit void is a
-- `sale_voids` row and a credit return is a `sale_returns` row (with its
-- `sale_return_lines` / `sale_return_tenders`), so `voided`,
-- `returnedQuantity`, void/return exclusivity, the one-void index and the
-- posting feed's reversal work items are unchanged. This migration adds what
-- those rows cannot carry:
--   1. sale_credit_reversals — one row per credit reversal, linked to exactly
--      one void or return row: the server-computed allocation (reversal total =
--      refundable + receivable adjustment), the payer and adjustment
--      reference, the actor and role, the reason, and the D6 second approval
--      of a cash-paying return. Append-only.
--   2. sale_credit_reversal_tenders — the refund actually paid out, in request
--      order: for a void the mirror of the collected tenders (cash or
--      card_external, D8), for a return cash only. Append-only.
--   3. sale_approval_uses — the shared single-use ledger of approval ids
--      across recordVoid and credit reversals (PK (tenant_id, approval_id)).
--      Backfilled from every tenant's approved voids, then kept filled for
--      every later approved void by the sale_voids_record_approval_use
--      trigger, so the ledger is complete whichever runtime version records
--      the void (the migration runs before the new runtime is live). A credit
--      return inserts its own row.
--
-- SECURITY DEFINER (trigger function): it only inserts the void's own
-- (tenant_id, approval_id) and never reads. As the table owner it needs no
-- grant on sale_approval_uses, so a void recorded by the previous runtime
-- between this migration and the domain grants still succeeds. The owner is
-- subject to FORCE ROW LEVEL SECURITY, so the INSERT policy still binds the
-- row to the session's app.current_tenant. search_path is pinned (0030
-- pattern).
--
-- Backfill under FORCE RLS: the production migration owner is NOT a
-- superuser, so a bare INSERT ... SELECT FROM sale_voids would see no rows.
-- The backfill reads under app.is_platform_admin (tenants) and each tenant's
-- app.current_tenant (sale_voids and the new table), the 0051 down-guard
-- pattern.
--
-- No existing row is modified.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV)
-- ---------------------------------------------------------------------------
-- All three tables are BUSINESS-CLASS: ids, amounts, a role code, a policy
-- version, timestamps and a short reversal reason the contract forbids from
-- carrying PII. The card terminal `reference` is a 1-6 character printed
-- reference, never card data (the SaleTender.reference precedent). Retention
-- inherits the 001 long-horizon insert-only posture of the sale fact.
--
-- Lock duration: `lock_timeout` is 5s (fail fast, re-run: the file is one
-- transaction). Every lock is taken up front:
--   - tenants, stores, sales, sale_returns, payer_account: SHARE ROW
--     EXCLUSIVE (the new tables' foreign keys);
--   - sale_voids: SHARE ROW EXCLUSIVE for the foreign key, its (id, sale_id)
--     index and CREATE TRIGGER (sale_returns likewise gets an (id, sale_id)
--     index),
--     taken BEFORE the backfill and held to COMMIT, so no void can be recorded
--     between the backfill and the trigger. Voids queue for the time of the
--     backfill only (a pilot-sized table).
-- Grants: none here — production grants the domain role SELECT + INSERT on
-- the three tables outside migrations
-- (docs/operations/sql/sale-credit-reversals-domain-grants.sql).
-- Reversible via 0054_sale_credit_reversals.down.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';

LOCK TABLE tenants, stores, sales, sale_returns, payer_account IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE sale_voids IN SHARE ROW EXCLUSIVE MODE;

-- =============================================================================
-- 1. sale_approval_uses — the shared single-use ledger of approval ids
-- =============================================================================

CREATE TABLE sale_approval_uses (
  tenant_id    UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  approval_id  UUID         NOT NULL,
  -- Which route consumed it: a void (recordVoid or a credit void, recorded by
  -- the trigger) or a credit return (recorded by the service).
  source       TEXT         NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT sale_approval_uses_pkey PRIMARY KEY (tenant_id, approval_id),
  CONSTRAINT sale_approval_uses_source_valid CHECK (source IN ('void', 'credit_return'))
);

ALTER TABLE sale_approval_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_approval_uses FORCE ROW LEVEL SECURITY;

CREATE POLICY sale_approval_uses_tenant_read ON sale_approval_uses
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT-only: an approval id once used stays used (no UPDATE / DELETE policy).
CREATE POLICY sale_approval_uses_tenant_insert ON sale_approval_uses
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- Backfill every tenant's approved voids under its own tenant GUC.
DO $$
DECLARE
  t uuid;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    INSERT INTO sale_approval_uses (tenant_id, approval_id, source, created_at)
    SELECT v.tenant_id, v.approval_id, 'void', v.created_at
      FROM sale_voids v
     WHERE v.tenant_id = t AND v.approval_id IS NOT NULL;
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
  PERFORM set_config('app.is_platform_admin', '', true);
END
$$;

CREATE OR REPLACE FUNCTION sale_voids_record_approval_use()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- A duplicate raises 23505 on sale_approval_uses_pkey and aborts the void:
  -- the approval id was already used by a void or a credit return.
  INSERT INTO public.sale_approval_uses (tenant_id, approval_id, source)
  VALUES (NEW.tenant_id, NEW.approval_id, 'void');
  RETURN NULL;
END;
$$;

CREATE TRIGGER sale_voids_record_approval_use
  AFTER INSERT ON sale_voids
  FOR EACH ROW
  WHEN (NEW.approval_id IS NOT NULL)
  EXECUTE FUNCTION sale_voids_record_approval_use();

-- =============================================================================
-- 2. sale_credit_reversals — one row per credit reversal
-- =============================================================================

-- FK targets that tie a credit reversal to a void / return row OF ITS OWN
-- sale. (id is already unique; these add no constraint on existing rows and
-- build under the SHARE ROW EXCLUSIVE locks taken above.)
CREATE UNIQUE INDEX uq_sale_voids_id_sale ON sale_voids (id, sale_id);
CREATE UNIQUE INDEX uq_sale_returns_id_sale ON sale_returns (id, sale_id);

CREATE TABLE sale_credit_reversals (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id                 UUID          NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  sale_id                  UUID          NOT NULL,
  kind                     TEXT          NOT NULL,
  -- Exactly one, matching `kind`: the ordinary reversal row it extends, of
  -- the same sale (composite FKs below).
  void_id                  UUID,
  return_id                UUID,
  source_system            TEXT          NOT NULL,
  external_id              TEXT          NOT NULL,
  payload_hash             TEXT          NOT NULL,
  -- The reversal's own business day: the store-timezone day at insert.
  business_date            DATE          NOT NULL,
  currency_code            CHAR(3)       NOT NULL,
  -- The server-computed allocation (D7): reversal_total = refundable_amount
  -- + adjustment_amount; refundable is the collected share paid out,
  -- adjustment the credit share owed back to the payer.
  reversal_total           NUMERIC(19,4) NOT NULL,
  refundable_amount        NUMERIC(19,4) NOT NULL,
  adjustment_amount        NUMERIC(19,4) NOT NULL,
  payer_id                 UUID          NOT NULL,
  adjustment_ref           UUID,
  actor_user_id            UUID          NOT NULL,
  -- The actor's role code at recording (owner / tenant_admin / store_manager).
  actor_role               TEXT          NOT NULL,
  reason                   TEXT          NOT NULL,
  -- D6: the second approval of a cash-paying credit return (a void's approval
  -- stays on its sale_voids row).
  approval_id              UUID,
  approved_by_user_id      UUID,
  requested_by_user_id     UUID,
  approval_policy_version  TEXT,
  approved_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT sale_credit_reversals_kind_valid CHECK (kind IN ('void', 'return')),
  CONSTRAINT sale_credit_reversals_link_matches_kind CHECK (
    (kind = 'void' AND void_id IS NOT NULL AND return_id IS NULL)
    OR (kind = 'return' AND return_id IS NOT NULL AND void_id IS NULL)
  ),
  CONSTRAINT sale_credit_reversals_currency_code_format CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT sale_credit_reversals_amounts_non_negative
    CHECK (reversal_total >= 0 AND refundable_amount >= 0 AND adjustment_amount >= 0),
  CONSTRAINT sale_credit_reversals_allocation_sums
    CHECK (refundable_amount + adjustment_amount = reversal_total),
  CONSTRAINT sale_credit_reversals_adjustment_ref_iff_adjustment
    CHECK ((adjustment_amount > 0) = (adjustment_ref IS NOT NULL)),
  CONSTRAINT sale_credit_reversals_reason_valid
    CHECK (char_length(reason) BETWEEN 1 AND 500 AND reason ~ '[^[:space:]]'),
  CONSTRAINT sale_credit_reversals_approval_all_or_none CHECK (
    (approval_id IS NULL
       AND approved_by_user_id IS NULL
       AND requested_by_user_id IS NULL
       AND approval_policy_version IS NULL
       AND approved_at IS NULL)
    OR
    (approval_id IS NOT NULL
       AND approved_by_user_id IS NOT NULL
       AND requested_by_user_id IS NOT NULL
       AND approval_policy_version IS NOT NULL
       AND approved_at IS NOT NULL)
  ),
  CONSTRAINT sale_credit_reversals_approval_return_only
    CHECK (approval_id IS NULL OR kind = 'return'),
  CONSTRAINT fk_sale_credit_reversals_sale_tenant_store
    FOREIGN KEY (sale_id, tenant_id, store_id)
    REFERENCES sales (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT fk_sale_credit_reversals_return_tenant_store
    FOREIGN KEY (return_id, tenant_id, store_id)
    REFERENCES sale_returns (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT fk_sale_credit_reversals_void_sale
    FOREIGN KEY (void_id, sale_id)
    REFERENCES sale_voids (id, sale_id) ON DELETE RESTRICT,
  CONSTRAINT fk_sale_credit_reversals_return_sale
    FOREIGN KEY (return_id, sale_id)
    REFERENCES sale_returns (id, sale_id) ON DELETE RESTRICT,
  CONSTRAINT fk_sale_credit_reversals_payer_tenant
    FOREIGN KEY (payer_id, tenant_id)
    REFERENCES payer_account (id, tenant_id) ON DELETE RESTRICT,
  -- Backs the composite FK from the tenders table.
  CONSTRAINT uq_sale_credit_reversals_id_tenant_store UNIQUE (id, tenant_id, store_id),
  CONSTRAINT uq_sale_credit_reversals_void UNIQUE (void_id),
  CONSTRAINT uq_sale_credit_reversals_return UNIQUE (return_id)
);

CREATE UNIQUE INDEX uq_sale_credit_reversals_tenant_source_external
  ON sale_credit_reversals (tenant_id, source_system, external_id);
CREATE INDEX idx_sale_credit_reversals_sale ON sale_credit_reversals (sale_id);
CREATE INDEX idx_sale_credit_reversals_tenant_store ON sale_credit_reversals (tenant_id, store_id);

ALTER TABLE sale_credit_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_credit_reversals FORCE ROW LEVEL SECURITY;

CREATE POLICY sale_credit_reversals_tenant_read ON sale_credit_reversals
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY sale_credit_reversals_tenant_insert ON sale_credit_reversals
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 3. sale_credit_reversal_tenders — the refund paid out (D8)
-- =============================================================================

CREATE TABLE sale_credit_reversal_tenders (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  reversal_id  UUID          NOT NULL,
  tenant_id    UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id     UUID          NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  -- Request order, so a replay echoes the tenders in the order received.
  ordinal      INTEGER       NOT NULL,
  method       TEXT          NOT NULL,
  amount       NUMERIC(19,4) NOT NULL,
  -- The sale tender this refund reverses (D8 mirror); NULL for a legacy tender.
  tender_ref   UUID,
  -- card_external only: the card terminal's printed refund reference.
  reference    TEXT,
  CONSTRAINT sale_credit_reversal_tenders_ordinal_non_negative CHECK (ordinal >= 0),
  CONSTRAINT sale_credit_reversal_tenders_method_valid CHECK (method IN ('cash', 'card_external')),
  CONSTRAINT sale_credit_reversal_tenders_amount_non_negative CHECK (amount >= 0),
  CONSTRAINT sale_credit_reversal_tenders_reference_card_only
    CHECK (reference IS NULL OR (method = 'card_external' AND reference ~ '^[A-Z0-9]{1,6}$')),
  CONSTRAINT fk_sale_credit_reversal_tenders_reversal_tenant_store
    FOREIGN KEY (reversal_id, tenant_id, store_id)
    REFERENCES sale_credit_reversals (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT uq_sale_credit_reversal_tenders_reversal_ordinal UNIQUE (reversal_id, ordinal)
);

CREATE INDEX idx_sale_credit_reversal_tenders_tenant_store
  ON sale_credit_reversal_tenders (tenant_id, store_id);

ALTER TABLE sale_credit_reversal_tenders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_credit_reversal_tenders FORCE ROW LEVEL SECURITY;

CREATE POLICY sale_credit_reversal_tenders_tenant_read ON sale_credit_reversal_tenders
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY sale_credit_reversal_tenders_tenant_insert ON sale_credit_reversal_tenders
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

COMMIT;
