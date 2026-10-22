-- 0071_erpnext_posting_rejection_message.sql
--
-- Keep the Connector's rejection message on a dead-lettered posting row (Jira
-- RT-410, AD-POSTING-001 D-1 to D-5; contract `reconciliation.yaml`
-- 1.3.0-draft `PostingBacklogItem.reason`, PR #891). [GATED] migration:
-- owner authorization on RT-410 (comments 13357 and 13396: PR + CI only);
-- number 0071 assigned by the wave-1 coordinator on 2026-10-22 (the "0042" in
-- the issue title is stale). Applying it to the lab, a live database or any
-- deploy is NOT authorized by those comments.
--
-- Today a `permanently_rejected` or `reconciliation_required` ack keeps only
-- the closed `rejection_category`; the Connector's scrubbed message
-- (posting-feed `RejectionReason.message`) is dropped, so the 017 backlog
-- cannot tell an RT-378 representation mismatch, an RT-78 settlement drift, a
-- plain `frappe.ValidationError` and an unclassified exception apart.
--
-- Changes:
--   1. erpnext_posting_status.rejection_message TEXT NULL — the message as
--      Backend-Core stores it after sanitising (control characters removed,
--      credential values redacted, cut to 1000 characters).
--   2. CHECK erpnext_posting_status_rejection_message_length: 1..1000
--      characters (an empty message is stored as NULL).
--   3. CHECK erpnext_posting_status_rejection_message_when_rejected: set only
--      on a `permanently_rejected` row (the 0039
--      reconciliation_ref_when_rejected pattern). A repair re-offer clears it
--      in the same UPDATE that leaves the dead-letter.
-- Both CHECKs are added NOT VALID and validated after COMMIT. No existing row
-- has the column set, so validation cannot fail.
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV) — re-review of 0019.
-- 0019_erpnext_posting_status.sql classified the table "NO PII, NO
-- payment/tender data, NO money/amount" and required a §XIV re-review if that
-- changed. It changes here: `rejection_message` is BUSINESS DATA and
-- PII-SUSPECT free text from an external system. It may embed sale values
-- (item codes, quantities, rates, totals, tender totals) and ERPNext names. It
-- is NOT a money field and is never parsed. Retention: kept only while the
-- row is `permanently_rejected` (CHECK 3); a repair re-offer clears it. It is
-- never logged (length or hash only), never in audit metadata, never a metric
-- label, never sent to Sentry or Datadog, and readable only through the
-- tenant-scoped, authenticated 017 read model. Every other column keeps its
-- 0019 classification.
--
-- Grants: none. The column belongs to a table the domain role already reads
-- and writes.
-- Lock impact: ACCESS EXCLUSIVE on erpnext_posting_status for the nullable ADD
-- COLUMN with no default (catalog-only) and the two NOT VALID CHECKs (no
-- scan); it commits at once. Each VALIDATE then scans the table under SHARE
-- UPDATE EXCLUSIVE, which does not block reads or writes (the posting feed and
-- the acks keep running).
-- Reversible via 0071_erpnext_posting_rejection_message.down.sql.

BEGIN;

ALTER TABLE erpnext_posting_status
  ADD COLUMN rejection_message TEXT;

ALTER TABLE erpnext_posting_status
  ADD CONSTRAINT erpnext_posting_status_rejection_message_length
    CHECK (rejection_message IS NULL OR char_length(rejection_message) BETWEEN 1 AND 1000) NOT VALID,
  ADD CONSTRAINT erpnext_posting_status_rejection_message_when_rejected
    CHECK (rejection_message IS NULL OR status = 'permanently_rejected') NOT VALID;

COMMIT;

ALTER TABLE erpnext_posting_status
  VALIDATE CONSTRAINT erpnext_posting_status_rejection_message_length;

ALTER TABLE erpnext_posting_status
  VALIDATE CONSTRAINT erpnext_posting_status_rejection_message_when_rejected;
