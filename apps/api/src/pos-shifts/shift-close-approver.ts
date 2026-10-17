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
import type { PoolClient } from "pg";

import {
  recordShiftCloseApproverUnverified,
  type ShiftCloseApproverUnverifiedReason,
} from "../observability/metrics/api.metrics";
import type { ApproverStanding } from "./shift-store-user";

export type { ApproverStanding } from "./shift-store-user";

/** The log line's fixed `event`. */
export const APPROVER_UNVERIFIED_EVENT = "shift.close.approver_unverified";

/** RT-387: the post-commit verdict could not be persisted (the close keeps the placeholder). */
export const APPROVER_VERDICT_UNWRITTEN_EVENT = "shift.close.approver_verdict_unwritten";

/**
 * One warning for a verdict that was checked but not persisted; the close
 * keeps `unverified` / `check_unavailable`. No id, as for the unverified
 * signal. Never throws.
 */
export function reportVerdictUnwritten(logger: Pick<Logger, "warn"> | undefined, authPath: "device" | "envelope"): void {
  try {
    logger?.warn(
      { event: APPROVER_VERDICT_UNWRITTEN_EVENT, auth_path: authPath, outcome: "placeholder_kept" },
      "shift close: approver verdict not persisted; close recorded with check_unavailable",
    );
  } catch {
    // A signal only.
  }
}

/** The roles that may approve a variance: the POS manager / admin set. */
const APPROVER_ROLE_CODES: ReadonlySet<string> = new Set(["owner", "tenant_admin", "store_manager"]);

/**
 * Why `standing` does not verify the approver, or null when it does. An
 * inactive (or missing) membership is reported before the role, the role
 * before store access.
 */
export function standingFinding(standing: ApproverStanding | null): ShiftCloseApproverUnverifiedReason | null {
  if (!standing?.active) return "inactive_membership";
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

// ---------------------------------------------------------------------------
// RT-387 (AD-CASH-001 D-7, K-4): the persisted `approverCheck`
// ---------------------------------------------------------------------------

/** The wire `approverCheck` of a close (pos-shifts / shift-closes `ApproverCheck`). */
export interface ApproverCheck {
  readonly status: "not_applicable" | "verified" | "unverified";
  readonly reason: string | null;
}

/**
 * A close's `approverCheck`: `not_applicable` with no recorded approver; the
 * persisted verdict when the post-commit check stored one; otherwise the
 * placeholder `unverified` / `check_unavailable` (the check failed, or the
 * close predates RT-387 — coordinator decision 4). `not_applicable` and the
 * placeholder are never stored: they are what a close with no row reads as.
 */
export function approverCheckOf(
  approverUserId: string | null,
  verdict: { readonly status: string; readonly reason: string | null } | null,
): ApproverCheck {
  if (approverUserId === null) return { status: "not_applicable", reason: null };
  if (verdict === null) return { status: "unverified", reason: "check_unavailable" };
  return verdict.status === "verified" ? { status: "verified", reason: null } : { status: "unverified", reason: verdict.reason };
}

/** The close an approver verdict belongs to (its composite FK target). */
export interface VerdictTarget {
  readonly shiftId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly approverUserId: string;
}

/**
 * Records the post-commit verdict once (append-only; a second write for the
 * same close is ignored). `reason` null means verified. `check_unavailable`
 * is never stored: the caller writes nothing when the check itself failed.
 */
export async function persistApproverVerdict(
  client: PoolClient,
  target: VerdictTarget,
  reason: Exclude<ShiftCloseApproverUnverifiedReason, "check_unavailable"> | null,
): Promise<void> {
  await client.query(
    `INSERT INTO shift_close_approver_checks (shift_id, tenant_id, store_id, approver_user_id, status, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (shift_id) DO NOTHING`,
    [target.shiftId, target.tenantId, target.storeId, target.approverUserId, reason === null ? "verified" : "unverified", reason],
  );
}
