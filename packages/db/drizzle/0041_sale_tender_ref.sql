-- 0041_sale_tender_ref.sql
--
-- Sale tender-line identity (Jira RT-360).
-- [GATED] migration — owner-authorized on RT-360 (comment 11515).
--
-- Source-of-truth decisions:
--   - RT-264 D1–D4 (comments 11483 / 11485): the POS mints `tenderRef` (its
--     tender line id); legacy tenders are addressed by (sale, method) with no
--     backfill; the wire name is `tenderRef`; ERPNext does not store it.
--   - Sales & Returns 1003–1005: every tender line has a stable independent
--     identity; tender method is not tender identity; several lines may share
--     a method.
--   - packages/contracts/openapi/pos-sales/sales.yaml 1.7.0-draft (RT-359,
--     `SaleTender.tenderRef` / `sequence`).
--
-- Changes, in order:
--   1. sale_tenders.tender_ref UUID NULL — the tender line's Retail identity,
--      written from the capture body. NULL for every pre-0041 tender (no
--      backfill, never derived).
--   2. sale_tenders.sequence SMALLINT NULL — the line's 1-based apply order,
--      CHECK >= 1 (NOT VALID: every existing row is NULL by construction).
--   3. One-per-method becomes legacy-only: uq_sale_tenders_sale_method is
--      replaced by the partial unique index uq_sale_tenders_sale_method_legacy
--      (sale_id, method) WHERE tender_ref IS NULL. Ref-bearing tenders may share
--      a method; they are unique by uq_sale_tenders_sale_tender_ref instead.
--      Whether the API accepts same-method tenders at all is the default-off
--      POS_SALE_TENDERS_SAME_METHOD_ENABLED deploy flag (after RT-361).
--   4. uq_sale_tenders_sale_sequence (sale_id, sequence) WHERE sequence IS NOT NULL.
--   5. sales_tender_count_range drops its upper bound of 2 (one per method);
--      the count is still >= 0 and bounded by SMALLINT.
--
-- Tenders stay part of the immutable sale fact (ADR-0005, not a payment
-- ledger). No existing row is modified. RLS and policies on sale_tenders are
-- unchanged (SELECT + INSERT only).
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV) — re-reviewed for RT-360
-- ---------------------------------------------------------------------------
-- tender_ref is an opaque UUID minted by the POS for its own tender line; it
-- carries no card, account or customer data. sequence is an ordinal. Both are
-- BUSINESS-CLASS sale facts with no PII. Retention inherits sale_tenders'
-- long-horizon insert-only posture.
--
-- Lock duration: sale_tenders takes ACCESS EXCLUSIVE for the two ADD COLUMNs
-- (nullable, metadata-only) and the NOT VALID CHECK (no scan); the three
-- CREATE UNIQUE INDEX statements build under SHARE (writes wait, reads do not)
-- over a pilot-sized table. sales takes ACCESS EXCLUSIVE only to swap a CHECK,
-- added NOT VALID (no scan). Grants: none here.
-- Reversible via 0041_sale_tender_ref.down.sql, which refuses while any sale
-- holds same-method tenders.

BEGIN;

-- =============================================================================
-- 1–2. sale_tenders: the tender line's identity and apply order
-- =============================================================================

ALTER TABLE sale_tenders
  ADD COLUMN tender_ref UUID,
  ADD COLUMN sequence   SMALLINT;

ALTER TABLE sale_tenders
  ADD CONSTRAINT sale_tenders_sequence_positive
    CHECK (sequence IS NULL OR sequence >= 1) NOT VALID;

-- =============================================================================
-- 3–4. uniqueness: legacy one-per-method, ref and sequence per sale
-- =============================================================================

CREATE UNIQUE INDEX uq_sale_tenders_sale_method_legacy
  ON sale_tenders (sale_id, method) WHERE tender_ref IS NULL;

ALTER TABLE sale_tenders DROP CONSTRAINT uq_sale_tenders_sale_method;

CREATE UNIQUE INDEX uq_sale_tenders_sale_tender_ref
  ON sale_tenders (sale_id, tender_ref) WHERE tender_ref IS NOT NULL;

CREATE UNIQUE INDEX uq_sale_tenders_sale_sequence
  ON sale_tenders (sale_id, sequence) WHERE sequence IS NOT NULL;

-- =============================================================================
-- 5. sales.tender_count: no longer capped at one per method
-- =============================================================================

ALTER TABLE sales DROP CONSTRAINT sales_tender_count_range;
ALTER TABLE sales
  ADD CONSTRAINT sales_tender_count_range CHECK (tender_count >= 0) NOT VALID;

COMMIT;
