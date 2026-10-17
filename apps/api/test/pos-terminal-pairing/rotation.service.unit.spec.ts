/**
 * RT-369 — RotationService refusal audit (contract R1 / R2), Docker-free over
 * a fake pool:
 *   - R2: a refusal under the lock writes `pos.device.rotation_rejected` in
 *     its OWN transaction, after the locked transaction ended with no write;
 *   - R1: before that row is written the device's rotation budget is spent;
 *     once it is spent the refusal writes no row and logs instead; a limiter
 *     outage fails open (the row is written).
 */
import { hashToken } from "@data-pulse-2/auth";
import type { Pool } from "pg";

import type { RateLimiter } from "../../src/auth/rate-limit";
import { POS_WRITE_RATE_LIMIT_BUCKETS } from "../../src/auth/rate-limit";
import { RotationService } from "../../src/pos-terminal-pairing/rotation.service";

const TARGET = {
  tenantId: "0a000000-0000-7000-8000-000000036921",
  storeId: "0a000000-0000-7000-8000-000000036922",
  deviceId: "0a000000-0000-7000-8000-000000036923",
};
const PRESENTED = hashToken("presented-token");

interface Tx {
  statements: string[];
}

/** A pool whose transactions are recorded; the locked row is revoked, so every rotate is refused. */
function fakePool(): { pool: Pool; txs: Tx[] } {
  const txs: Tx[] = [];
  const pool = {
    connect: () => {
      const tx: Tx = { statements: [] };
      txs.push(tx);
      return Promise.resolve({
        query: (text: string) => {
          tx.statements.push(text);
          if (/FOR UPDATE/.test(text)) {
            return Promise.resolve({
              rows: [
                {
                  token_hash: PRESENTED,
                  previous_token_hash: null,
                  previous_valid_until: null,
                  revoked_at: new Date(),
                  retired_at: null,
                  expires_at: new Date(Date.now() + 86_400_000),
                  db_now: new Date(),
                },
              ],
            });
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
        release: () => undefined,
      });
    },
  } as unknown as Pool;
  return { pool, txs };
}

const writesAudit = (tx: Tx): boolean => tx.statements.some((s) => /INSERT INTO audit_events/.test(s));
const writesDevice = (tx: Tx): boolean => tx.statements.some((s) => /UPDATE devices/.test(s));

function limiter(allowed: boolean | "throw"): { rateLimiter: RateLimiter; check: jest.Mock } {
  const check = jest.fn(() =>
    allowed === "throw"
      ? Promise.reject(new Error("redis down"))
      : Promise.resolve({ allowed, remaining: 0, resetMs: 1000 }),
  );
  return { rateLimiter: { check } as unknown as RateLimiter, check };
}

describe("RotationService — refusal audit (R1 / R2)", () => {
  it("R2: a refusal under the lock records its row in its own transaction, after a lock transaction that wrote nothing", async () => {
    const { pool, txs } = fakePool();
    const { rateLimiter } = limiter(true);
    const result = await new RotationService(pool, rateLimiter).rotate(TARGET, PRESENTED);
    expect(result).toEqual({ kind: "rejected" });
    expect(txs).toHaveLength(2);
    expect(writesAudit(txs[0]!) || writesDevice(txs[0]!)).toBe(false);
    expect(txs[0]!.statements).toContain("COMMIT");
    expect(writesAudit(txs[1]!)).toBe(true);
    expect(txs[1]!.statements).toContain("COMMIT");
  });

  it("R1: the refusal spends the device's refusal-audit budget, never its rotation budget", async () => {
    const { pool } = fakePool();
    const { rateLimiter, check } = limiter(true);
    await new RotationService(pool, rateLimiter).recordRejection(TARGET, "previous_expired");
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(
      "posRotateRefusalAudit",
      TARGET.deviceId,
      POS_WRITE_RATE_LIMIT_BUCKETS.posRotateRefusalAudit,
    );
  });

  it("R1: with the budget spent the refusal writes no row and logs a suppressed refusal", async () => {
    const { pool, txs } = fakePool();
    const { rateLimiter } = limiter(false);
    const warn = jest.fn();
    await new RotationService(pool, rateLimiter, { warn }).recordRejection(TARGET, "revoked");
    expect(txs.some(writesAudit)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "pos.device.rotation_rejected.suppressed", device_id: TARGET.deviceId }),
      expect.any(String),
    );
  });

  it("R1: a limiter outage fails open (the row is written) and is logged", async () => {
    const { pool, txs } = fakePool();
    const { rateLimiter } = limiter("throw");
    const warn = jest.fn();
    await new RotationService(pool, rateLimiter, { warn }).recordRejection(TARGET, "revoked");
    expect(txs.some(writesAudit)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
