-- 0071_erpnext_posting_rejection_message.down.sql
--
-- Rollback for 0071_erpnext_posting_rejection_message.sql (RT-410). Drops the
-- two CHECKs and the `rejection_message` column. The stored Connector messages
-- of the current dead-letters are LOST (the rows, their category and their
-- evidence stay); they are diagnostic text only, kept while a row is
-- dead-lettered, and the 1.3.0-draft backlog answers `reason: null` for them,
-- which the contract allows. Supports the UP -> DOWN -> UP round-trip exercised
-- by packages/db/__tests__/migration/0071-erpnext-posting-rejection-message.spec.ts.

BEGIN;

ALTER TABLE erpnext_posting_status
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_rejection_message_when_rejected,
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_rejection_message_length;

ALTER TABLE erpnext_posting_status
  DROP COLUMN IF EXISTS rejection_message;

COMMIT;
