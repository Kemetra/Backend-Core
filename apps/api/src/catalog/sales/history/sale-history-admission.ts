/**
 * The cashier admission behind `X-Cashier-Admission` on the sale-history
 * device path (Jira RT-539; RT-537 D-2 / D-7, Q-2 / Q-8).
 *
 * The admission is looked up BY ID, but only inside the authenticated
 * device's tenant (RLS), store and device: an admission of another device,
 * store or tenant reads as unknown. The id is a selector, not a credential.
 * Then, on the domain pool under the device's tenant:
 *
 *   - live NOW (list, detail, `authorize` reprint): not ended and not expired,
 *     the cashier-admissions service's own liveness (`expires_at > now`);
 *   - or, for a `record` reprint, its window covers `printedAt` with the
 *     captureSale rules (operator-attribution.ts, RT-224 rev709 F2/F3): 120 s
 *     clock-skew tolerance on both edges, the window ended no more than 7 days
 *     ago, and `printedAt` at most 120 s in the future. An ended admission
 *     still covers its own window, so a reprint made offline by a cashier who
 *     has since signed out is still recorded;
 *   - and the cashier is still eligible, LIVE (the RT-113 BC2 predicate set,
 *     `CashierEligibilityRepository`, reused, not copied).
 *
 * Every comparison runs in Postgres (microsecond timestamptz), never in JS.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import {
  CashierEligibilityRepository,
  type CashierEligibilityReader,
} from "../../../pos-cashier-admissions/cashier-eligibility";
import { CLOCK_SKEW_TOLERANCE_SECONDS, MAX_WINDOW_AGE_SECONDS } from "../operator-attribution";
import type {
  CashierAdmissionInput,
  CashierAdmissionSelector,
  CashierAdmissionVerdict,
} from "./sale-history-auth.guard";

/**
 * $1 admission, $2 tenant, $3 store, $4 device, $5 checkAt (NULL: live now),
 * $6 skew tolerance (s), $7 max window age (s). Zero or one row.
 */
export const ADMISSION_SQL = `
  SELECT a.user_id,
         (a.ended_at IS NULL AND a.expires_at > now()) AS live,
         COALESCE(
           $5::timestamptz <= now() + $6::int * interval '1 second'
           AND a.created_at - $6::int * interval '1 second' <= $5::timestamptz
           AND $5::timestamptz < LEAST(a.ended_at, a.expires_at) + $6::int * interval '1 second'
           AND LEAST(a.ended_at, a.expires_at) >= now() - $7::int * interval '1 second',
           false) AS covers
    FROM cashier_admissions a
   WHERE a.id = $1 AND a.tenant_id = $2 AND a.store_id = $3 AND a.device_id = $4`;

interface AdmissionRow {
  user_id: string;
  live: boolean;
  covers: boolean;
}

export class PgCashierAdmissionSelector implements CashierAdmissionSelector {
  constructor(
    /** The NOBYPASSRLS domain pool (PG_POOL): every read runs under the device's tenant. */
    private readonly pool: Pool,
    private readonly eligibility: CashierEligibilityReader = new CashierEligibilityRepository(),
  ) {}

  resolve(input: CashierAdmissionInput): Promise<CashierAdmissionVerdict> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<CashierAdmissionVerdict> => {
        const r = await client.query<AdmissionRow>(ADMISSION_SQL, [
          input.admissionId,
          input.tenantId,
          input.storeId,
          input.deviceId,
          input.checkAt,
          CLOCK_SKEW_TOLERANCE_SECONDS,
          MAX_WINDOW_AGE_SECONDS,
        ]);
        const row = r.rows[0];
        if (row === undefined) return { ok: false, cause: "admission_unknown", userId: null };
        const userId = row.user_id;
        if (input.checkAt === null && !row.live) return { ok: false, cause: "admission_not_live", userId };
        if (input.checkAt !== null && !row.covers) return { ok: false, cause: "admission_not_covering", userId };

        const scope = { tenantId: input.tenantId, storeId: input.storeId, deviceId: input.deviceId };
        const eligibility = await this.eligibility.check(client, scope, userId);
        if (!eligibility.eligible) return { ok: false, cause: eligibility.reason, userId };
        return { ok: true, userId };
      },
    );
  }
}
