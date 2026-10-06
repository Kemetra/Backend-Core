/**
 * The close approver's standing, checked at ingest — RT-17 follow-up (Jira
 * RT-17 comment 10955, option A: detect, never refuse).
 *
 * When a close carrying `varianceApprovedByUserId` is FIRST recorded, the
 * service checks, after the close committed, that the approver is not the
 * closer, has an active membership of the tenant, holds `owner`,
 * `tenant_admin` or `store_manager`, and has access to the shift's store.
 * The POS already enforces a verified manager PIN and approver ≠ closer
 * (POS #557); this is Backend-Core's defence-in-depth signal.
 *
 * A failed check is ONE warning log and ONE
 * `shift_close_approver_unverified_total{reason}` count. It never changes
 * the answer: the close stays a 201 with the same projection and the same
 * row (`pos-shifts.openapi.yaml` 1.1.0-draft, "Variance approval": the
 * server "never refuses the close because of that role"). A role checked at
 * ingest is the role NOW, not at the offline approval; the durable
 * read-side flag is RT-18's.
 *
 * Neither the log nor the label carries an id, an amount or PII: the
 * tenant, store, shift and users are on the `shift_closes` row (Constitution
 * §XIV, FR-B-006).
 */
import type { Logger } from "@data-pulse-2/shared";

import {
  recordShiftCloseApproverUnverified,
  type ShiftCloseApproverUnverifiedReason,
} from "../observability/metrics/api.metrics";
import type { ApproverStanding } from "./shift-store-user";

export type { ApproverStanding } from "./shift-store-user";

/** The log line's fixed `event`. */
export const APPROVER_UNVERIFIED_EVENT = "shift.close.approver_unverified";

/** The roles that may approve a variance: the POS manager / admin set. */
const APPROVER_ROLE_CODES: ReadonlySet<string> = new Set(["owner", "tenant_admin", "store_manager"]);

/**
 * Why `standing` does not verify the approver, or null when it does. An
 * inactive (or missing) membership is reported before the role, the role
 * before store access.
 */
export function standingFinding(standing: ApproverStanding | null): ShiftCloseApproverUnverifiedReason | null {
  if (standing === null || !standing.active) return "inactive_membership";
  if (!APPROVER_ROLE_CODES.has(standing.roleCode)) return "not_manager";
  if (!standing.storeAccess) return "no_store_access";
  return null;
}

/** An unverified approver to report, and on which auth path its close came. */
export interface UnverifiedApprover {
  readonly reason: ShiftCloseApproverUnverifiedReason;
  readonly authPath: "device" | "envelope";
}

/**
 * Counts and logs one unverified approver. Never throws: a failing meter or
 * log sink must not fail a close that is already recorded.
 */
export function reportUnverifiedApprover(logger: Pick<Logger, "warn"> | undefined, finding: UnverifiedApprover): void {
  try {
    recordShiftCloseApproverUnverified({ reason: finding.reason });
  } catch {
    // A signal only: the close is recorded either way.
  }
  try {
    logger?.warn(
      { event: APPROVER_UNVERIFIED_EVENT, reason: finding.reason, auth_path: finding.authPath, outcome: "recorded" },
      "shift close: variance approver not verified at ingest; close recorded",
    );
  } catch {
    // As above.
  }
}
