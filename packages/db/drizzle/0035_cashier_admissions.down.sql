-- 0035_cashier_admissions.down.sql
--
-- Rollback for 0035_cashier_admissions.sql (RT-113 BC2). Drops the
-- idempotency store first (it references cashier_admissions), then the
-- admissions table with its policies, indexes, the (tenant_id, id) unique
-- key and the composite FKs that reference it. Live admissions are LOST on
-- rollback: every cashier must sign in online again. Take a backup first if
-- the admission history matters.

BEGIN;

DROP TABLE IF EXISTS cashier_admission_requests;
DROP TABLE IF EXISTS cashier_admissions;

COMMIT;
