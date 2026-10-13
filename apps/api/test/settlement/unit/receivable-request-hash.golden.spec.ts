/**
 * Golden bytes for the settlement-intent request hash (sonar S2871 remediation).
 *
 * `ReceivableService` stores sha256(canonicalJson(intent)) as
 * `idempotency_keys.request_hash`; a later retry is compared byte-for-byte, so
 * the canonical key order must never change. The serializer is module-private,
 * so the stored fingerprint is captured from the reservation INSERT. Expected
 * values were captured from the code BEFORE the explicit comparator was
 * introduced and are pinned here as literals.
 */
import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";

import { ReceivableService } from "../../../src/settlement/receivable.service";

const TENANT_ID = "71000000-0000-4000-8000-000000000001";
const STORE_ID = "71000000-0000-4000-8000-000000000002";
const ACTOR_ID = "71000000-0000-4000-8000-000000000003";
const SALE_ID = "71000000-0000-4000-8000-000000000004";
const PAYER_ID = "71000000-0000-4000-8000-000000000005";

const CLAIM_METADATA_FIXTURE = {
  b: 1,
  B: 2,
  a: 3,
  "é": 4,
  _: 5,
  "10": 6,
  "9": 7,
  nested: { z: 1, Z: 2 },
};

const GOLDEN_STRING =
  '{"payers":[{"claimMetadata":{"10":6,"9":7,"B":2,"_":5,"a":3,"b":1,' +
  '"nested":{"Z":2,"z":1},"é":4},"owedAmount":"12.00",' +
  '"payerRef":"71000000-0000-4000-8000-000000000005"}],' +
  '"saleRef":"71000000-0000-4000-8000-000000000004"}';
const GOLDEN_SHA256_HEX =
  "279c8dc17f2513d42a75411c5ab85b31ee51856d5fb7497abc58776fff77d8ff";

class FingerprintCaptured extends Error {}

function empty(): QueryResult {
  return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] } as QueryResult;
}

function capturingService(): { service: ReceivableService; fingerprint: () => Buffer | null } {
  let captured: Buffer | null = null;
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.includes("set_config")) return empty();
    if (sql.includes("INSERT INTO idempotency_keys")) {
      captured = params?.[5] as Buffer;
      throw new FingerprintCaptured("fingerprint captured");
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const client = { query, release: jest.fn() } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { service: new ReceivableService(pool), fingerprint: () => captured };
}

describe("settlement intent request-hash golden bytes", () => {
  it("pins the literal's sha256 (guards the golden constants themselves)", () => {
    expect(createHash("sha256").update(GOLDEN_STRING).digest("hex")).toBe(GOLDEN_SHA256_HEX);
  });

  it("stores the exact golden request_hash for the fixture intent", async () => {
    const h = capturingService();
    await expect(
      h.service.openFromIntent({
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        operation: {
          idempotencyKey: "settlement-golden-key",
          terminalId: "settlement-golden-terminal",
          actorUserId: ACTOR_ID,
          requestId: null,
        },
        saleRef: SALE_ID,
        payers: [
          { payerRef: PAYER_ID, owedAmount: "12.00", claimMetadata: CLAIM_METADATA_FIXTURE },
        ],
      }),
    ).rejects.toThrow(FingerprintCaptured);
    expect(h.fingerprint()?.toString("hex")).toBe(GOLDEN_SHA256_HEX);
  });
});
