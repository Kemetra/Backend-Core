-- Re-head the credit sales the posting feed held (RT-418 hold lift).
-- See deploy/README.md, "Enabling credit posting", and
-- apps/api/src/catalog/erpnext-posting/responsibilities-feed-gate.ts.
--
-- Why: while ERPNEXT_FEED_RESPONSIBILITIES_ENABLED is off, the feed holds the
-- `sale_post` of every sale with payer responsibilities (the RT-417 ROLLOUT
-- ORDER: the Connector posts them only from RT-419). A held row keeps its feed
-- `sequence`, and a Connector whose cursor has already moved past it would
-- never see it. Run this script ONCE, right AFTER the API runs with the gate
-- on: it gives each such row a fresh sequence ahead of every cursor, so the
-- Connector is offered it again.
--
-- It moves only the rows the gate held: pending `sale_post` rows whose sale
-- has responsibilities, all of them visible, and no void, refund or return.
-- Rows held for another reason (a reversal, a reversed sale) keep their place.
-- Each tenant's rows move under that tenant's posting-feed sequence lock
-- (`lockPostingFeedSequence`, the same lock the outcome ack takes), so the
-- feed cursor can never skip a re-headed row. Re-running it only offers the
-- same rows again, which the Connector's exactly-once keys absorb.
--
-- Run it as the migration owner, with the connection in libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument:
--   psql -X -f docs/operations/sql/sale-responsibilities-feed-rehead.sql
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP).

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  t uuid;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  -- A session that set app.current_tenant before holds '' (not NULL) after
  -- that transaction, and the tenants policy casts it to uuid: start from a
  -- valid nil uuid so the policy evaluates (is_platform_admin admits all).
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants ORDER BY id LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    PERFORM pg_advisory_xact_lock(hashtextextended('erpnext-posting-feed' || ':' || t::text, 0));
    UPDATE erpnext_posting_status ps
       SET sequence = DEFAULT, updated_at = now()
      FROM sales s
     WHERE ps.tenant_id = t
       AND ps.status = 'pending'
       AND ps.kind = 'sale_post'
       AND s.id = ps.sale_id
       AND s.responsibility_count > 0
       AND (SELECT count(*) FROM sale_responsibilities sr WHERE sr.sale_id = s.id) = s.responsibility_count
       AND NOT EXISTS (SELECT 1 FROM sale_voids v WHERE v.sale_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM sale_refunds f WHERE f.sale_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM sale_returns r WHERE r.sale_id = s.id);
  END LOOP;
END
$$;

COMMIT;

\echo 'OK: held credit sale_post rows re-headed.'
