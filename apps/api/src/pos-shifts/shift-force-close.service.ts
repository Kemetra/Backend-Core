/**
 * ShiftForceCloseService — RT-742 `forceCloseShift`
 * (`POST /api/pos/v1/shifts/{shift_id}/forced-close`, `pos-shifts.openapi.yaml`
 * 1.4.0-draft; RT-554 follow-up, owner decision 2026-10-19; design option A,
 * Jira RT-742 comment 13237).
 *
 * A manager clears a STUCK shift from any terminal of the same tenant and
 * store. The shift is closed as NOT COUNTED: the manager's terminal holds
 * neither the drawer's totals nor the POS cash-up, and the server never
 * computes one (Constitution §III), so the fact carries the closing manager,
 * the calling terminal, the reason and the server clock, and no total.
 *
 * One transaction under the envelope's tenant (RLS on the NOBYPASSRLS domain
 * pool). Tenant, store, actor, calling terminal and the caller's own session
 * come from the envelope guard, never from the body (Constitution §II, §XII).
 * The shift row is locked FOR UPDATE first, the lock `closeShift` and
 * `recordCashMovement` take, so a force close serialises with them and with
 * another force close: the loser re-reads the committed state.
 *
 * Order (contract, Order): the shift in the envelope's tenant and store, on
 * any device (404 `shift_not_found`) → the natural-key replay (200) or, for a
 * different `forcedReason`, 409 `shift_force_closed` → 409 `shift_closed` →
 * the stuck rule (409 `shift_not_stuck`) → record (201). The natural key is
 * the shift and the hash of `forcedReason`, never the actor: the same force
 * close from another manager or terminal is a replay of the recorded fact.
 */
import { createHash } from "node:crypto";

import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { canonicalJson } from "../idempotency/canonical-json";
import { ShiftCashUpError } from "./shift-cash-up.errors";
import type { ShiftWriteResult } from "./shift-cash-up.service";
import {
  ShiftForceCloseRepository,
  type ForcedCloseRow,
  type StoreShiftRow,
} from "./shift-force-close.repository";
import { formatMoney } from "./shift-money";

/** What the envelope guard published: scope, actor, calling terminal and session. */
export interface ForceCloseContext {
  readonly tenantId: string;
  readonly storeId: string;
  /** The envelope operator: the closing manager. */
  readonly actorUserId: string;
  /** The terminal the envelope is bound to: where the request came from. */
  readonly callerDeviceId: string;
  /** The envelope's own `auth_tokens` row, excluded from the stuck rule. */
  readonly callerTokenId: string;
}

/** The `ForceCloseShiftRequest` body. */
export interface ForceCloseFact {
  readonly forcedReason: string;
}

/** The `ForcedCloseRecord` projection. */
export interface ForcedCloseProjection {
  readonly closedByUserId: string;
  readonly closedAt: string;
  readonly closedFromTerminalLabel: string | null;
  readonly openedOnTerminalLabel: string | null;
  readonly forcedReason: string;
  readonly cashCount: "not_counted";
}

/** The `ForceClosedShift` projection; null cash-up fields for a legacy shift. */
export interface ForceClosedShiftProjection {
  readonly shiftId: string;
  readonly status: "force_closed";
  readonly currencyCode: string | null;
  readonly openingFloat: string | null;
  readonly openedAt: string;
  readonly openingUserId: string;
  readonly receivedAt: string | null;
  readonly forcedClose: ForcedCloseProjection;
}

/**
 * The `shift.force_closed` audit metadata (contract, Audit): the shift, the
 * terminal the request came from and the terminal that opened it; the
 * closing manager is the audit actor. Never the reason.
 */
export interface ForceCloseAudit {
  readonly shift_id: string;
  readonly closed_from_device_id: string;
  readonly opened_on_device_id: string;
  readonly replayed: boolean;
}

export interface ForceCloseResult extends ShiftWriteResult<ForceClosedShiftProjection> {
  readonly audit: ForceCloseAudit;
}

/** The `GET /shifts/stuck` staleness threshold, shared by this rule (minutes). */
export const STUCK_THRESHOLD_MINUTES = 15;

/** sha256 of the canonical natural key: the shift and the reason. */
export function forceCloseHash(shiftId: string, fact: ForceCloseFact): Buffer {
  return createHash("sha256").update(canonicalJson({ shiftId, forcedReason: fact.forcedReason })).digest();
}

/** The wire projection of a force-closed shift. No internal id is returned. */
export function toForceClosedShiftProjection(shift: StoreShiftRow, close: ForcedCloseRow): ForceClosedShiftProjection {
  const { currencyCode, openingFloat } = shift;
  return {
    shiftId: shift.shiftId,
    status: "force_closed",
    currencyCode,
    openingFloat:
      currencyCode === null || openingFloat === null ? null : formatMoney({ amount: openingFloat, currencyCode }),
    openedAt: shift.openedAt.toISOString(),
    openingUserId: shift.openingUserId,
    receivedAt: shift.receivedAt?.toISOString() ?? null,
    forcedClose: {
      closedByUserId: close.closedByUserId,
      closedAt: close.closedAt.toISOString(),
      closedFromTerminalLabel: close.closedFromTerminalLabel,
      openedOnTerminalLabel: close.openedOnTerminalLabel,
      forcedReason: close.forcedReason,
      cashCount: "not_counted",
    },
  };
}

/** One force close as the controller hands it over, with its natural-key hash. */
interface ForceCloseRequest {
  readonly ctx: ForceCloseContext;
  readonly shiftId: string;
  readonly fact: ForceCloseFact;
  readonly hash: Buffer;
}

export class ShiftForceCloseService {
  constructor(
    /** The NOBYPASSRLS domain pool (PG_POOL). */
    private readonly pool: Pool,
    private readonly repo: ShiftForceCloseRepository = new ShiftForceCloseRepository(),
    private readonly thresholdMinutes: number = STUCK_THRESHOLD_MINUTES,
  ) {}

  async forceClose(
    ctx: ForceCloseContext,
    shiftId: string,
    fact: ForceCloseFact,
  ): Promise<ForceCloseResult> {
    const hash = forceCloseHash(shiftId, fact);
    const [shift, result] = await runWithTenantContext(
      this.pool,
      { tenantId: ctx.tenantId, isPlatformAdmin: false },
      (client) => this.forceCloseInTenant(client, { ctx, shiftId, fact, hash }),
    );
    const audit: ForceCloseAudit = {
      shift_id: shift.shiftId,
      closed_from_device_id: ctx.callerDeviceId,
      opened_on_device_id: shift.openingDeviceId,
      replayed: !result.created,
    };
    return { ...result, audit };
  }

  private async forceCloseInTenant(
    client: PoolClient,
    request: ForceCloseRequest,
  ): Promise<[StoreShiftRow, ShiftWriteResult<ForceClosedShiftProjection>]> {
    const { ctx, shiftId } = request;
    const shift = await this.repo.findStoreShift(client, { tenantId: ctx.tenantId, storeId: ctx.storeId }, shiftId);
    if (shift === null) throw new ShiftCashUpError("shift_not_found");
    return [shift, await this.closeShiftInStore(client, { ...request, shift })];
  }

  /** The located, locked shift: replay, refusal or the first record. */
  private async closeShiftInStore(
    client: PoolClient,
    request: ForceCloseRequest & { readonly shift: StoreShiftRow },
  ): Promise<ShiftWriteResult<ForceClosedShiftProjection>> {
    const { ctx, fact, hash, shift } = request;
    if (shift.notCounted) return this.replay(client, { shift, hash });
    if (shift.lifecycleState !== "open") throw new ShiftCashUpError("shift_closed");
    const stuck = await this.repo.isStuck(client, shift, {
      callerTokenId: ctx.callerTokenId,
      thresholdMinutes: this.thresholdMinutes,
    });
    if (!stuck) throw new ShiftCashUpError("shift_not_stuck");
    const recorded = await this.repo.insertForcedClose(client, shift, {
      closedByUserId: ctx.actorUserId,
      closedFromDeviceId: ctx.callerDeviceId,
      forcedReason: fact.forcedReason,
      payloadHash: hash,
    });
    return { created: true, projection: toForceClosedShiftProjection(shift, recorded) };
  }

  /** The 200 replay of the recorded force close, or 409 for another reason. */
  private async replay(
    client: PoolClient,
    candidate: { readonly shift: StoreShiftRow; readonly hash: Buffer },
  ): Promise<ShiftWriteResult<ForceClosedShiftProjection>> {
    const close = await this.repo.findForcedClose(client, candidate.shift);
    if (!close?.payloadHash.equals(candidate.hash)) throw new ShiftCashUpError("shift_force_closed");
    return { created: false, projection: toForceClosedShiftProjection(candidate.shift, close) };
  }
}
