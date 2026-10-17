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
 *   - Replace / move: the replaced device's scope is checked before any lock
 *     (an out-of-scope id takes no lock). The issue then decides with the
 *     shared lifecycle evaluator (`decideReplacement`) under the device's
 *     lifecycle lock and row lock (`lockDeviceForLifecycle`), on the impact
 *     read the preview uses, so its outcome is the preview's verdict on the
 *     same state. `blocked` → 409 with the preview. Then, still under the
 *     locks, one replacement per device (contract C7): a live or used code
 *     naming the device → 409 `replacement_already_pending` /
 *     `device_already_replaced`. The issue changes no device: the redemption
 *     revokes.
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
import { toDeviceImpactPreview, type DeviceImpactPreview, type DeviceImpactRow } from "./device-impact.projections";
import type { ImpactBlockCode } from "./device-lifecycle.evaluator";
import {
  decideReplacement,
  insertDeviceAudit,
  lockDeviceForLifecycle,
  readDeviceImpact,
  type ReplacementDecision,
} from "./device-lifecycle.store";
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

/** A second replacement of one device (409, no details; contract C7). */
export class PairingCodeReplacementExistsError extends Error {
  constructor(readonly code: "replacement_already_pending" | "device_already_replaced") {
    super(code);
    this.name = "PairingCodeReplacementExistsError";
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
 * The kind is derived from the replaced device's store whatever the scope, so
 * the list flags every code that will revoke a device.
 */
const CODE_SELECT = `
  SELECT pc.id, pc.store_id, pc.terminal_id, pc.terminal_label, pc.status,
         pc.expires_at, pc.created_at, ${CREATED_AT_KEY_SQL} AS created_at_key,
         od.id AS replaces_device_id,
         CASE WHEN pc.replaces_device_id IS NULL THEN 'pair'
              WHEN rd.store_id = pc.store_id THEN 'replace'
              ELSE 'move' END AS kind
    FROM pairing_codes pc
    LEFT JOIN devices rd ON rd.id = pc.replaces_device_id AND rd.tenant_id = pc.tenant_id
    LEFT JOIN devices od ON od.id = rd.id AND ($2::uuid[] IS NULL OR od.store_id = ANY($2::uuid[]))`;

/** The used, or live pending, codes naming a device ($1 tenant, $2 device), used first. */
const EXISTING_REPLACEMENT_SQL = `
  SELECT status FROM pairing_codes
   WHERE tenant_id = $1::uuid AND replaces_device_id = $2::uuid
     AND (status = 'used' OR (status = 'pending' AND expires_at > now()))
   ORDER BY (status = 'used') DESC
   LIMIT 1`;

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
        body.replacesDeviceId === undefined ? "pair" : await decideReplace(client, input, scope, body.replacesDeviceId);
      const code = generatePairingCode();
      // A random (v4) terminal id, as the CLI and the 0024 default: the default
      // label takes its first 8 hex digits, which a time-ordered v7 would repeat.
      const terminalId = randomUUID();
      const issued = await insertCode(client, input, { code, terminalId, kind });
      await insertDeviceAudit(client, {
        tenantId: input.tenantId,
        storeId: body.storeId,
        actorUserId: input.actorUserId,
        action: "pos.device.pairing_code.issued",
        targetType: "pairing_code",
        targetId: issued.pairingCodeId,
        metadata: {
          kind,
          replaces_device_id: issued.replacesDeviceId,
          ttl_minutes: body.ttlMinutes ?? TTL_MINUTES_DEFAULT,
          terminal_id: terminalId,
        },
      });
      return issued;
    });
  }

  /** The live pending codes in scope, newest first. The cursor is decoded (400) before any read. */
  async list(input: ListPairingCodesInput): Promise<PairingCodePage> {
    const keyset = input.cursor === null ? null : decodePairingCodeCursor({ tenantId: input.tenantId, cursor: input.cursor });
    return this.inTenant(input, async (client) => {
      const { scope } = await resolveDeviceCaller(this.memberships, client, input);
      await assertStoreFilterVisible(client, input, scope);
      const r = await client.query<PairingCodeReadRow>(LIST_SQL, [
        input.tenantId,
        scopeStoreIds(scope),
        input.storeId ?? null,
        keyset?.createdAtKey ?? null,
        keyset?.pairingCodeId ?? null,
        input.limit + 1,
      ]);
      return pageOf(r.rows, input.limit, input.tenantId);
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
      if (cancelled) await cancelCode(client, input, code.store_id);
      const r = await client.query<PairingCodeReadRow>(ONE_CODE_SQL, [
        input.tenantId,
        scopeStoreIds(scope),
        input.pairingCodeId,
      ]);
      return { outcome: cancelled ? "cancelled" : "already_cancelled", pairingCode: toPairingCodeSummary(r.rows[0]!) };
    });
  }

  private inTenant<T>(input: ScopedInput, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, work);
  }
}

/**
 * The replace / move decision under the replaced device's locks: the device
 * must be in scope (else 404); `blocked` → `PairingCodeIssueRefusedError`
 * with the preview of that state; then one replacement per device (C7).
 */
async function decideReplace(
  client: PoolClient,
  input: IssuePairingCodeInput,
  scope: StoreScope,
  deviceId: string,
): Promise<Exclude<PairingCodeKind, "pair">> {
  const row = await lockReplacedDevice(client, input.tenantId, scope, deviceId);
  const decision = decideReplacement(row, input.body.storeId);
  assertReplacementAllowed(row, decision);
  await assertNotReplacedYet(client, input.tenantId, deviceId);
  return decision.kind;
}

/** True when the store is known and in the caller's scope. */
function visibleIn(scope: StoreScope, storeId: string | undefined): boolean {
  return storeId !== undefined && inStoreScope(scope, storeId);
}

/**
 * The replaced device's impact read under its lifecycle and row locks. Scope
 * first, without a lock: an out-of-scope id never takes the device's locks.
 * Absent, foreign or out of scope → `PairingCodeNotFoundError`.
 */
async function lockReplacedDevice(
  client: PoolClient,
  tenantId: string,
  scope: StoreScope,
  deviceId: string,
): Promise<DeviceImpactRow> {
  await assertDeviceVisible(client, tenantId, scope, deviceId);
  const locked = await lockDeviceForLifecycle(client, { tenantId, deviceId });
  if (!visibleIn(scope, locked?.storeId)) throw new PairingCodeNotFoundError();
  const row = await readDeviceImpact(client, tenantId, deviceId, scopeStoreIds(scope));
  if (row === null) throw new PairingCodeNotFoundError();
  return row;
}

/** The lock-free scope pre-check: absent, foreign or out of scope → `PairingCodeNotFoundError`. */
async function assertDeviceVisible(
  client: PoolClient,
  tenantId: string,
  scope: StoreScope,
  deviceId: string,
): Promise<void> {
  const seen = await client.query<{ store_id: string }>(
    `SELECT store_id FROM devices WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [deviceId, tenantId],
  );
  if (!visibleIn(scope, seen.rows[0]?.store_id)) throw new PairingCodeNotFoundError();
}

/** `blocked` → the 409 with the preview; replace / move verdicts are `allowed` or `blocked`. */
function assertReplacementAllowed(row: DeviceImpactRow, decision: ReplacementDecision): void {
  const { evaluation } = decision;
  if (evaluation.verdict === "blocked") {
    const impact = toDeviceImpactPreview({ row, action: decision.kind, reason: decision.reason, evaluation });
    throw new PairingCodeIssueRefusedError(evaluation.blockCode, impact);
  }
  if (evaluation.verdict !== "allowed") throw new Error(`unexpected ${decision.kind} verdict ${evaluation.verdict}`);
}

/** One replacement per device (C7): a used or live pending code naming it refuses the issue. */
async function assertNotReplacedYet(client: PoolClient, tenantId: string, deviceId: string): Promise<void> {
  const existing = await client.query<{ status: "pending" | "used" }>(EXISTING_REPLACEMENT_SQL, [tenantId, deviceId]);
  const status = existing.rows[0]?.status;
  if (status === "used") throw new PairingCodeReplacementExistsError("device_already_replaced");
  if (status === "pending") throw new PairingCodeReplacementExistsError("replacement_already_pending");
}

/** Insert the code (its hash only) and project the 201; the raw code is in the result only. */
async function insertCode(
  client: PoolClient,
  input: IssuePairingCodeInput,
  issue: { readonly code: string; readonly terminalId: string; readonly kind: PairingCodeKind },
): Promise<PairingCodeIssued> {
  const body = input.body;
  const terminalLabel = body.terminalLabel ?? defaultTerminalLabel(issue.terminalId);
  const replacesDeviceId = body.replacesDeviceId ?? null;
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
      hashToken(issue.code),
      issue.terminalId,
      terminalLabel,
      body.branchName,
      body.branchAddress,
      body.taxRegistrationId,
      body.printerVendorId,
      body.printerProductId,
      body.printerComPort ?? null,
      body.ttlMinutes ?? TTL_MINUTES_DEFAULT,
      replacesDeviceId,
    ],
  );
  const row = inserted.rows[0]!;
  return {
    pairingCodeId: row.id,
    code: issue.code,
    kind: issue.kind,
    storeId: body.storeId,
    terminalId: issue.terminalId,
    terminalLabel,
    replacesDeviceId,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/** A `store_id` filter must name a store in the caller's scope and tenant (else 404). */
async function assertStoreFilterVisible(client: PoolClient, input: ListPairingCodesInput, scope: StoreScope): Promise<void> {
  if (input.storeId === undefined) return;
  const visible = await storeInCallerScope(client, { tenantId: input.tenantId, scope, storeId: input.storeId });
  if (!visible) throw new PairingCodeNotFoundError();
}

/** One page from `limit + 1` rows: the extra row only says another page follows. */
function pageOf(rows: readonly PairingCodeReadRow[], limit: number, tenantId: string): PairingCodePage {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined
      ? encodePairingCodeCursor({ tenantId, createdAtKey: last.created_at_key, pairingCodeId: last.id })
      : null;
  return { items: items.map(toPairingCodeSummary), nextCursor };
}

/** Cancel a pending code and write its audit row, in the caller's transaction. */
async function cancelCode(client: PoolClient, input: CancelPairingCodeInput, storeId: string): Promise<void> {
  await client.query(`UPDATE pairing_codes SET status = 'cancelled' WHERE id = $1::uuid AND tenant_id = $2::uuid`, [
    input.pairingCodeId,
    input.tenantId,
  ]);
  await insertDeviceAudit(client, {
    tenantId: input.tenantId,
    storeId,
    actorUserId: input.actorUserId,
    action: "pos.device.pairing_code.cancelled",
    targetType: "pairing_code",
    targetId: input.pairingCodeId,
    metadata: {},
  });
}
