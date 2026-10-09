-- 0039_erpnext_posting_reconciliation_evidence.sql
--
-- Reconciliation evidence for a posting dead-letter (Jira RT-332, RT-326
-- decision 2). [GATED] migration — owner-authorized in-session on 2026-10-09
-- ("go as recommended, i authorize all three"; RT-326 comment 11296, which
-- records "the existing ERP document kept as evidence").
--
-- A connector `reconciliation_required` ack (or a `posted` ack from a
-- superseded resolution version) reports an EXISTING ERP document that does not
-- match the intent's frozen resolution. The row is dead-lettered with
-- rejection_category = 'reconciliation_required'; this column keeps the
-- document the connector reported, so the operator backlog shows WHICH document
-- to reconcile (ERP Integration baseline: expected, actual and evidence stay
-- explicit). It is separate from `document_ref`, which stays set only on a
-- `posted` row (erpnext_posting_status_document_ref_when_posted).
--
-- Changes:
--   1. erpnext_posting_status.reconciliation_document_ref TEXT NULL — the
--      reported ErpnextDocumentRef ({doctype,name}) as JSON text, the same
--      encoding as `document_ref`.
--   2. CHECK: set only on a `permanently_rejected` row.
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS-CLASS (an ERP document
-- reference). No PII, no money.
-- Grants: none — the column belongs to a table the domain role already uses.
-- Lock duration: ACCESS EXCLUSIVE on erpnext_posting_status for a nullable ADD
-- COLUMN with no default (catalog-only) and a CHECK validated over the table;
-- nothing else runs in this transaction.
-- Reversible via 0039_erpnext_posting_reconciliation_evidence.down.sql.

BEGIN;

ALTER TABLE erpnext_posting_status
  ADD COLUMN IF NOT EXISTS reconciliation_document_ref TEXT;

ALTER TABLE erpnext_posting_status
  ADD CONSTRAINT erpnext_posting_status_reconciliation_ref_when_rejected
    CHECK (reconciliation_document_ref IS NULL OR status = 'permanently_rejected');

COMMIT;
