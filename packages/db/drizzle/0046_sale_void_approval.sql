-- 0046_sale_void_approval.sql
--
-- Manager-approved sale void (Jira RT-530).
-- [GATED] migration — owner-authorized on RT-530 (comment 11988, 2026-10-15):
-- "the Backend-Core [GATED] contract change (an additive approval field on
-- POST /api/pos/v1/sales/:saleRef/void, plus server-side enforcement)".
--
-- Source-of-truth decisions (RT-530 comment 11988):
--   - A finalized sale is voided only with a bound RT-114 Manager Approval
--     PIN approval from a store_manager-or-above approver with access to the
--     sale's store; approver != requester and != the sale's selling operator.
--   - Same business day only; offline-captured voids are re-validated on
--     arrival.
--   - packages/contracts/openapi/pos-sales/sales.yaml 1.8.0-draft
--     (`RecordVoidRequest.approval` / `.businessDate`).
--
-- Changes, in order:
--   1. sale_voids gains the approval evidence the server accepted, all NULL for
--      every pre-0046 void (no backfill, never derived):
--        approval_id               the terminal's RT-114 approval id
--        approved_by_user_id       the approving manager's users.id
--        requested_by_user_id      the requesting operator's users.id (as stated;
--                                  created_by stays the authenticated envelope actor)
--        approval_policy_version   the RT-114 policy version the approval ran under
--        approved_at               when the terminal recorded the approval (device clock)
--        void_business_date        the DEVICE-claimed business day, checked equal to
--                                  sales.business_date. business_date keeps its
--                                  meaning (the store day the server recorded the
--                                  void; the posting feed reads it).
--   2. sale_voids_approval_all_or_none: the six columns are all NULL (a legacy
--      void) or all set (an approved one). NOT VALID: every existing row is NULL
--      by construction, so nothing is scanned; new rows are checked.
--   3. uq_sale_voids_tenant_approval: an approval id is single-use within a
--      tenant (RT-114 C7), as a partial unique index over approved voids.
--
-- Append-only is unchanged: sale_voids keeps its SELECT + INSERT-only policies
-- (0012); no UPDATE or DELETE policy is added. No grants change.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV) — reviewed for RT-530
-- ---------------------------------------------------------------------------
-- The columns hold opaque UUIDs (the approval and two users.id references),
-- a policy-version label and two timestamps/dates. No PIN, credential,
-- customer or payment data is stored (the PIN never leaves the terminal).
-- They are BUSINESS-CLASS audit facts of the void and inherit sale_voids'
-- long-horizon insert-only retention.
--
-- Lock duration: ACCESS EXCLUSIVE on sale_voids for the six nullable
-- ADD COLUMNs (metadata-only) and the NOT VALID CHECK (no scan); the unique
-- index builds under SHARE over a pilot-sized table.
-- Reversible via 0046_sale_void_approval.down.sql.

BEGIN;

ALTER TABLE sale_voids
  ADD COLUMN approval_id              UUID,
  ADD COLUMN approved_by_user_id      UUID,
  ADD COLUMN requested_by_user_id     UUID,
  ADD COLUMN approval_policy_version  TEXT,
  ADD COLUMN approved_at              TIMESTAMPTZ,
  ADD COLUMN void_business_date       DATE;

ALTER TABLE sale_voids
  ADD CONSTRAINT sale_voids_approval_all_or_none CHECK (
    (approval_id IS NULL
       AND approved_by_user_id IS NULL
       AND requested_by_user_id IS NULL
       AND approval_policy_version IS NULL
       AND approved_at IS NULL
       AND void_business_date IS NULL)
    OR
    (approval_id IS NOT NULL
       AND approved_by_user_id IS NOT NULL
       AND requested_by_user_id IS NOT NULL
       AND approval_policy_version IS NOT NULL
       AND approved_at IS NOT NULL
       AND void_business_date IS NOT NULL)
  ) NOT VALID;

CREATE UNIQUE INDEX uq_sale_voids_tenant_approval
  ON sale_voids (tenant_id, approval_id)
  WHERE approval_id IS NOT NULL;

COMMIT;
