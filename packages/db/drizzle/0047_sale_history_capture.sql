-- 0047_sale_history_capture.sql
--
-- Store-wide sale history storage, part 1 of 2 (Jira RT-538, RT-534 S2).
-- [GATED] migration — owner-authorized on RT-538 (comment 12079, 2026-10-16):
-- "implement the additive RT-538 migration and merge its PR when all required
-- checks are green and all review comments are resolved". Deploying or running
-- it in any environment is NOT authorized by that comment.
--
-- Contract (RT-537, merged 2b03ad2d; it supersedes the RT-537 comment-12055
-- draft):
--   - pos-sales/sales.yaml 1.9.0-draft: optional CaptureSaleRequest.receipt
--     (CaptureSaleReceipt) and, from RT-539, each line's 1-based position in
--     lines[] stored as its receipt sequence.
--   - pos-sales/sale-history.yaml 1.0.0-draft: SaleHistoryDetail (lines[].sequence,
--     receiptNumber, changeGiven, settledAt, receiptHeader) and recordSaleReprint
--     (SaleReprintRequest / SaleReprint).
--
-- Changes, in order (all additive; no backfill — older rows stay NULL and the
-- history shows those facts as not recorded):
--   1. sales gains the nullable receipt snapshot, one column per
--      CaptureSaleReceipt field:
--        receipt_sale_number            saleNumber            (contract max 96)
--        receipt_number                 receiptNumber         (max 96; only when it
--                                                              differs from saleNumber)
--        receipt_terminal_label         terminalLabel         (max 64)
--        receipt_operator_display_name  operatorDisplayName   (unbounded, as users.display_name)
--        receipt_settled_at             settledAt             (printed time; not a sale fact)
--        receipt_branch_name            branchName            (max 256)
--        receipt_branch_address         branchAddress         (max 512)
--        receipt_tax_registration_id    taxRegistrationId     (max 64)
--        receipt_change_given           changeGiven           (NUMERIC(19,4), >= 0)
--      Lengths are enforced by the capture DTO (RT-539), as for every other sale
--      text column. Two NOT VALID CHECKs:
--        sales_receipt_snapshot_all_or_none: either every receipt column is
--          NULL (no snapshot), or the six header/identity fields are all set
--          (receipt_sale_number, receipt_terminal_label, receipt_settled_at,
--          receipt_branch_name, receipt_branch_address,
--          receipt_tax_registration_id). receipt_number, receipt_change_given
--          and receipt_operator_display_name may be set only with a snapshot.
--          The contract requires operatorDisplayName on capture (RT-539
--          enforces it); the column alone may later be NULL on a snapshot
--          because user erasure tombstones it (see the classification below).
--        sales_receipt_change_given_non_negative.
--   2. sale_lines gains line_seq INTEGER (the line's original receipt position,
--      1-based), with a NOT VALID CHECK that it is >= 1. INTEGER, not SMALLINT:
--      the capture contract does not bound the line count.
--   3. sale_reprints: one row per receipt reprint authorized or recorded through
--      recordSaleReprint (RT-537 D-7). Append-only, tenant RLS like sale_voids;
--      a composite FK pins each reprint to a sale of the same tenant and store.
--      Columns: sale, mode, kind, marks (marked_voided / marked_returned — the
--      SaleReprint.marks enum as two flags, so no invalid or repeated mark can be
--      stored), copy_number, printed_at (the terminal's clock, provenance only),
--      recorded_at (server clock), created_by (the actor: the envelope user, or
--      the admitted cashier on the device path), device_id (the calling
--      terminal; NULL when the request carried none) and idempotency_key.
--      uq_sale_reprints_sale_actor_key backs "a reprint is never counted twice"
--      at the database: the same Idempotency-Key header from the same client for
--      the same sale records once. It is no wider than the replay layer's own
--      scope (the composed key binds the route, the resolved saleRef, the client
--      and the header key; apps/api/src/idempotency/store-key.ts), so a request
--      the layer treats as new is never refused here: one client may reuse a
--      key on another sale.
--
-- The store/business-date list index is migration 0048: CREATE INDEX
-- CONCURRENTLY cannot run inside a transaction block, and this file is one.
--
-- RLS: sales and sale_lines keep their existing tenant policies (FORCE). Store
-- isolation stays an explicit service predicate (RT-538). sale_reprints gets
-- ENABLE + FORCE RLS with SELECT and INSERT tenant policies only: no UPDATE or
-- DELETE policy, so the domain role cannot change or remove a reprint record.
-- No grants change here (see Grants).
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV) — reviewed for RT-538
-- ---------------------------------------------------------------------------
-- sales.receipt_* and sale_lines.line_seq are BUSINESS-CLASS presentation facts
-- of the sale and inherit the sale's 001 long-horizon, insert-only retention:
-- a sale number, a receipt number, the terminal label, a printed time, the
-- STORE's branch name, branch address and tax registration id (business
-- identity printed on every receipt, not a customer's address), the cash change
-- amount and a line position. No customer, card, account or credential data.
-- One exception, classified PII: receipt_operator_display_name is the selling
-- OPERATOR's display name as printed (RT-534 OD-534-6: a display-name snapshot,
-- never an email address). It is workforce personal data that identifies the
-- actor, the same data as users.display_name, and is redacted from logs like
-- it. Erasure: no user-erasure flow exists yet; when one is built it must
-- TOMBSTONE only this column (set it to NULL; the rest of the snapshot and the
-- sale stay), which is why the all-or-none CHECK lets it be NULL on a sale that
-- has a snapshot. A snapshot with a NULL name reads as name not recorded (the
-- RT-539 history shows nameSource unavailable and partial receipt facts). It
-- is never used for authorization, attribution or scope: created_by stays the
-- authenticated actor (FR-061).
-- sale_reprints is BUSINESS-CLASS audit data (opaque UUIDs, enums, flags, a
-- copy number, timestamps and an opaque client key; no receipt content) and
-- inherits the same insert-only retention as the sale it belongs to.
--
-- Grants: none here. No runtime reads or writes these objects until RT-539,
-- which provisions the domain-role grants for sale_reprints (and adds it to
-- DOMAIN_REQUIRED_GRANTS / AUTH_LOOKUP_FORBIDDEN_GRANTS). The auth lookup role
-- is granted per table, so it has no access to the new table.
--
-- Deploy window: none. Every new column is nullable with no default, no
-- existing writer or reader names them, and the previous release keeps working.
--
-- Lock impact: ONE transaction; every lock is held until COMMIT, which is
-- expected within milliseconds because no step scans or rewrites a table. The
-- locks are taken explicitly at the top, light ones first:
--   1. tenants, stores, devices: SHARE ROW EXCLUSIVE (what sale_reprints' FKs
--      need). Writes to them wait until COMMIT (including device-auth writes on
--      devices); reads continue, and sale capture is not blocked (it only needs
--      ROW SHARE on them for its own FKs). Taken BEFORE sales so a wait here
--      never happens while sale traffic is already blocked.
--   2. sales, then sale_lines: ACCESS EXCLUSIVE, for the nullable ADD COLUMNs
--      (metadata-only, no default, no rewrite) and the NOT VALID CHECKs (no
--      scan). Every read and write of these two tables waits for that short
--      window. sale_reprints' composite FK to sales is covered by it.
--   - No index is built on sales or sale_lines here.
-- lock_timeout = 2s, per lock request: if a lock cannot be taken in time (for
-- example behind a long-running transaction on sales), the migration fails and
-- rolls back instead of leaving a queued ACCESS EXCLUSIVE request that blocks
-- all sale traffic behind it. Worst case before it gives up, sale traffic is
-- blocked for about 2 x 2s: the queued request on sales, then the one on
-- sale_lines while sales is held. The light locks in step 1 can wait up to 2s
-- each without blocking sale traffic. On failure, `migrate up` exits non-zero
-- with nothing applied; the running release keeps serving; re-run it.
-- Reversible via 0047_sale_history_capture.down.sql.

BEGIN;

SET LOCAL lock_timeout = '2s';

LOCK TABLE tenants, stores, devices IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE sales, sale_lines IN ACCESS EXCLUSIVE MODE;

-- =============================================================================
-- 1. sales: the receipt snapshot
-- =============================================================================
ALTER TABLE sales
  ADD COLUMN receipt_sale_number            TEXT,
  ADD COLUMN receipt_number                 TEXT,
  ADD COLUMN receipt_terminal_label         TEXT,
  ADD COLUMN receipt_operator_display_name  TEXT,
  ADD COLUMN receipt_settled_at             TIMESTAMPTZ,
  ADD COLUMN receipt_branch_name            TEXT,
  ADD COLUMN receipt_branch_address         TEXT,
  ADD COLUMN receipt_tax_registration_id    TEXT,
  ADD COLUMN receipt_change_given           NUMERIC(19,4);

ALTER TABLE sales
  ADD CONSTRAINT sales_receipt_snapshot_all_or_none CHECK (
    (receipt_sale_number IS NULL
       AND receipt_terminal_label IS NULL
       AND receipt_operator_display_name IS NULL
       AND receipt_settled_at IS NULL
       AND receipt_branch_name IS NULL
       AND receipt_branch_address IS NULL
       AND receipt_tax_registration_id IS NULL
       AND receipt_number IS NULL
       AND receipt_change_given IS NULL)
    OR
    (receipt_sale_number IS NOT NULL
       AND receipt_terminal_label IS NOT NULL
       AND receipt_settled_at IS NOT NULL
       AND receipt_branch_name IS NOT NULL
       AND receipt_branch_address IS NOT NULL
       AND receipt_tax_registration_id IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT sales_receipt_change_given_non_negative
    CHECK (receipt_change_given IS NULL OR receipt_change_given >= 0) NOT VALID;

-- =============================================================================
-- 2. sale_lines: the original receipt position
-- =============================================================================
ALTER TABLE sale_lines
  ADD COLUMN line_seq INTEGER;

ALTER TABLE sale_lines
  ADD CONSTRAINT sale_lines_line_seq_positive
    CHECK (line_seq IS NULL OR line_seq >= 1) NOT VALID;

-- =============================================================================
-- 3. sale_reprints: the reprint record
-- =============================================================================
CREATE TABLE sale_reprints (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id          UUID         NOT NULL,
  tenant_id        UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id         UUID         NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  mode             TEXT         NOT NULL,
  kind             TEXT         NOT NULL,
  marked_voided    BOOLEAN      NOT NULL,
  marked_returned  BOOLEAN      NOT NULL,
  copy_number      INTEGER      NOT NULL,
  printed_at       TIMESTAMPTZ  NOT NULL,
  recorded_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by       UUID         NOT NULL,
  device_id        UUID         REFERENCES devices(id) ON DELETE RESTRICT,
  idempotency_key  TEXT         NOT NULL,
  CONSTRAINT sale_reprints_mode_valid CHECK (mode IN ('authorize', 'record')),
  CONSTRAINT sale_reprints_kind_valid CHECK (kind IN ('duplicate', 'sale_record')),
  CONSTRAINT sale_reprints_copy_number_positive CHECK (copy_number >= 1),
  CONSTRAINT fk_sale_reprints_sale_tenant_store
    FOREIGN KEY (sale_id, tenant_id, store_id)
    REFERENCES sales (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT uq_sale_reprints_sale_actor_key
    UNIQUE (tenant_id, store_id, sale_id, created_by, idempotency_key)
);

-- The detail read and the next server copy number are per sale. A
-- (tenant_id, store_id) index would duplicate the unique key's leading columns.
CREATE INDEX idx_sale_reprints_sale ON sale_reprints (sale_id);

ALTER TABLE sale_reprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_reprints FORCE ROW LEVEL SECURITY;

CREATE POLICY sale_reprints_tenant_read ON sale_reprints
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY sale_reprints_tenant_insert ON sale_reprints
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

COMMIT;
