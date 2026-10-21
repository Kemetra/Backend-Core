### Added
- RT-530 `[GATED]`, owner-approved 2026-10-15 (RT-530 comment 11988):
  manager-approved sale void. `POST /api/pos/v1/sales/{saleRef}/void` now
  needs a bound RT-114 manager approval (`approval`) and the void's
  `businessDate`; without a valid one it is refused. `pos-sales/sales.yaml`
  1.8.0-draft adds both fields as optional in shape (additive) and the 403
  `void_approval_required` / `void_self_approval` / `void_approver_not_eligible`
  and 422 `void_approval_invalid` / `void_outside_business_day` refusals. The
  approver must be an owner, tenant_admin or store_manager of the tenant with
  access to the sale's store, and neither the requester nor the selling
  operator; the requester must be the authenticated envelope operator (403
  `void_requester_mismatch`) and a user of the tenant with access to the store; the void must be on the sale's business day. A replay answers
  before these checks. Migration 0046 adds the approval evidence columns to
  `sale_voids` (all NULL for earlier voids); the `sale.voided` audit event
  carries the approver. The server re-validates every claim of the evidence but
  cannot prove that a PIN was typed on the terminal.
