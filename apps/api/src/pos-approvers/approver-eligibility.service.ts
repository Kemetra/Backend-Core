/**
 * ApproverEligibilityService — RT-788 (RT-114 MA-BC2).
 *
 * One tenant-scoped read evaluates every requested id; the answer is one
 * result per id, in request order, echoing each id exactly as sent (ids are
 * matched as UUIDs, case-insensitively). Minimum disclosure: a result is
 * `{ user_id, eligible }` only; `action_kinds` is omitted in `1.0.0-draft`.
 * The per-user cause of an ineligible result goes to the server log, keyed
 * by `request_id`, and never to the response.
 *
 * Read-only: no state change, no audit event, no idempotency.
 */
import type { Logger } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import type { DeviceScope } from "../pos-cashier-admissions/device-scope";
import { classifyApprover, type ApproverEligibilityReader, type IneligibleCause } from "./approver-eligibility";
import type { ApproverEligibilityResponseBody } from "./dto";

/** Runs `work` in one transaction under the given tenant's RLS context. */
export type TenantTransaction = <T>(tenantId: string, work: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface ApproverEligibilityDeps {
  readonly tx: TenantTransaction;
  readonly reader: ApproverEligibilityReader;
  readonly logger: Logger;
}

export class ApproverEligibilityService {
  constructor(private readonly deps: ApproverEligibilityDeps) {}

  async check(scope: DeviceScope, userIds: readonly string[], requestId: string | null): Promise<ApproverEligibilityResponseBody> {
    const rows = await this.deps.tx(scope.tenantId, (client) => this.deps.reader.evaluate(client, scope, userIds));
    const byId = new Map(rows.map((row) => [row.user_id.toLowerCase(), row]));
    const ineligible: Array<{ user_id: string; cause: IneligibleCause }> = [];
    const results = userIds.map((userId) => {
      const verdict = classifyApprover(byId.get(userId.toLowerCase()));
      if (!verdict.eligible) ineligible.push({ user_id: userId, cause: verdict.cause });
      return { user_id: userId, eligible: verdict.eligible };
    });
    this.deps.logger.info(
      {
        component: "pos.approver_eligibility",
        request_id: requestId,
        device_id: scope.deviceId,
        requested: userIds.length,
        eligible: userIds.length - ineligible.length,
        ineligible,
      },
      "approver eligibility evaluated",
    );
    return { results };
  }
}
