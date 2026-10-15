-- 0046_sale_void_approval.down.sql — reverses 0046_sale_void_approval.sql (RT-530).
--
-- Drops the approval evidence columns. The approval evidence of any approved
-- void is lost with them: the void rows themselves (and their provenance and
-- business_date) are untouched.

BEGIN;

DROP INDEX uq_sale_voids_tenant_approval;

ALTER TABLE sale_voids DROP CONSTRAINT sale_voids_approval_all_or_none;

ALTER TABLE sale_voids
  DROP COLUMN void_business_date,
  DROP COLUMN approved_at,
  DROP COLUMN approval_policy_version,
  DROP COLUMN requested_by_user_id,
  DROP COLUMN approved_by_user_id,
  DROP COLUMN approval_id;

COMMIT;
