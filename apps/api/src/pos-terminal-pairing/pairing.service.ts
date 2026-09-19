/**
 * 027 POS Terminal-Pairing CONSUME — service.
 *
 * Orchestrates the `posPairTerminal` consume flow and returns a CLOSED result
 * union the controller maps 1:1 to the contract's closed error set. The service
 * NEVER throws HTTP exceptions (that is the controller's job) and NEVER logs the
 * `pairing_code` or the minted `device_token` (§VII / FR-006).
 *
 * Flow (data-model.md §State transitions):
 *   1. Look up the code by hash (bare pool — no tenant context yet). Absent →
 *      `invalid` (404 INVALID_CODE, non-disclosing).
 *   2. Rate-limit: record the attempt under the code's tenant; once the
 *      post-increment count exceeds the per-code budget → `rate_limited`
 *      (429 + Retry-After). NOTE: this is a MONOTONIC per-code lockout, NOT a
 *      sliding window — a code that exceeds the budget is permanently
 *      `rate_limited` (recovery = issue a fresh code). `Retry-After` is a fixed
 *      hint, not a promise the same code becomes redeemable after it. The
 *      per-IP / time-windowed half is the edge proxy's job (contract narrative).
 *      Note also: an UNKNOWN code short-circuits at step 1 before any attempt is
 *      recorded — so this counter gives NO anti-enumeration value; brute-force
 *      enumeration defence is the edge per-IP limiter alone (by design).
 *   3. status used/cancelled OR past expiry → `expired` (410 EXPIRED_CODE).
 *   4. Already-paired checks (FR-14): a live device at the terminal id under the
 *      SAME branch → `already_paired` (409); under a DIFFERENT branch →
 *      `branch_mismatch` (409, MUST NOT clear the prior pairing).
 *   5. Burn (pending → used) + provision the device in ONE tx. A lost same-code
 *      race (0 rows burned) → `expired` (410); a device already provisioned for
 *      the terminal (distinct-code race / already paired) → `already_paired`
 *      (409, never a 500). Success → `ok` with the raw token ONCE.
 */
import { Inject, Injectable } from "@nestjs/common";

import { AUTH_LOOKUP_POOL, PG_POOL } from "../auth/auth.module";
import type { Pool } from "pg";
import {
  type PairingCodeBindingRow,
  type TerminalPairResponseBody,
  toTerminalPairBody,
} from "./dto/terminal-pair.dto";
import { PairingRepository, type PairingCodeRow } from "./pairing.repository";

/** Per-code attempt budget before 429 (FR-008). Per-IP limiting is the edge proxy's job. */
export const MAX_ATTEMPTS_PER_CODE = 5;
/** Back-off seconds advertised in Retry-After (clamped to the contract's [1,300]). */
export const RETRY_AFTER_SECONDS = 30;

export type PairResult =
  | { kind: "ok"; body: TerminalPairResponseBody }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "already_paired" }
  | { kind: "branch_mismatch" }
  | { kind: "rate_limited"; retryAfterSeconds: number };

@Injectable()
export class PairingService {
  private readonly repo: PairingRepository;

  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(AUTH_LOOKUP_POOL) lookupPool: Pool = pool,
  ) {
    this.repo = new PairingRepository(pool, lookupPool);
  }

  async pair(rawCode: string): Promise<PairResult> {
    const code = await this.repo.findByCode(rawCode);
    if (!code) return { kind: "invalid" };

    // Rate-limit accounting BEFORE acting on the code. The count is per-code; the
    // edge proxy owns the per-IP half (contract narrative).
    const attempts = await this.repo.recordAttempt(code.id, code.tenant_id);
    if (attempts > MAX_ATTEMPTS_PER_CODE) {
      return { kind: "rate_limited", retryAfterSeconds: RETRY_AFTER_SECONDS };
    }

    if (this.isSpent(code)) return { kind: "expired" };

    // Already-paired checks (FR-14). A live device at the terminal id means the
    // terminal was already paired; compare its branch to the code's branch.
    const pairedBranch = await this.repo.findPairedBranch(
      code.terminal_id,
      code.tenant_id,
    );
    if (pairedBranch !== null) {
      return pairedBranch === code.store_id
        ? { kind: "already_paired" }
        : { kind: "branch_mismatch" };
    }

    const provision = await this.repo.burnAndProvision({
      codeId: code.id,
      tenantId: code.tenant_id,
      storeId: code.store_id,
      terminalId: code.terminal_id,
      terminalLabel: code.terminal_label,
    });
    // A concurrent redemption of the SAME code won the burn race → spent → 410.
    if (provision === "lost_race") return { kind: "expired" };
    // The burn won but a device already exists for this terminal (two distinct
    // codes for one terminal_id raced, or already paired) → 409, never a 500.
    if (provision === "already_provisioned") return { kind: "already_paired" };
    const rawToken = provision.rawToken;

    const binding: PairingCodeBindingRow = {
      tenant_id: code.tenant_id,
      store_id: code.store_id,
      terminal_id: code.terminal_id,
      terminal_label: code.terminal_label,
      branch_name: code.branch_name,
      branch_address: code.branch_address,
      tenant_tax_registration_id: code.tenant_tax_registration_id,
      printer_vendor_id: code.printer_vendor_id,
      printer_product_id: code.printer_product_id,
      printer_com_port: code.printer_com_port,
    };
    return { kind: "ok", body: toTerminalPairBody(binding, rawToken) };
  }

  /** A code is no longer redeemable when not pending, or past its expiry. */
  private isSpent(code: PairingCodeRow): boolean {
    if (code.status !== "pending") return true;
    return code.expires_at.getTime() <= Date.now();
  }
}
