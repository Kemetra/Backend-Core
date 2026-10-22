/**
 * ShiftCashUpService — RT-17 slices 2b-1 / 2b-2 ([GATED] approval: Jira RT-17
 * comments 10760 + 10919 + 10920): `openShift`, `recordCashMovement` and
 * `closeShift` over the 0036 schema and the scoped `ShiftCashUpRepository`.
 *
 * Every call runs in ONE transaction under the credential's tenant (RLS on
 * the NOBYPASSRLS domain pool). Scope (tenant, store, device) and the actor
 * come from the guard, never from the body (Constitution §II, §XII).
 *
 * Natural-key dedupe (Constitution §XI). Each fact is hashed (sha256 of its
 * canonical form, amounts at the currency's minor unit, instants at full
 * precision; the `operatorUserId` claim is not part of it):
 *   - the same fact again under another Idempotency-Key → `created: false`
 *     (the controller answers 200 with `Idempotent-Replayed: true`);
 *   - the same natural key with a different payload → 409
 *     `shift_payload_conflict`.
 *
 * A concurrent identical open under another key is a replay too, whichever
 * constraint refuses the loser's insert (PR #713 review #1); so is the loser
 * of two identical closes (it waits on the shift row lock, then re-reads).
 * On the envelope path an exact replay is answered before the live check of
 * the stated opener / closer (RT-17 comment 10931 #4, `requireStatedUser`).
 *
 * Non-disclosure (Codex P2, RT-17 comment 10925). A `shiftId` resolves only
 * within the credential's tenant + store + device. An open whose `shiftId` is
 * taken outside that scope is the same 409 `shift_payload_conflict`, never
 * another device's projection. A movement replay resolves only on the PATH
 * shift (RT-17 comment 10929): a `movementId` recorded on any other shift is
 * a 409 `shift_payload_conflict`, never echoed.
 *
 * The close approver (RT-17 follow-up, comment 10955 option A). Once a close
 * with `varianceApprovedByUserId` is FIRST recorded (201), its approver's
 * standing is checked in a separate read after the commit; a failure is a
 * warning log and a count only (`shift-close-approver.ts`). Never on a
 * replay, never refusing, and a failed lookup never fails the close.
 *
 * The shift variance policy (RT-387, AD-CASH-001 D-6 / D-7). An open may
 * carry the policy the POS froze (`frozenPolicy`): it is recorded verbatim
 * with its accept-and-flag findings (`OpenPolicyFlagger`), never refused, and
 * is part of the open's hash only when present (absent = omitted, so a
 * pre-upgrade open keeps its exact hash). A close records
 * `approvalRequiredByPolicy` / `approvalMissing` derived from the shift's
 * frozen value (`unknown` without one), the rule the 0050 close guard
 * enforces, and the 201 carries the awaited approver verdict, persisted in
 * `shift_close_approver_checks` (a failed check keeps the placeholder).
 */
import { createHash } from "node:crypto";

import { UnauthorizedException } from "@nestjs/common";

import { runWithTenantContext } from "@data-pulse-2/db";
import type { Logger } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { OpenPolicyFlagger } from "../cash-variance-policy/policy-open-flags";
import { deriveCloseApproval } from "../cash-variance-policy/policy-value";
import { canonicalJson } from "../idempotency/canonical-json";
import type { ShiftCloseApproverUnverifiedReason } from "../observability/metrics/api.metrics";
import type { DeviceScope } from "../pos-cashier-admissions/device-scope";
import { closeFitsCurrency, isCashUpConsistent } from "./shift-cash-arithmetic";
import type { CashMovementFact, CloseShiftFact, OpenShiftFact } from "./shift-cash-up.dto";
import { ShiftCashUpError } from "./shift-cash-up.errors";
import {
  toCashMovementProjection,
  toShiftProjection,
  type CashMovementProjection,
  type ShiftProjection,
} from "./shift-cash-up.projections";
import {
  RefundRefAlreadyClaimedError,
  ShiftCashUpRepository,
  type CashMovementRow,
  type CashUpShiftRow,
  type InsertShiftOutcome,
  type ShiftCloseFact,
  type ShiftCloseRow,
} from "./shift-cash-up.repository";
import { closeHash, closedShift, isRacedClose, isTransactionConflict, toCloseRecord } from "./shift-close";
import {
  approverCheckOf,
  persistApproverVerdict,
  reportUnverifiedApprover,
  reportVerdictUnwritten,
  standingFinding,
  type ApproverCheck,
} from "./shift-close-approver";
import { frozenPolicyHashForm, type RecordedFrozenPolicy } from "./shift-frozen-policy";
import { refundRefFailure } from "./shift-refund-refs";
import { ShiftStoreUserReader } from "./shift-store-user";
import { canonicalInstant, fitsCurrencyPrecision, formatMoney } from "./shift-money";

/** Which credential admitted the request (the guard decided it). */
export type ShiftAuthPath = "device" | "envelope";

export interface ShiftWriteContext {
  /** From the device row or the envelope's bound device. */
  readonly scope: DeviceScope;
  /** The verified actor: the device-path cashier or the envelope operator. */
  readonly actorUserId: string;
  readonly path: ShiftAuthPath;
}

export interface ShiftWriteResult<T> {
  /** True for a first record (201); false for a natural-key replay (200). */
  readonly created: boolean;
  readonly projection: T;
}

function payloadHash(fact: Record<string, unknown>): Buffer {
  return createHash("sha256").update(canonicalJson(fact)).digest();
}

function openHash(fact: OpenShiftFact): Buffer {
  return payloadHash({
    shiftId: fact.shiftId,
    openedAt: canonicalInstant(fact.openedAt),
    openingUserId: fact.openingUserId,
    currencyCode: fact.currencyCode,
    openingFloat: formatMoney({ amount: fact.openingFloat, currencyCode: fact.currencyCode }),
    // RT-387: present only when sent; never `?? null` (a legacy open keeps its hash).
    ...(fact.frozenPolicy !== undefined ? { frozenPolicy: frozenPolicyHashForm(fact.frozenPolicy) } : {}),
  });
}

function movementHash(shift: CashUpShiftRow, fact: CashMovementFact): Buffer {
  return payloadHash({
    movementId: fact.movementId,
    shiftId: shift.shiftId,
    kind: fact.kind,
    amount: formatMoney({ amount: fact.amount, currencyCode: shift.currencyCode }),
    reasonCode: fact.reasonCode,
    note: fact.note ?? null,
    occurredAt: canonicalInstant(fact.occurredAt),
  });
}

export class ShiftCashUpService {
  /** RT-387: the open's accept-and-flag findings on a frozen policy. */
  private readonly policyFlagger = new OpenPolicyFlagger();

  constructor(
    /** The NOBYPASSRLS domain pool (PG_POOL). */
    private readonly pool: Pool,
    private readonly repo: ShiftCashUpRepository = new ShiftCashUpRepository(),
    private readonly storeUsers: ShiftStoreUserReader = new ShiftStoreUserReader(),
    /** Where an unverified close approver is logged (POS_SHIFTS_LOGGER); none in bare tests. */
    private readonly logger?: Pick<Logger, "warn">,
  ) {}

  /**
   * Records a ShiftOpened fact. 201 for a first open — including one that
   * adopted the audit-ingest legacy row of the same shift (0036 option b) —
   * 200 for the same open again, 409 `shift_already_open` when the device
   * has another open shift, 409 `shift_payload_conflict` for a different
   * payload or an out-of-scope `shiftId`.
   */
  async openShift(ctx: ShiftWriteContext, fact: OpenShiftFact): Promise<ShiftWriteResult<ShiftProjection>> {
    const hash = openHash(fact);
    return this.inTenant(ctx, async (client) => {
      // An exact replay is answered before the envelope path's live check of
      // the stated opener (RT-17 comment 10931 #4); see replaysBeforeLiveCheck.
      const existing = await this.repo.findShift(client, ctx.scope, fact.shiftId);
      if (existing?.payloadHash.equals(hash)) return this.replayShift(client, existing, hash);
      await this.requireStatedUser(client, { ctx, userId: fact.openingUserId });
      if (existing !== null) throw new ShiftCashUpError("shift_payload_conflict");
      // RT-365: a device revoked since this request authenticated opens no
      // shift; it gets the revoked-device answer (PosDeviceAuthGuard's 401).
      if (!(await this.repo.lockOpenableDevice(client, ctx.scope))) throw new UnauthorizedException("Unauthorized");

      const outcome = await this.repo.insertShift(client, ctx.scope, {
        ...fact,
        recordedByUserId: ctx.actorUserId,
        payloadHash: hash,
        frozenPolicy: await this.recordedPolicy(client, ctx, fact),
      });
      if (outcome.kind === "inserted") {
        return { created: true, projection: toShiftProjection(outcome.shift, null) };
      }
      return this.settleRefusedOpen(client, { scope: ctx.scope, shiftId: fact.shiftId, hash }, outcome.kind);
    });
  }

  /**
   * Records a CashMovement fact on the path shift. The shift row is locked
   * FOR UPDATE, so a movement and a close of the same shift serialise.
   * 404 `shift_not_found` outside scope; 400 for a precision breach; 200 for
   * the same movement again (even after the close); 409 `shift_closed` for a
   * new movement on a closed shift; 409 `shift_payload_conflict` for a
   * different payload or a `movementId` recorded on any other shift.
   */
  async recordCashMovement(
    ctx: ShiftWriteContext,
    shiftId: string,
    fact: CashMovementFact,
  ): Promise<ShiftWriteResult<CashMovementProjection>> {
    return this.inTenant(ctx, async (client) => {
      const shift = await this.lockMovementShift(client, { scope: ctx.scope, shiftId, fact });
      const hash = movementHash(shift, fact);
      const existing = await this.repo.findMovement(client, shift, fact.movementId);
      if (existing !== null) return replayMovement(existing, hash);
      return this.insertMovement(client, { shift, fact, hash, actorUserId: ctx.actorUserId });
    });
  }

  /**
   * Records the ShiftClosed fact and closes the shift, once. The shift row
   * is locked FOR UPDATE first, so closes (and movements) of one shift
   * serialise: the loser of two identical closes re-reads a closed shift and
   * replays. 404 `shift_not_found` outside scope; 400 for a precision breach
   * or an approver who is not a user of the tenant; 200 for the same close
   * again; 403 for an envelope closer who is not a store user; 409
   * `shift_payload_conflict` for a different close of a closed shift; 422
   * `shift_cashup_inconsistent`, `refund_ref_invalid` or `currency_mismatch`.
   * A refusal records nothing; a ref claimed concurrently rolls the whole
   * close back. A first record (201) then has its approver's standing
   * checked (`checkApprover`), which never changes the answer.
   */
  async closeShift(
    ctx: ShiftWriteContext,
    shiftId: string,
    fact: CloseShiftFact,
  ): Promise<ShiftWriteResult<ShiftProjection>> {
    const result = await this.closeWithRetry({ ctx, shiftId, fact });
    if (!result.created) return result;
    const check = await this.checkApprover(ctx, { shiftId, fact });
    return check === null ? result : { ...result, projection: withApproverCheck(result.projection, check) };
  }

  /**
   * RT-17 comment 10955, option A: after a close was first recorded, checks
   * its variance approver and reports a failure (log + count) without ever
   * refusing. Runs in its own transactions AFTER the close committed, so a
   * failing lookup cannot roll the close back; it reports
   * `check_unavailable` instead. RT-387: the verdict is persisted and
   * returned (null when no approver was recorded); a failed lookup or write
   * persists nothing and returns the placeholder. Never throws.
   */
  private async checkApprover(ctx: ShiftWriteContext, close: ClosedShift): Promise<ApproverCheck | null> {
    const { fact } = close;
    const approver = fact.varianceApprovedByUserId;
    if (approver === undefined) return null;
    const reason = approver === fact.closingUserId ? "approver_is_closer" : await this.approverFinding(ctx, approver);
    if (reason !== null) reportUnverifiedApprover(this.logger, { reason, authPath: ctx.path });
    if (reason === "check_unavailable") return approverCheckOf(approver, null);
    try {
      const target = { shiftId: close.shiftId, tenantId: ctx.scope.tenantId, storeId: ctx.scope.storeId, approverUserId: approver };
      await this.inTenant(ctx, (client) => persistApproverVerdict(client, target, reason));
    } catch {
      // The placeholder stands (a replay reads it); it is never retried.
      reportVerdictUnwritten(this.logger, ctx.path);
      if (reason === null) reportUnverifiedApprover(this.logger, { reason: "check_unavailable", authPath: ctx.path });
      return approverCheckOf(approver, null);
    }
    return approverCheckOf(approver, { status: reason === null ? "verified" : "unverified", reason });
  }

  /** The frozen policy to record with a first open, with its flags; null when the open carried none. */
  private async recordedPolicy(
    client: PoolClient,
    ctx: ShiftWriteContext,
    fact: OpenShiftFact,
  ): Promise<RecordedFrozenPolicy | null> {
    const frozen = fact.frozenPolicy;
    if (frozen === undefined) return null;
    const policyFlags = await this.policyFlagger.flags(client, {
      tenantId: ctx.scope.tenantId,
      storeId: ctx.scope.storeId,
      openedAt: fact.openedAt,
      shiftCurrencyCode: fact.currencyCode,
      frozen,
    });
    return { ...frozen, policyFlags };
  }

  /** The approver's standing in the credential's tenant and store, as a finding. */
  private async approverFinding(
    ctx: ShiftWriteContext,
    approver: string,
  ): Promise<ShiftCloseApproverUnverifiedReason | null> {
    try {
      const standing = await this.inTenant(ctx, (client) =>
        this.storeUsers.approverStanding(client, { scope: ctx.scope, userId: approver }),
      );
      return standingFinding(standing);
    } catch {
      return "check_unavailable";
    }
  }

  /** The close, retried once after a transaction conflict. */
  private async closeWithRetry(request: CloseRequest): Promise<ShiftWriteResult<ShiftProjection>> {
    try {
      return await this.closeOnce(request);
    } catch (err) {
      // A deadlock (40P01) or serialization failure (40001) rolled the whole
      // close back. Retried ONCE in a fresh transaction rather than answered
      // as a lost claim (PR #714 round 1, Codex P2): the rival may have rolled
      // back too, so a 422 could dead-letter a valid close on the POS; the
      // retry answers what the database now holds (201, a replay, 409 or
      // 422). Claims are taken in return_id order, so this is a backstop; a
      // second conflict propagates as a transient 500 the POS retries.
      if (!isTransactionConflict(err)) throw err;
      return this.closeOnce(request);
    }
  }

  /** One close transaction, with a raced close settled in a second one. */
  private async closeOnce(request: CloseRequest): Promise<ShiftWriteResult<ShiftProjection>> {
    try {
      return await this.inTenant(request.ctx, (client) => this.closeInTenant(client, request));
    } catch (err) {
      if (!isRacedClose(err)) throw err;
      return this.inTenant(request.ctx, (client) => this.settleRacedClose(client, { request, err }));
    }
  }

  private async closeInTenant(client: PoolClient, request: CloseRequest): Promise<ShiftWriteResult<ShiftProjection>> {
    const { ctx, fact } = request;
    const shift = await this.lockShift(client, { scope: ctx.scope, shiftId: request.shiftId });
    refuseForceClosed(shift);
    if (!closeFitsCurrency({ totals: fact, currencyCode: shift.currencyCode })) {
      throw new ShiftCashUpError("validation_error");
    }
    const hash = closeHash(shift, fact);
    const replay = await this.replayClose(client, { shift, hash });
    if (replay !== null) return replay;
    await this.requireStatedUser(client, { ctx, userId: fact.closingUserId });
    if (shift.lifecycleState !== "open") throw new ShiftCashUpError("shift_payload_conflict");
    await this.checkClose(client, { shift, fact });
    const approval = deriveCloseApproval({
      frozen: shift.frozenPolicy?.policyValue ?? null,
      variance: fact.variance,
      approverUserId: fact.varianceApprovedByUserId ?? null,
    });
    const record = toCloseRecord(fact, { recordedByUserId: ctx.actorUserId, payloadHash: hash, approval });
    return this.recordClose(client, { shift, fact, record });
  }

  private inTenant<T>(ctx: ShiftWriteContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId: ctx.scope.tenantId, isPlatformAdmin: false }, work);
  }

  /**
   * The envelope path's live check of a stated opener / closer (#711 review
   * note 1): a user of the tenant with access to the store, else 403. The
   * device path's stated user was matched to the verified cashier by the
   * guard. Runs AFTER the exact-replay lookup (RT-17 comment 10931 #4): a
   * repair retry of an already recorded fact replays even after the stated
   * user's access was revoked. That answers nothing new: the replay is the
   * caller's own device's fact, whose whole payload the caller just sent,
   * the envelope operator was re-verified live by the guard, and nothing is
   * written. Any other request still runs this check.
   */
  private async requireStatedUser(client: PoolClient, stated: StatedUser): Promise<void> {
    if (stated.ctx.path !== "envelope") return;
    const ok = await this.storeUsers.isStoreUser(client, { scope: stated.ctx.scope, userId: stated.userId });
    if (!ok) throw new ShiftCashUpError("refused");
  }

  private async replayShift(
    client: PoolClient,
    shift: CashUpShiftRow,
    hash: Buffer,
  ): Promise<ShiftWriteResult<ShiftProjection>> {
    if (!shift.payloadHash.equals(hash)) throw new ShiftCashUpError("shift_payload_conflict");
    refuseForceClosed(shift);
    const close = shift.lifecycleState === "open" ? null : await this.repo.findClose(client, shift);
    return { created: false, projection: toShiftProjection(shift, close) };
  }

  /** The shift in scope, locked FOR UPDATE; 404 when it does not resolve. */
  private async lockShift(client: PoolClient, target: ShiftTarget): Promise<CashUpShiftRow> {
    const shift = await this.repo.findShift(client, target.scope, target.shiftId, { forUpdate: true });
    if (shift === null) throw new ShiftCashUpError("shift_not_found");
    return shift;
  }

  /** The 200 replay when `shift` is closed with exactly this close, else null. */
  private async replayClose(client: PoolClient, candidate: CloseCandidate): Promise<ShiftWriteResult<ShiftProjection> | null> {
    if (candidate.shift.lifecycleState === "open") return null;
    const close = await this.repo.findClose(client, candidate.shift);
    if (!close?.payloadHash.equals(candidate.hash)) return null;
    return { created: false, projection: toShiftProjection(candidate.shift, close) };
  }

  /** The close's own rules: arithmetic (422), the approver (400), the refund refs (422). */
  private async checkClose(client: PoolClient, close: OpenShiftClose): Promise<void> {
    const { shift, fact } = close;
    if (!isCashUpConsistent(fact, shift.openingFloat)) throw new ShiftCashUpError("shift_cashup_inconsistent");
    const approver = fact.varianceApprovedByUserId;
    if (approver !== undefined && !(await this.storeUsers.isTenantUser(client, { scope: shift, userId: approver }))) {
      throw new ShiftCashUpError("validation_error");
    }
    const rows = await this.repo.readRefundRefs(client, shift, fact.cashRefundReturnRefs);
    const refusal = refundRefFailure(rows, { refs: fact.cashRefundReturnRefs, currencyCode: shift.currencyCode });
    if (refusal !== null) throw new ShiftCashUpError(refusal);
  }

  /** Records the close (201). A ref claimed meanwhile rolls it back as 422 `refund_ref_invalid`. */
  private async recordClose(client: PoolClient, close: CloseToRecord): Promise<ShiftWriteResult<ShiftProjection>> {
    let recorded: ShiftCloseRow;
    try {
      recorded = await this.repo.insertClose(client, close.shift, close.record);
    } catch (err) {
      if (err instanceof RefundRefAlreadyClaimedError) throw new ShiftCashUpError("refund_ref_invalid");
      throw err;
    }
    return { created: true, projection: toShiftProjection(closedShift(close.shift, close.fact), recorded) };
  }

  /**
   * A close whose transaction failed because another close of the shift
   * committed first (`isRacedClose`). The same close is a 200 replay; another
   * close is 409 `shift_payload_conflict`; a shift still open is not a race,
   * and the original error stands.
   */
  private async settleRacedClose(client: PoolClient, raced: RacedClose): Promise<ShiftWriteResult<ShiftProjection>> {
    const { ctx, shiftId, fact } = raced.request;
    const shift = await this.repo.findShift(client, ctx.scope, shiftId);
    if (shift === null || shift.lifecycleState === "open") throw raced.err;
    refuseForceClosed(shift);
    const replay = await this.replayClose(client, { shift, hash: closeHash(shift, fact) });
    if (replay === null) throw new ShiftCashUpError("shift_payload_conflict");
    return replay;
  }

  /**
   * An open the insert refused. An identical open that a concurrent request
   * committed meanwhile resolves on the scoped re-read and is a 200 replay,
   * whichever constraint refused the loser: the shift_id key
   * (`shift_id_taken`) or the one-open-shift-per-device index
   * (`device_has_open_shift`, PR #713 review #1). Otherwise the refusal
   * stands: `shift_already_open` for the device's other open shift,
   * `shift_payload_conflict` for a taken id, which is never disclosed (an
   * out-of-scope or legacy row does not resolve).
   */
  private async settleRefusedOpen(
    client: PoolClient,
    open: RefusedOpen,
    kind: Exclude<InsertShiftOutcome["kind"], "inserted">,
  ): Promise<ShiftWriteResult<ShiftProjection>> {
    const raced = await this.repo.findShift(client, open.scope, open.shiftId);
    if (raced?.payloadHash.equals(open.hash)) return this.replayShift(client, raced, open.hash);
    throw new ShiftCashUpError(kind === "device_has_open_shift" ? "shift_already_open" : "shift_payload_conflict");
  }

  /** The path shift, locked FOR UPDATE: 404 outside scope, 400 for a precision breach. */
  private async lockMovementShift(client: PoolClient, target: MovementTarget): Promise<CashUpShiftRow> {
    const shift = await this.lockShift(client, target);
    if (!fitsCurrencyPrecision({ amount: target.fact.amount, currencyCode: shift.currencyCode })) {
      throw new ShiftCashUpError("validation_error");
    }
    return shift;
  }

  /** A new movement: 409 `shift_closed` on a closed shift, 201 once recorded. */
  private async insertMovement(
    client: PoolClient,
    movement: NewMovement,
  ): Promise<ShiftWriteResult<CashMovementProjection>> {
    const { shift, fact } = movement;
    if (shift.lifecycleState !== "open") throw new ShiftCashUpError("shift_closed");
    const recorded = await this.repo.insertMovement(client, shift, {
      movementId: fact.movementId,
      kind: fact.kind,
      amount: fact.amount,
      reasonCode: fact.reasonCode,
      note: fact.note ?? null,
      occurredAt: fact.occurredAt,
      recordedByUserId: movement.actorUserId,
      payloadHash: movement.hash,
    });
    // Null: the movementId is taken on another shift, device, store or
    // tenant (the path shift's own rows resolved first, under its lock).
    if (recorded === null) throw new ShiftCashUpError("shift_payload_conflict");
    return { created: true, projection: toCashMovementProjection(recorded) };
  }
}

/**
 * RT-742 (Late facts): a shift a manager closed with `forceCloseShift` takes
 * no close and answers no open re-delivery, whatever the payload: 409
 * `shift_force_closed`, final for the POS. It has no `ShiftClose` to project.
 */
function refuseForceClosed(shift: CashUpShiftRow): void {
  if (shift.notCounted === true) throw new ShiftCashUpError("shift_force_closed");
}

/** An open the insert refused: where it was, its id and its payload hash. */
interface RefusedOpen {
  readonly scope: DeviceScope;
  readonly shiftId: string;
  readonly hash: Buffer;
}

/** A close that was first recorded: its path shift and fact. */
interface ClosedShift {
  readonly shiftId: string;
  readonly fact: CloseShiftFact;
}

/** The projection with the close's `approverCheck` replaced by the awaited verdict. */
function withApproverCheck(projection: ShiftProjection, check: ApproverCheck): ShiftProjection {
  return projection.close === undefined ? projection : { ...projection, close: { ...projection.close, approverCheck: check } };
}

/** A close as the controller hands it over. */
interface CloseRequest {
  readonly ctx: ShiftWriteContext;
  readonly shiftId: string;
  readonly fact: CloseShiftFact;
}

/** A close whose transaction failed with `err`. */
interface RacedClose {
  readonly request: CloseRequest;
  readonly err: unknown;
}

/** A shift in the credential's scope. */
interface ShiftTarget {
  readonly scope: DeviceScope;
  readonly shiftId: string;
}

/** A recorded shift and the hash of the close being asked for. */
interface CloseCandidate {
  readonly shift: CashUpShiftRow;
  readonly hash: Buffer;
}

/** A close of a locked, open shift. */
interface OpenShiftClose {
  readonly shift: CashUpShiftRow;
  readonly fact: CloseShiftFact;
}

/** A checked close and the record to write. */
interface CloseToRecord extends OpenShiftClose {
  readonly record: ShiftCloseFact;
}

/** A stated opener / closer and the write it is stated on. */
interface StatedUser {
  readonly ctx: ShiftWriteContext;
  readonly userId: string;
}

/** The path shift a movement names, in the credential's scope. */
interface MovementTarget {
  readonly scope: DeviceScope;
  readonly shiftId: string;
  readonly fact: CashMovementFact;
}

/** A movement to record on its resolved, locked shift. */
interface NewMovement {
  readonly shift: CashUpShiftRow;
  readonly fact: CashMovementFact;
  readonly hash: Buffer;
  readonly actorUserId: string;
}

function replayMovement(movement: CashMovementRow, hash: Buffer): ShiftWriteResult<CashMovementProjection> {
  if (!movement.payloadHash.equals(hash)) throw new ShiftCashUpError("shift_payload_conflict");
  return { created: false, projection: toCashMovementProjection(movement) };
}
