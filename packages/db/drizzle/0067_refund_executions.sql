-- 0067_refund_executions.sql
--
-- Refund allocation and refund execution storage (Jira RT-787, RT-271 F-2).
-- [GATED] migration: authorized on RT-787 (comment 13359; owner decision
-- relayed 2026-10-22, Jira 13392) for PR + CI only, never applied to a lab or
-- live database from this change.
--
-- Source-of-truth decisions:
--   - RT-271 c11872 (planning record) and c11886 (owner ratification of
--     R-1..R-12): acceptance, allocation and execution are distinct facts;
--     the obligation is derived, never stored (RT-277);
--   - contract `pos-sales/sales.yaml` 1.13.0-draft (RT-490, PR #879):
--     `RefundTender` allocation fields, `recordRefundExecution`, the R-7
--     settle-before-post emit rule (`erpnext-connector/posting-feed.yaml`
--     1.9.0-draft).
--
-- Changes, in order:
--   1. sale_return_tenders becomes the refund ALLOCATION (R-2): nullable
--      allocation_ref (POS-minted, unique within its return), original_tender_ref
--      (the sale tender line it is refunded against) and instrument ('cash'
--      only, RT-14 D3 / R-12). No backfill: an allocation recorded before
--      RT-787 carries none, and its return's settlement is not tracked.
--      original_tender_ref is pinned to a tender of the SAME tenant and sale by
--      the BEFORE INSERT trigger sale_return_tenders_original_tender_check. A
--      composite FK cannot do it: sale_return_tenders has no sale_id column,
--      and the tender_ref unique on sale_tenders is partial (WHERE tender_ref
--      IS NOT NULL, 0041), which a foreign key cannot reference.
--   2. sale_returns.posting_deferred BOOLEAN NOT NULL DEFAULT false (R-7):
--      true when the return was accepted with the settle-before-post flag on,
--      allocationRef on its allocations and a non-zero total, so it is posted
--      by the execution that settles it, never at acceptance. A constant
--      default: no table rewrite, and a writer that predates it (a rolling
--      deploy) records false, which posts at acceptance as before.
--   3. refund_executions — the REFUND EXECUTION (R-1, R-3, R-4): one
--      append-only row per settled cash payout of one allocation. ONE table
--      with outcome = 'settled', not the execution plus outcome-event tables of
--      the F-2 draft (c11872): the contract accepts only `settled` for the
--      pilot (R-4), so an outcome-event table would stay empty until a
--      post-pilot version adds `requested` / `failed` / `unknown`. Approved by
--      the coordinator, 2026-10-22.
--      - execution_ref is unique per TENANT, not globally: a global unique on
--        a client-minted id would let one tenant probe another's ids.
--      - provenance (tenant_id, source_system, external_id) is unique (R-3).
--      - the composite FKs pin an execution to its return and to an
--        allocation OF that return with the same allocation_ref.
--      - settles_return marks the execution whose amount brought a deferred
--        return's settled total to its return_total; at most one per return
--        (uq_refund_executions_one_settling), the database backstop for the
--        exactly-once R-7 posting emit.
--      The per-allocation cap (Σ executions ≤ allocation amount) is enforced
--      by the service under the `sales` row lock, as the return quantity cap.
--
-- No existing row is modified.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV)
-- ---------------------------------------------------------------------------
-- refund_executions is BUSINESS-CLASS: ids, an amount, the evidence method
-- ('drawer' or 'manual'), the device-reported payout time, the shift id and
-- provenance. No card, account or customer data. The allocation columns are
-- POS-minted opaque ids and the 'cash' instrument (still cash only, so SI-012
-- is not re-triggered). Retention inherits the 001 long-horizon insert-only
-- posture of the sale fact.
--
-- Lock duration: `lock_timeout` is 5s (fail fast, re-run: the file is one
-- transaction). tenants and stores take SHARE ROW EXCLUSIVE up front (the new
-- foreign keys); sale_returns and sale_return_tenders take ACCESS EXCLUSIVE up
-- front for the ADD COLUMNs (catalog-only: nullable or constant default, no
-- rewrite), the new indexes and the trigger, so returns and return reads wait
-- for the whole file. Index builds are proportional to the return tables
-- (pilot-sized).
-- Grants: none here; production grants the domain role SELECT + INSERT on
-- refund_executions outside migrations
-- (docs/operations/sql/refund-executions-domain-grants.sql).
-- Reversible via 0067_refund_executions.down.sql, which refuses while any
-- execution or allocation data exists.

BEGIN;

SET LOCAL lock_timeout = '5s';

LOCK TABLE tenants, stores IN SHARE ROW EXCLUSIVE MODE;
-- Both are altered below: take the ALTER's lock up front instead of upgrading
-- a weaker one mid-transaction (no lock-upgrade deadlock with a writer).
LOCK TABLE sale_returns, sale_return_tenders IN ACCESS EXCLUSIVE MODE;

-- =============================================================================
-- 1. sale_return_tenders: the refund allocation (R-2)
-- =============================================================================

ALTER TABLE sale_return_tenders
  ADD COLUMN allocation_ref UUID,
  ADD COLUMN original_tender_ref UUID,
  ADD COLUMN instrument TEXT,
  -- RT-14 D3 / R-12: cash only for the pilot; absent on the wire means cash.
  ADD CONSTRAINT sale_return_tenders_instrument_valid
    CHECK (instrument IS NULL OR instrument IN ('cash'));

-- An allocationRef is unique within its return (RT-490 rule 1).
CREATE UNIQUE INDEX uq_sale_return_tenders_return_allocation
  ON sale_return_tenders (return_id, allocation_ref) WHERE allocation_ref IS NOT NULL;

-- FK target for refund_executions: an allocation of THIS return with THIS ref.
-- (id is already unique; this adds no constraint on existing rows.)
CREATE UNIQUE INDEX uq_sale_return_tenders_id_return_allocation
  ON sale_return_tenders (id, return_id, allocation_ref);

-- Pin original_tender_ref to a tender of the same tenant and sale. SECURITY
-- INVOKER: the tender is read under the writer's own tenant GUC, so another
-- tenant's tender is invisible and refused like an unknown one.
CREATE FUNCTION sale_return_tenders_original_tender_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.sale_returns r
      JOIN public.sale_tenders t ON t.sale_id = r.sale_id
     WHERE r.id = NEW.return_id
       AND t.tenant_id = NEW.tenant_id
       AND t.tender_ref = NEW.original_tender_ref
  ) THEN
    RAISE EXCEPTION 'original_tender_ref % is not a tender of the return''s sale', NEW.original_tender_ref
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER sale_return_tenders_original_tender_check
  BEFORE INSERT ON sale_return_tenders
  FOR EACH ROW
  WHEN (NEW.original_tender_ref IS NOT NULL)
  EXECUTE FUNCTION sale_return_tenders_original_tender_check();

-- =============================================================================
-- 2. sale_returns.posting_deferred (R-7)
-- =============================================================================

ALTER TABLE sale_returns ADD COLUMN posting_deferred BOOLEAN NOT NULL DEFAULT false;

-- =============================================================================
-- 3. refund_executions — one settled cash payout of one allocation
-- =============================================================================

CREATE TABLE refund_executions (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  -- POS-minted (UUIDv7), part of the payload (R-3).
  execution_ref    UUID          NOT NULL,
  return_id        UUID          NOT NULL,
  allocation_id    UUID          NOT NULL,
  sale_id          UUID          NOT NULL,
  tenant_id        UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id         UUID          NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  allocation_ref   UUID          NOT NULL,
  amount           NUMERIC(19,4) NOT NULL,
  outcome          TEXT          NOT NULL,
  evidence_method  TEXT          NOT NULL,
  -- Device clock, as reported (at most 120 s ahead of the server, checked by
  -- the service).
  paid_at          TIMESTAMPTZ   NOT NULL,
  -- The shift whose drawer paid; recorded as reported, bound by closeShift
  -- (R-9, F-3).
  shift_ref        UUID          NOT NULL,
  source_system    TEXT          NOT NULL,
  external_id      TEXT          NOT NULL,
  payload_hash     TEXT          NOT NULL,
  created_by       UUID          NOT NULL,
  -- The execution that settled a return deferred at acceptance (R-7).
  settles_return   BOOLEAN       NOT NULL DEFAULT false,
  -- Server clock taken under the sales row lock (clock_timestamp(), not the
  -- transaction start), so (recorded_at, execution_ref) is the commit order.
  recorded_at      TIMESTAMPTZ   NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT refund_executions_amount_positive CHECK (amount > 0),
  -- R-4: the pilot reports settled executions only.
  CONSTRAINT refund_executions_outcome_valid CHECK (outcome IN ('settled')),
  CONSTRAINT refund_executions_evidence_method_valid CHECK (evidence_method IN ('drawer', 'manual')),
  CONSTRAINT refund_executions_source_system_length CHECK (char_length(source_system) BETWEEN 1 AND 100),
  CONSTRAINT refund_executions_external_id_length CHECK (char_length(external_id) BETWEEN 1 AND 200),
  CONSTRAINT fk_refund_executions_return_tenant_store
    FOREIGN KEY (return_id, tenant_id, store_id)
    REFERENCES sale_returns (id, tenant_id, store_id) ON DELETE RESTRICT,
  -- The return belongs to this sale (uq_sale_returns_id_sale, 0054).
  CONSTRAINT fk_refund_executions_return_sale
    FOREIGN KEY (return_id, sale_id)
    REFERENCES sale_returns (id, sale_id) ON DELETE RESTRICT,
  -- The allocation belongs to this return and carries this allocation_ref.
  CONSTRAINT fk_refund_executions_allocation
    FOREIGN KEY (allocation_id, return_id, allocation_ref)
    REFERENCES sale_return_tenders (id, return_id, allocation_ref) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_refund_executions_tenant_source_external
  ON refund_executions (tenant_id, source_system, external_id);
CREATE UNIQUE INDEX uq_refund_executions_tenant_execution_ref
  ON refund_executions (tenant_id, execution_ref);
CREATE UNIQUE INDEX uq_refund_executions_one_settling
  ON refund_executions (return_id) WHERE settles_return;
CREATE INDEX idx_refund_executions_return ON refund_executions (return_id);
CREATE INDEX idx_refund_executions_allocation ON refund_executions (allocation_id);
CREATE INDEX idx_refund_executions_tenant_store ON refund_executions (tenant_id, store_id);

ALTER TABLE refund_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund_executions FORCE ROW LEVEL SECURITY;

CREATE POLICY refund_executions_tenant_read ON refund_executions
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT-only: a settled execution is never edited or rolled back (Sales &
-- Returns 1063); no UPDATE / DELETE policy.
CREATE POLICY refund_executions_tenant_insert ON refund_executions
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

COMMIT;
