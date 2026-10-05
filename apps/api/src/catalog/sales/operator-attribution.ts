/**
 * Cashier sale attribution — RT-224 Option B ([GATED] approval: Jira RT-224
 * comment 10889).
 *
 * On captureSale's device-bearer path the body names the cashier
 * (`operatorUserId`). That is a claim, not a credential. This verifier
 * accepts it only when, under the device's tenant (RLS):
 *
 *   0. `occurredAt` is at most CLOCK_SKEW_TOLERANCE after the server's now()
 *      (rev709 F3: no future-dated sale).
 *
 *   1. a `cashier_admissions` row exists for the device's tenant and store,
 *      the SAME device and the claimed user, whose window, widened by
 *      CLOCK_SKEW_TOLERANCE on both edges (rev709 F2), covers the sale's
 *      `occurredAt`:
 *
 *        created_at - 120 s <= occurredAt < LEAST(ended_at, expires_at) + 120 s
 *
 *      - The tolerance absorbs a till clock that drifts from the server's:
 *        the bounds are server times, `occurredAt` is the till's.
 *      - Lower bound inclusive, upper bound exclusive. Without the tolerance
 *        the upper bound matches the admission's own liveness: the admissions
 *        service treats a row as expired once `expires_at <= now` and as
 *        ended from `ended_at` on.
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
 *      - Back-dating cap (rev709 F3): the covering window must have ended no
 *        more than MAX_WINDOW_AGE ago (`now() - LEAST(ended_at, expires_at)
 *        <= 7 days`), so an old admission cannot authorize sales forever.
 *
 *      Offline coverage (a sale after the admission TTL, before a
 *      `reconcile_offline` row, or after a takeover on an offline till) is
 *      NOT covered here: deferred to RT-113 P3/P4 (offline-grant provenance).
 *      Such a sale is refused and can be repaired on the manager-envelope
 *      path.
 *
 *   2. the cashier is still eligible, LIVE: the RT-113 BC2 predicate set the
 *      admission itself was granted under (`CashierEligibilityRepository`:
 *      membership active and not deleted, user not deleted, the cashier role,
 *      store active and accessible, profile complete). Reused, not copied.
 *
 * RT-225 ([GATED] approval: Jira RT-225, owner, 2026-10-05; sales.yaml
 * 1.6.0-draft): the body may carry `admissionCheckAt`, the till's instant at
 * which the cashier's admission held for the sale (its settled time; a sale
 * finalized later, e.g. by boot recovery, has a later `occurredAt`). Then
 *
 *        checkAt = admissionCheckAt ?? occurredAt
 *
 * replaces `occurredAt` ONLY in the window comparison of step 1. The
 * future-dating cap of step 0 stays on `occurredAt` and ALSO applies to
 * `checkAt` (the later of the two is capped); the back-dating cap is
 * unchanged. A refusal is the same generic 403 with the same closed-set
 * events. The DTO has already required `operatorUserId`, `checkAt <=
 * occurredAt` and a gap of at most 7 days; this verifier does not rely on it.
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
 * never returned: every refusal is the same generic 403 `refused` (the
 * device itself authenticated; SaleCaptureAuthGuard).
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import {
  CashierEligibilityRepository,
  type CashierEligibilityReader,
  type RefusalReason,
} from "../../pos-cashier-admissions/cashier-eligibility";

export type AttributionRefusal =
  | "future_dated"
  | "no_covering_admission"
  | "admission_too_old"
  | RefusalReason;

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
  /**
   * RT-225: the body's `admissionCheckAt`, validated as an RFC 3339 instant
   * (absent when the body has none). Compared with the window instead of
   * `occurredAt`.
   */
  readonly admissionCheckAt?: string;
}

export interface OperatorAttributionVerifier {
  verify(input: OperatorAttributionInput): Promise<AttributionVerdict>;
}

export const OPERATOR_ATTRIBUTION_VERIFIER = Symbol.for("api.sales.operatorAttributionVerifier");

/**
 * RT-224 rev709 F2: how far a till's clock may drift from the server's. It
 * widens the admission window on both edges and caps future dating.
 */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 120;

/**
 * RT-224 rev709 F3: the oldest an admission window may have ended for it to
 * still authorize a sale. RT-113 D4's 72 h offline ceiling plus a margin for a
 * sync backlog (a till that was off over a long weekend).
 */
export const MAX_WINDOW_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * The refusal log's `event` per cause: fixed, code-defined names (redaction
 * matrix §3.4 `event`). One per cause so support can tell them apart without
 * logging the claimed user.
 */
export const ATTRIBUTION_REFUSAL_EVENTS: Readonly<Record<AttributionRefusal, string>> = {
  future_dated: "sale.capture.operator_refused.future_dated",
  no_covering_admission: "sale.capture.operator_refused.no_covering_admission",
  admission_too_old: "sale.capture.operator_refused.admission_too_old",
  membership_inactive: "sale.capture.operator_refused.membership_inactive",
  user_deleted: "sale.capture.operator_refused.user_deleted",
  role_ineligible: "sale.capture.operator_refused.role_ineligible",
  store_inactive: "sale.capture.operator_refused.store_inactive",
  store_not_accessible: "sale.capture.operator_refused.store_not_accessible",
  profile_incomplete: "sale.capture.operator_refused.profile_incomplete",
};

/**
 * $1 tenant, $2 store, $3 device, $4 user, $5 occurredAt, $6 skew tolerance
 * (s), $7 max window age (s), $8 checkAt (RT-225: admissionCheckAt ??
 * occurredAt). One scan, always one row (an aggregate with no GROUP BY):
 *   future_dated  the later of occurredAt and checkAt is beyond now() +
 *                 tolerance;
 *   fresh         NULL when no window covers checkAt, else whether any
 *                 covering window ended no more than max-age ago.
 */
export const COVERING_ADMISSION_SQL = `
  SELECT GREATEST($5::timestamptz, $8::timestamptz) > now() + $6::int * interval '1 second' AS future_dated,
         bool_or(LEAST(ended_at, expires_at) >= now() - $7::int * interval '1 second') AS fresh
    FROM cashier_admissions
   WHERE tenant_id = $1
     AND store_id  = $2
     AND device_id = $3
     AND user_id   = $4
     AND created_at - $6::int * interval '1 second' <= $8::timestamptz
     AND $8::timestamptz < LEAST(ended_at, expires_at) + $6::int * interval '1 second'`;

interface CoveringRow {
  future_dated: boolean;
  fresh: boolean | null;
}

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
        const covering = await client.query<CoveringRow>(COVERING_ADMISSION_SQL, [
          input.tenantId,
          input.storeId,
          input.deviceId,
          input.userId,
          input.occurredAt,
          CLOCK_SKEW_TOLERANCE_SECONDS,
          MAX_WINDOW_AGE_SECONDS,
          // RT-225: the window instant.
          input.admissionCheckAt ?? input.occurredAt,
        ]);
        const row = covering.rows[0];
        // The aggregate always returns one row; fail closed if it did not.
        if (row === undefined) return { ok: false, cause: "no_covering_admission" };
        if (row.future_dated) return { ok: false, cause: "future_dated" };
        if (row.fresh === null) return { ok: false, cause: "no_covering_admission" };
        if (!row.fresh) return { ok: false, cause: "admission_too_old" };

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
