/**
 * PairingCodesService — RT-367 (RT-287 F4; D-Q1, D-Q4 as amended): the
 * Console pairing codes (`devices.openapi.yaml`, "Pairing codes"): issue
 * (optionally replacing or moving a device), list and cancel. The redemption
 * is the POS `posPairTerminal` (`PairingRepository`).
 *
 * Invariants:
 *   - Tenant: RLS on `pairing_codes`, `devices`, `stores` plus an explicit
 *     `tenant_id` predicate; the tenant is the session's (§II, §XII).
 *   - Store scope: the operator-surface rule (`device-caller.ts`). The code's
 *     store, and a replaced device's store, must both be in scope; anything
 *     else reads as absent (`PairingCodeNotFoundError` → the shared 404).
 *   - The code is a SECRET: generated here, returned once by `issue`, stored
 *     only as `hashToken(code)`, never logged or audited.
 *   - Replace / move: the issue decides with the shared lifecycle evaluator
 *     (`decideReplacement`) under the replaced device's lifecycle lock and row
 *     lock (`lockDeviceForLifecycle`), on the impact read the preview uses, so
 *     its outcome is the preview's verdict on the same state. `blocked` → 409
 *     with the preview. The issue changes no device: the redemption revokes.
 *   - Each mutation writes its `pos.device.pairing_code.*` audit row in its own
 *     transaction (allowlist: ids, kind, TTL; never the code).
 */
import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { hashToken } from "@data-pulse-2/auth";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { MembershipRepository } from "../context/membership.repository";
import { inStoreScope, scopeStoreIds } from "../context/operator-store-scope";
import type { StoreScope } from "../context/store-scope";
import { resolveDeviceCaller, storeInCallerScope, type ScopedInput } from "./device-caller";
import { toDeviceImpactPreview, type DeviceImpactPreview } from "./device-impact.projections";
import type { ImpactBlockCode } from "./device-lifecycle.evaluator";
import { decideReplacement, insertDeviceAudit, lockDeviceForLifecycle, readDeviceImpact } from "./device-lifecycle.store";
import {
  CREATED_AT_KEY_SQL,
  decodePairingCodeCursor,
  defaultTerminalLabel,
  encodePairingCodeCursor,
  generatePairingCode,
  toPairingCodeSummary,
  type PairingCodeCancelResult,
  type PairingCodeIssued,
  type PairingCodeKind,
  type PairingCodePage,
  type PairingCodeReadRow,
} from "./pairing-codes.projections";
import { TTL_MINUTES_DEFAULT, type PairingCodeIssueBody } from "./pairing-codes.query";

/** A store, device or code that is absent, foreign or out of scope → the non-disclosing 404. */
export class PairingCodeNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "PairingCodeNotFoundError";
  }
}

/** A replace / move refused by the lifecycle evaluator (409 `blockCode`, with the preview). */
export class PairingCodeIssueRefusedError extends Error {
  constructor(
    readonly code: ImpactBlockCode,
    readonly impact: DeviceImpactPreview,
  ) {
    super(code);
    this.name = "PairingCodeIssueRefusedError";
  }
}

/** A cancel of a redeemed code (409 `pairing_code_used`). */
export class PairingCodeUsedError extends Error {
  constructor() {
    super("pairing_code_used");
    this.name = "PairingCodeUsedError";
  }
}

export interface IssuePairingCodeInput extends ScopedInput {
  /** The session user (`users.id`): the issuer. */
  readonly actorUserId: string;
  readonly body: PairingCodeIssueBody;
}

export interface ListPairingCodesInput extends ScopedInput {
  readonly storeId?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface CancelPairingCodeInput extends ScopedInput {
  readonly actorUserId: string;
  readonly pairingCodeId: string;
}

/**
 * The code columns, with the replaced device's id only when that device is in
 * the caller's scope ($2, null = tenant-wide): out of scope reads as absent.
 */
const CODE_SELECT = `
  SELECT pc.id, pc.store_id, pc.terminal_id, pc.terminal_label, pc.status,
         pc.expires_at, pc.created_at, ${CREATED_AT_KEY_SQL} AS created_at_key,
         od.id AS replaces_device_id
    FROM pairing_codes pc
    LEFT JOIN devices od ON od.id = pc.replaces_device_id AND od.tenant_id = pc.tenant_id
                        AND ($2::uuid[] IS NULL OR od.store_id = ANY($2::uuid[]))`;

/** $1 tenant, $2 scope, $3 store filter, $4 / $5 keyset (created_at, id), $6 limit. */
const LIST_SQL = `${CODE_SELECT}
   WHERE pc.tenant_id = $1::uuid AND pc.status = 'pending' AND pc.expires_at > now()
     AND ($2::uuid[] IS NULL OR pc.store_id = ANY($2::uuid[]))
     AND ($3::uuid IS NULL OR pc.store_id = $3::uuid)
     AND ($4::timestamptz IS NULL OR (pc.created_at, pc.id) < ($4::timestamptz, $5::uuid))
   ORDER BY pc.created_at DESC, pc.id DESC
   LIMIT $6`;

/** $1 tenant, $2 scope, $3 code id. */
const ONE_CODE_SQL = `${CODE_SELECT}
   WHERE pc.tenant_id = $1::uuid AND pc.id = $3::uuid`;

@Injectable()
export class PairingCodesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /** Issue one code (see the class header). The returned `code` is the only copy. */
  async issue(input: IssuePairingCodeInput): Promise<PairingCodeIssued> {
    const body = input.body;
    return this.inTenant(input, async (client) => {
      const { scope } = await resolveDeviceCaller(this.memberships, client, input);
      const storeVisible = await storeInCallerScope(client, {
        tenantId: input.tenantId,
        scope,
        storeId: body.storeId,
        liveOnly: true,
      });
      if (!storeVisible) throw new PairingCodeNotFoundError();
      const kind =
        body.replacesDeviceId === undefined ? "pair" : await this.decideReplace(client, input, scope, body.replacesDeviceId);

      const code = generatePairingCode();
      // A random (v4) terminal id, as the CLI and the 0024 default: the default
      // label takes its first 8 hex digits, which a time-ordered v7 would repeat.
      const terminalId = randomUUID();
      const terminalLabel = body.terminalLabel ?? defaultTerminalLabel(terminalId);
      const ttlMinutes = body.ttlMinutes ?? TTL_MINUTES_DEFAULT;
      const inserted = await client.query<{ id: string; created_at: Date; expires_at: Date }>(
        `INSERT INTO pairing_codes
           (id, tenant_id, store_id, code_hash, terminal_id, terminal_label, branch_name, branch_address,
            tenant_tax_registration_id, printer_vendor_id, printer_product_id, printer_com_port,
            status, expires_at, replaces_device_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 'pending', now() + make_interval(mins => $12::int), $13)
         RETURNING id, created_at, expires_at`,
        [
          input.tenantId,
          body.storeId,
          hashToken(code),
          terminalId,
          terminalLabel,
          body.branchName,
          body.branchAddress,
          body.taxRegistrationId,
          body.printerVendorId,
          body.printerProductId,
          body.printerComPort ?? null,
          ttlMinutes,
          body.replacesDeviceId ?? null,
        ],
      );
      const row = inserted.rows[0]!;
      await insertDeviceAudit(client, {
        tenantId: input.tenantId,
        storeId: body.storeId,
        actorUserId: input.actorUserId,
        action: "pos.device.pairing_code.issued",
        targetType: "pairing_code",
        targetId: row.id,
        metadata: {
          kind,
          replaces_device_id: body.replacesDeviceId ?? null,
          ttl_minutes: ttlMinutes,
          terminal_id: terminalId,
        },
      });
      return {
        pairingCodeId: row.id,
        code,
        kind,
        storeId: body.storeId,
        terminalId,
        terminalLabel,
        replacesDeviceId: body.replacesDeviceId ?? null,
        expiresAt: row.expires_at.toISOString(),
        createdAt: row.created_at.toISOString(),
      };
    });
  }

  /** The live pending codes in scope, newest first. The cursor is decoded (400) before any read. */
  async list(input: ListPairingCodesInput): Promise<PairingCodePage> {
    const keyset = input.cursor === null ? null : decodePairingCodeCursor({ tenantId: input.tenantId, cursor: input.cursor });
    return this.inTenant(input, async (client) => {
      const { scope } = await resolveDeviceCaller(this.memberships, client, input);
      if (input.storeId !== undefined) {
        const visible = await storeInCallerScope(client, { tenantId: input.tenantId, scope, storeId: input.storeId });
        if (!visible) throw new PairingCodeNotFoundError();
      }
      const r = await client.query<PairingCodeReadRow>(LIST_SQL, [
        input.tenantId,
        scopeStoreIds(scope),
        input.storeId ?? null,
        keyset?.createdAtKey ?? null,
        keyset?.pairingCodeId ?? null,
        input.limit + 1,
      ]);
      const rows = r.rows.slice(0, input.limit);
      const last = rows[rows.length - 1];
      const nextCursor =
        r.rows.length > input.limit && last !== undefined
          ? encodePairingCodeCursor({ tenantId: input.tenantId, createdAtKey: last.created_at_key, pairingCodeId: last.id })
          : null;
      return { items: rows.map(toPairingCodeSummary), nextCursor };
    });
  }

  /** Cancel a pending code (expired or not). Idempotent; a used code is `PairingCodeUsedError`. */
  async cancel(input: CancelPairingCodeInput): Promise<PairingCodeCancelResult> {
    return this.inTenant(input, async (client) => {
      const { scope } = await resolveDeviceCaller(this.memberships, client, input);
      const locked = await client.query<{ store_id: string; status: PairingCodeReadRow["status"] }>(
        `SELECT store_id, status FROM pairing_codes WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE`,
        [input.pairingCodeId, input.tenantId],
      );
      const code = locked.rows[0];
      if (code === undefined || !inStoreScope(scope, code.store_id)) throw new PairingCodeNotFoundError();
      if (code.status === "used") throw new PairingCodeUsedError();
      const cancelled = code.status === "pending";
      if (cancelled) {
        await client.query(`UPDATE pairing_codes SET status = 'cancelled' WHERE id = $1::uuid AND tenant_id = $2::uuid`, [
          input.pairingCodeId,
          input.tenantId,
        ]);
        await insertDeviceAudit(client, {
          tenantId: input.tenantId,
          storeId: code.store_id,
          actorUserId: input.actorUserId,
          action: "pos.device.pairing_code.cancelled",
          targetType: "pairing_code",
          targetId: input.pairingCodeId,
          metadata: {},
        });
      }
      const r = await client.query<PairingCodeReadRow>(ONE_CODE_SQL, [
        input.tenantId,
        scopeStoreIds(scope),
        input.pairingCodeId,
      ]);
      return { outcome: cancelled ? "cancelled" : "already_cancelled", pairingCode: toPairingCodeSummary(r.rows[0]!) };
    });
  }

  /**
   * The replace / move decision under the replaced device's locks: the device
   * must be in scope (else 404); `blocked` → `PairingCodeIssueRefusedError`
   * with the preview of that state.
   */
  private async decideReplace(
    client: PoolClient,
    input: IssuePairingCodeInput,
    scope: StoreScope,
    deviceId: string,
  ): Promise<Exclude<PairingCodeKind, "pair">> {
    const locked = await lockDeviceForLifecycle(client, { tenantId: input.tenantId, deviceId });
    if (locked === null || !inStoreScope(scope, locked.storeId)) throw new PairingCodeNotFoundError();
    const row = await readDeviceImpact(client, input.tenantId, deviceId, scopeStoreIds(scope));
    if (row === null) throw new PairingCodeNotFoundError();
    const decision = decideReplacement(row, input.body.storeId);
    const { evaluation } = decision;
    if (evaluation.verdict === "blocked") {
      const impact = toDeviceImpactPreview({ row, action: decision.kind, reason: decision.reason, evaluation });
      throw new PairingCodeIssueRefusedError(evaluation.blockCode, impact);
    }
    // Replace / move verdicts are `allowed` or `blocked` (the evaluator's rules).
    if (evaluation.verdict !== "allowed") throw new Error(`unexpected ${decision.kind} verdict ${evaluation.verdict}`);
    return decision.kind;
  }

  private inTenant<T>(input: ScopedInput, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, work);
  }
}
