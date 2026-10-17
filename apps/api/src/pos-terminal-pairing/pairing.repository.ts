/**
 * 027 POS Terminal-Pairing CONSUME — repository.
 *
 * The consume is the ONLY unauthenticated POS operation: at request time there
 * is NO established tenant context (the terminal has no token yet — pairing IS
 * the bootstrap). So the code lookup is a stateless hash → row probe on the bare
 * admin pool, EXACTLY the pattern `DeviceRepository.findActiveByAttestation`
 * uses for sign-in (it also has no tenant context yet). `code_hash` is UNIQUE, so
 * the probe is a single index lookup returning at most one row regardless of
 * input — a cross-tenant code is indistinguishable from an absent one
 * (non-disclosing, §XIV).
 *
 * Once the code's `tenant_id` is known, the BURN + the `devices` insert + the
 * code → used transition all run inside `runWithTenantContext` so RLS scopes
 * every write to the code's tenant (Constitution III). The minted raw token is
 * returned to the caller ONCE and is NEVER persisted — only its hash lands in
 * `devices.token_hash` (the existing PosDeviceAuthGuard credential path). The
 * `pairing_code` is never stored in plaintext (only `code_hash`).
 *
 * RT-367 replacement codes (`replaces_device_id`): the burn transaction first
 * takes the replaced device's lifecycle lock and row lock
 * (`lockDeviceForLifecycle`, the order the Console revoke uses, so the two
 * never deadlock), re-reads it with the impact read and re-decides the replace
 * / move with the shared evaluator (`decideReplacement`). Refused → nothing is
 * written and the code stays pending. Allowed → burn, insert the new device,
 * then auto-revoke the replaced device through the revoke cascade (reason
 * `replaced` / `moved`, no actor user) when it is still active, and write
 * `pos.device.paired`.
 */
import { Injectable } from "@nestjs/common";
import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import {
  applyDeviceRevoke,
  decideReplacement,
  insertDeviceAudit,
  lockDeviceForLifecycle,
  readDeviceImpact,
  type ReplacementDecision,
} from "../devices/device-lifecycle.store";

/** A pairing_codes row as read at consume time (snake_case from SQL). */
export interface PairingCodeRow {
  id: string;
  tenant_id: string;
  store_id: string;
  terminal_id: string;
  terminal_label: string;
  branch_name: string;
  branch_address: string;
  tenant_tax_registration_id: string;
  printer_vendor_id: string;
  printer_product_id: string;
  printer_com_port: string | null;
  status: "pending" | "used" | "cancelled";
  expires_at: Date;
  attempt_count: number;
  last_attempt_at: Date | null;
  /** The device this code replaces or moves (RT-367); null for a plain pairing. */
  replaces_device_id: string | null;
}

const CODE_COLS =
  "id, tenant_id, store_id, terminal_id, terminal_label, branch_name, " +
  "branch_address, tenant_tax_registration_id, printer_vendor_id, " +
  "printer_product_id, printer_com_port, status, expires_at, attempt_count, " +
  "last_attempt_at, replaces_device_id";

@Injectable()
export class PairingRepository {
  constructor(
    private readonly pool: Pool,
    private readonly lookupPool: Pool = pool,
  ) {}

  /**
   * Resolve a pairing code by its raw value (hashed here). Bare admin pool — the
   * request has no tenant context yet (the code row IS the source of it). Returns
   * the row or null. NEVER takes or logs the plaintext beyond hashing it.
   */
  async findByCode(rawCode: string): Promise<PairingCodeRow | null> {
    if (rawCode.length === 0) return null;
    const codeHash = hashToken(rawCode);
    const res = await this.lookupPool.query<PairingCodeRow>(
      `SELECT ${CODE_COLS} FROM pairing_codes WHERE code_hash = $1 LIMIT 1`,
      [codeHash],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Record one redemption attempt against a code (rate-limit accounting, FR-008).
   * Runs under the code's tenant GUC so RLS permits the UPDATE. Returns the new
   * attempt_count.
   */
  recordAttempt(codeId: string, tenantId: string): Promise<number> {
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<number> => {
        const res = await client.query<{ attempt_count: number }>(
          `UPDATE pairing_codes
              SET attempt_count = attempt_count + 1, last_attempt_at = now()
            WHERE id = $1
          RETURNING attempt_count`,
          [codeId],
        );
        return res.rows[0]?.attempt_count ?? 0;
      },
    );
  }

  /**
   * Is there an active (unrevoked) device already paired for this terminal? Used
   * for the ALREADY_PAIRED / BRANCH_MISMATCH decision (FR-14). The device id
   * equals the terminal id (we mint `devices.id = terminal_id` on the burn), so a
   * prior pairing is detectable by a live devices row at that id. Returns the
   * device's store_id (the branch it is bound to) or null if unpaired.
   */
  findPairedBranch(
    terminalId: string,
    tenantId: string,
  ): Promise<string | null> {
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<string | null> => {
        const res = await client.query<{ store_id: string }>(
          `SELECT store_id FROM devices
            WHERE id = $1 AND revoked_at IS NULL
            LIMIT 1`,
          [terminalId],
        );
        return res.rows[0]?.store_id ?? null;
      },
    );
  }

  /**
   * Burn the code (pending → used) and provision the device trust, in ONE
   * transaction under the code's tenant GUC. Returns a discriminated outcome:
   *   - `{ kind: 'ok', rawToken, expiresAt }` — burned + provisioned; token
   *     returned ONCE, with the new device's `expires_at`.
   *   - `'lost_race'` — the guarded burn updated 0 rows (a concurrent redemption
   *     of the SAME code won) → caller maps to 410 EXPIRED_CODE.
   *   - `'already_provisioned'` — the burn won but a `devices` row already exists
   *     for this `terminal_id` (a 23505 on insert; e.g. two DISTINCT codes issued
   *     for the same terminal raced) → caller maps to 409 ALREADY_PAIRED, NOT a 500.
   *   - `'replacement_blocked'` — a replacement code (RT-367) whose replaced
   *     device the lifecycle evaluator refuses now (see the file header) → 409
   *     REPLACEMENT_BLOCKED; nothing written.
   *
   * The burn is a guarded conditional UPDATE (`WHERE status = 'pending'`) so two
   * terminals racing the same code cannot both succeed. The `devices` row is
   * inserted with `id = terminal_id` so the read-down device principal's store
   * scope equals the paired branch, and `token_hash = hashToken(rawToken)` so
   * `PosDeviceAuthGuard` accepts the returned token immediately.
   */
  async burnAndProvision(input: {
    codeId: string;
    tenantId: string;
    storeId: string;
    terminalId: string;
    terminalLabel: string;
    replacesDeviceId?: string | null;
  }): Promise<BurnOutcome> {
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client: PoolClient): Promise<BurnOutcome> => {
        // A replacement locks and re-decides before any write (the lock order).
        const replacement =
          input.replacesDeviceId !== undefined && input.replacesDeviceId !== null
            ? await decideReplacementUnderLock(client, input.tenantId, input.replacesDeviceId, input.storeId)
            : null;
        if (replacement === "blocked") return "replacement_blocked";

        // Guarded burn: only a row still `pending` AND not-yet-expired transitions.
        // The `expires_at > now()` predicate is in the SAME atomic UPDATE so a code
        // that crosses its expiry between the service's isSpent() pre-check and this
        // transaction cannot still be burned/provisioned (Codex P2): an expired (or
        // already-burned) row updates 0 rows → lost_race → 410 EXPIRED_CODE.
        const burn = await client.query<{ id: string }>(
          `UPDATE pairing_codes
              SET status = 'used', used_at = now()
            WHERE id = $1 AND status = 'pending' AND expires_at > now()
          RETURNING id`,
          [input.codeId],
        );
        if (burn.rowCount === 0) return "lost_race";

        // Provision the device trust. id = terminal_id so the device principal's
        // (tenant_id, store_id) match the paired branch. token_hash only — never
        // the raw token. A 23505 here means a device already exists for this
        // terminal (two distinct codes for the same terminal_id raced, or it was
        // already paired) — surface as already_provisioned → 409, never a 500.
        let expiresAt: Date;
        try {
          const inserted = await client.query<{ expires_at: Date }>(
            `INSERT INTO devices (id, tenant_id, store_id, label, token_hash)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING expires_at`,
            [
              input.terminalId,
              input.tenantId,
              input.storeId,
              input.terminalLabel,
              tokenHash,
            ],
          );
          expiresAt = inserted.rows[0]!.expires_at;
        } catch (err) {
          if (err instanceof Error && (err as { code?: string }).code === "23505") {
            return "already_provisioned";
          }
          throw err;
        }

        // Link the device back onto the burned code for the audit trail.
        await client.query(
          `UPDATE pairing_codes SET device_id = $2 WHERE id = $1`,
          [input.codeId, input.terminalId],
        );

        await recordPairing(client, input, replacement);
        return { kind: "ok", rawToken, expiresAt };
      },
    );
  }
}

export type BurnOutcome =
  | { kind: "ok"; rawToken: string; expiresAt: Date }
  | "lost_race"
  | "already_provisioned"
  | "replacement_blocked";

interface AllowedReplacement {
  readonly deviceId: string;
  readonly storeId: string;
  readonly alreadyRevoked: boolean;
  readonly decision: ReplacementDecision;
}

/**
 * Lock the replaced device (lifecycle lock, then its row) and re-decide the
 * replace / move with the shared evaluator on the impact read, tenant-wide
 * (the redemption has no caller scope; the issue checked it). Anything but
 * `allowed`, or a device that has vanished, is `blocked`.
 */
async function decideReplacementUnderLock(
  client: PoolClient,
  tenantId: string,
  deviceId: string,
  targetStoreId: string,
): Promise<AllowedReplacement | "blocked"> {
  const locked = await lockDeviceForLifecycle(client, { tenantId, deviceId });
  if (locked === null) return "blocked";
  const row = await readDeviceImpact(client, tenantId, deviceId, null);
  if (row === null) return "blocked";
  const decision = decideReplacement(row, targetStoreId);
  if (decision.evaluation.verdict !== "allowed") return "blocked";
  // One replacement per device (contract C7): another code already used for it blocks this one.
  const used = await client.query(
    `SELECT 1 FROM pairing_codes WHERE tenant_id = $1::uuid AND replaces_device_id = $2::uuid AND status = 'used' LIMIT 1`,
    [tenantId, deviceId],
  );
  if ((used.rowCount ?? 0) > 0) return "blocked";
  return { deviceId, storeId: locked.storeId, alreadyRevoked: locked.revokedAt !== null, decision };
}

/**
 * The redemption's audit and, for a replacement of a still-active device, its
 * auto-revoke through the revoke cascade. It runs after the burn, so the code
 * being redeemed is not cancelled by the cascade; the device's other pending
 * codes are. An already revoked device is left as it is (its custody
 * exception, if any, stays on it), but any other pending code replacing it is
 * still cancelled, so no second replacement can follow (contract C7).
 */
async function recordPairing(
  client: PoolClient,
  input: { readonly codeId: string; readonly tenantId: string; readonly storeId: string; readonly terminalId: string },
  replacement: AllowedReplacement | null,
): Promise<void> {
  if (replacement?.alreadyRevoked === true) {
    await client.query(
      `UPDATE pairing_codes SET status = 'cancelled'
        WHERE tenant_id = $1::uuid AND status = 'pending' AND replaces_device_id = $2::uuid`,
      [input.tenantId, replacement.deviceId],
    );
  }
  if (replacement !== null && !replacement.alreadyRevoked) {
    await applyDeviceRevoke(client, {
      tenantId: input.tenantId,
      deviceId: replacement.deviceId,
      storeId: replacement.storeId,
      actorUserId: null,
      reason: replacement.decision.reason,
      note: null,
      custodyExceptionShiftId: null,
      extraMetadata: { replaced_by_device_id: input.terminalId, pairing_code_id: input.codeId },
    });
  }
  await insertDeviceAudit(client, {
    tenantId: input.tenantId,
    storeId: input.storeId,
    actorUserId: null,
    action: "pos.device.paired",
    targetType: "device",
    targetId: input.terminalId,
    metadata: {
      pairing_code_id: input.codeId,
      kind: replacement?.decision.kind ?? "pair",
      replaces_device_id: replacement?.deviceId ?? null,
    },
  });
}
