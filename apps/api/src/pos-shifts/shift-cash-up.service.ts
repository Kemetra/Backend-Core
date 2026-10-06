/**
 * ShiftCashUpService — RT-17 slice 2b ([GATED] approval: Jira RT-17 comments
 * 10760 + 10919 + 10920): `openShift` and `recordCashMovement` over the 0036
 * schema and the scoped `ShiftCashUpRepository`.
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
 * constraint refuses the loser's insert (PR #713 review #1).
 *
 * Non-disclosure (Codex P2, RT-17 comment 10925). A `shiftId` resolves only
 * within the credential's tenant + store + device. An open whose `shiftId` is
 * taken outside that scope is the same 409 `shift_payload_conflict`, never
 * another device's projection. A movement replay resolves only on the PATH
 * shift (RT-17 comment 10929): a `movementId` recorded on any other shift is
 * a 409 `shift_payload_conflict`, never echoed.
 */
import { createHash } from "node:crypto";

import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { canonicalJson } from "../idempotency/canonical-json";
import type { DeviceScope } from "../pos-cashier-admissions/device-scope";
import type { CashMovementFact, OpenShiftFact } from "./shift-cash-up.dto";
import { ShiftCashUpError } from "./shift-cash-up.errors";
import {
  toCashMovementProjection,
  toShiftProjection,
  type CashMovementProjection,
  type ShiftProjection,
} from "./shift-cash-up.projections";
import {
  ShiftCashUpRepository,
  type CashMovementRow,
  type CashUpShiftRow,
  type InsertShiftOutcome,
} from "./shift-cash-up.repository";
import { ShiftStoreUserReader, type StoreUser } from "./shift-store-user";
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
  constructor(
    /** The NOBYPASSRLS domain pool (PG_POOL). */
    private readonly pool: Pool,
    private readonly repo: ShiftCashUpRepository = new ShiftCashUpRepository(),
    private readonly storeUsers: ShiftStoreUserReader = new ShiftStoreUserReader(),
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
      if (ctx.path === "envelope") {
        await this.requireStoreUser(client, { scope: ctx.scope, userId: fact.openingUserId });
      }
      const existing = await this.repo.findShift(client, ctx.scope, fact.shiftId);
      if (existing !== null) return this.replayShift(client, existing, hash);

      const outcome = await this.repo.insertShift(client, ctx.scope, {
        ...fact,
        recordedByUserId: ctx.actorUserId,
        payloadHash: hash,
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

  private inTenant<T>(ctx: ShiftWriteContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId: ctx.scope.tenantId, isPlatformAdmin: false }, work);
  }

  private async requireStoreUser(client: PoolClient, user: StoreUser): Promise<void> {
    if (!(await this.storeUsers.isStoreUser(client, user))) throw new ShiftCashUpError("refused");
  }

  private async replayShift(
    client: PoolClient,
    shift: CashUpShiftRow,
    hash: Buffer,
  ): Promise<ShiftWriteResult<ShiftProjection>> {
    if (!shift.payloadHash.equals(hash)) throw new ShiftCashUpError("shift_payload_conflict");
    const close = shift.lifecycleState === "open" ? null : await this.repo.findClose(client, shift);
    return { created: false, projection: toShiftProjection(shift, close) };
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
    if (raced !== null && raced.payloadHash.equals(open.hash)) return this.replayShift(client, raced, open.hash);
    throw new ShiftCashUpError(kind === "device_has_open_shift" ? "shift_already_open" : "shift_payload_conflict");
  }

  /** The path shift, locked FOR UPDATE: 404 outside scope, 400 for a precision breach. */
  private async lockMovementShift(client: PoolClient, target: MovementTarget): Promise<CashUpShiftRow> {
    const shift = await this.repo.findShift(client, target.scope, target.shiftId, { forUpdate: true });
    if (shift === null) throw new ShiftCashUpError("shift_not_found");
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

/** An open the insert refused: where it was, its id and its payload hash. */
interface RefusedOpen {
  readonly scope: DeviceScope;
  readonly shiftId: string;
  readonly hash: Buffer;
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
