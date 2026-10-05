/**
 * Cashier sale attribution — RT-224 Option B ([GATED] approval: Jira RT-224
 * comment 10889).
 *
 * On captureSale's device-bearer path the body names the cashier
 * (`operatorUserId`). That is a claim, not a credential. This verifier
 * accepts it only when, under the device's tenant (RLS):
 *
 *   1. a `cashier_admissions` row exists for the device's tenant and store,
 *      the SAME device and the claimed user, whose window covers the sale's
 *      `occurredAt`:
 *
 *        created_at <= occurredAt < LEAST(ended_at, expires_at)
 *
 *      - Lower bound inclusive: a sale at the admission instant is covered.
 *      - Upper bound exclusive, matching the admission's own liveness: the
 *        admissions service treats a row as expired once `expires_at <= now`
 *        and as ended from `ended_at` on.
 *      - LEAST ignores a NULL `ended_at` (a live row stops at `expires_at`),
 *        and a row ended lazily AFTER it expired (end_reason 'expired', or a
 *        device end after expiry) still stops at `expires_at`: a late end
 *        never extends a window.
 *      - Ended and expired rows are NOT excluded. An admission that has since
 *        ended or expired still authorizes the sales that occurred inside its
 *        window, because the POS queue drains after sign-out, at end of shift
 *        and after a takeover. Only the window bounds decide.
 *      - Both bounds are server times; `occurredAt` is the POS-reported sale
 *        time, compared in Postgres (microsecond timestamptz), never in JS.
 *
 *   2. the cashier is still eligible, LIVE: the RT-113 BC2 predicate set the
 *      admission itself was granted under (`CashierEligibilityRepository`:
 *      membership active and not deleted, user not deleted, the cashier role,
 *      store active and accessible, profile complete). Reused, not copied.
 *
 * The tenant, store and device always come from the authenticated device row
 * (PosDeviceAuthGuard); nothing here reads scope from the request.
 *
 * Index note: the window lookup reads ended rows too, which the 0035 partial
 * indexes (`WHERE ended_at IS NULL`) do not cover, so Postgres plans a
 * sequential scan of cashier_admissions (measured: ~21 ms at 160k rows,
 * ~41 ms at 400k; sub-millisecond at pilot volume). An index on
 * (tenant_id, device_id, user_id, created_at) makes it an index scan
 * (<1 ms). That is a separate [GATED] migration, proposed in the RT-224 PR.
 *
 * Refusal causes are a closed set. They are logged as fixed event names and
 * never returned: every refusal is the same generic 401.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import {
  CashierEligibilityRepository,
  type CashierEligibilityReader,
  type RefusalReason,
} from "../../pos-cashier-admissions/cashier-eligibility";

export type AttributionRefusal = "no_covering_admission" | RefusalReason;

export type AttributionVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly cause: AttributionRefusal };

export interface OperatorAttributionInput {
  /** From the authenticated device row. */
  readonly tenantId: string;
  /** From the authenticated device row. */
  readonly storeId: string;
  /** The authenticated device. */
  readonly deviceId: string;
  /** The claimed cashier (`operatorUserId`), validated as a UUID. */
  readonly userId: string;
  /** The sale's `occurredAt`, validated as an RFC 3339 instant. */
  readonly occurredAt: string;
}

export interface OperatorAttributionVerifier {
  verify(input: OperatorAttributionInput): Promise<AttributionVerdict>;
}

export const OPERATOR_ATTRIBUTION_VERIFIER = Symbol.for("api.sales.operatorAttributionVerifier");

/**
 * The refusal log's `event` per cause: fixed, code-defined names (redaction
 * matrix §3.4 `event`). One per cause so support can tell them apart without
 * logging the claimed user.
 */
export const ATTRIBUTION_REFUSAL_EVENTS: Readonly<Record<AttributionRefusal, string>> = {
  no_covering_admission: "sale.capture.operator_refused.no_covering_admission",
  membership_inactive: "sale.capture.operator_refused.membership_inactive",
  user_deleted: "sale.capture.operator_refused.user_deleted",
  role_ineligible: "sale.capture.operator_refused.role_ineligible",
  store_inactive: "sale.capture.operator_refused.store_inactive",
  store_not_accessible: "sale.capture.operator_refused.store_not_accessible",
  profile_incomplete: "sale.capture.operator_refused.profile_incomplete",
};

/** $1 tenant, $2 store, $3 device, $4 user, $5 occurredAt. */
export const COVERING_ADMISSION_SQL = `
  SELECT 1
    FROM cashier_admissions
   WHERE tenant_id = $1
     AND store_id  = $2
     AND device_id = $3
     AND user_id   = $4
     AND created_at <= $5::timestamptz
     AND $5::timestamptz < LEAST(ended_at, expires_at)
   LIMIT 1`;

export class PgOperatorAttributionVerifier implements OperatorAttributionVerifier {
  constructor(
    /** The NOBYPASSRLS domain pool (PG_POOL): every read runs under the device's tenant. */
    private readonly pool: Pool,
    private readonly eligibility: CashierEligibilityReader = new CashierEligibilityRepository(),
  ) {}

  async verify(input: OperatorAttributionInput): Promise<AttributionVerdict> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<AttributionVerdict> => {
        const covering = await client.query(COVERING_ADMISSION_SQL, [
          input.tenantId,
          input.storeId,
          input.deviceId,
          input.userId,
          input.occurredAt,
        ]);
        if ((covering.rowCount ?? 0) === 0) return { ok: false, cause: "no_covering_admission" };

        const eligibility = await this.eligibility.check(
          client,
          { tenantId: input.tenantId, storeId: input.storeId, deviceId: input.deviceId },
          input.userId,
        );
        if (!eligibility.eligible) return { ok: false, cause: eligibility.reason };
        return { ok: true };
      },
    );
  }
}
