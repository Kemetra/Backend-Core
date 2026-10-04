/**
 * RT-173 (RT-83 option 2) — `PostingRequestedConsumer` reversal ordering guard,
 * Docker-free unit spec.
 *
 * A reversal's erpnext_posting_status row is created only after its sale's
 * `sale_post` row exists. Before that, `handle()` inserts nothing and throws the
 * typed retryable `ReversalAwaitingSalePostError`, so the outbox drainer re-tries
 * it with its normal backoff / dead-letter rules. The real-Postgres ordering
 * proof (sequence order, RLS) lives in `posting-requested-consumer.spec.ts`.
 *
 * The pool is a scripted fake: it answers the consumer's SQL by shape and
 * records every statement, so the tests assert what reached the database.
 */
import type { Pool } from "pg";
import type { OutboxEventEnvelope } from "@data-pulse-2/shared";

import {
  PostingRequestedConsumer,
  ReversalAwaitingSalePostError,
  type PostingRequestedPayload,
} from "../../src/erpnext-posting/posting-requested.consumer";

const TENANT = "01900000-0000-7000-8000-0000000f1111";
const PAYLOAD_TENANT = "01900000-0000-7000-8000-0000000f9999";
const STORE = "01900000-0000-7000-8000-0000000f2222";
const SALE = "01900000-0000-7000-8000-0000000f3333";
const VOID_ID = "01900000-0000-7000-8000-0000000f4444";

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** A fake Pool whose single client answers the consumer's SQL by shape. */
function fakePool(salePostExists: boolean): { pool: Pool; log: Recorded[] } {
  const log: Recorded[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    log.push({ sql, params });
    if (/kind = 'sale_post'/.test(sql)) {
      return { rows: salePostExists ? [{ exists: 1 }] : [], rowCount: salePostExists ? 1 : 0 };
    }
    if (/FROM erpnext_warehouse_map/.test(sql)) return { rows: [{ count: "1" }], rowCount: 1 };
    if (/FROM sale_lines/.test(sql)) return { rows: [{ count: "0" }], rowCount: 1 };
    if (/INSERT INTO erpnext_posting_status/.test(sql)) return { rows: [{ id: "x" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => undefined };
  return { pool: { connect: async () => client } as unknown as Pool, log };
}

function reversalEvent(): OutboxEventEnvelope<PostingRequestedPayload> {
  return {
    event_id: "01900000-0000-7000-8000-0000000f5555",
    event_type: "erpnext.posting.requested",
    tenant_id: TENANT,
    store_id: STORE,
    payload: { sale_id: SALE, store_id: STORE, kind: "reversal", source_ref_id: VOID_ID },
    correlation_id: null,
    attempts: 2,
    occurred_at: new Date("2026-10-04T00:00:00.000Z"),
  };
}

function salePostEvent(): OutboxEventEnvelope<PostingRequestedPayload> {
  const ev = reversalEvent();
  return { ...ev, payload: { ...ev.payload, kind: "sale_post", source_ref_id: SALE } };
}

const inserts = (log: Recorded[]) => log.filter((q) => /INSERT INTO erpnext_posting_status/.test(q.sql));
const salePostChecks = (log: Recorded[]) => log.filter((q) => /kind = 'sale_post'/.test(q.sql));

describe("PostingRequestedConsumer — RT-173 reversal waits for its sale_post row", () => {
  it("reversal before the sale_post row exists → throws the typed retryable error and inserts nothing", async () => {
    const { pool, log } = fakePool(false);
    const consumer = new PostingRequestedConsumer(pool, { warn: jest.fn() });

    await expect(consumer.handle(reversalEvent())).rejects.toBeInstanceOf(ReversalAwaitingSalePostError);

    expect(inserts(log)).toHaveLength(0);
    expect(log.map((q) => q.sql)).toContain("ROLLBACK");
  });

  it("the deferral error is named, so the drainer records it as the outbox error class", async () => {
    const { pool } = fakePool(false);
    const consumer = new PostingRequestedConsumer(pool, { warn: jest.fn() });

    const err = await consumer.handle(reversalEvent()).catch((e: unknown) => e);

    expect((err as Error).name).toBe("ReversalAwaitingSalePostError");
  });

  it("the sale_post check is scoped to the ENVELOPE tenant and the payload sale", async () => {
    const { pool, log } = fakePool(false);
    const consumer = new PostingRequestedConsumer(pool, { warn: jest.fn() });
    const ev = reversalEvent();
    const tampered = { ...ev, payload: { ...ev.payload, tenant_id: PAYLOAD_TENANT } };

    await consumer.handle(tampered).catch(() => undefined);

    const [check] = salePostChecks(log);
    expect(check?.params).toEqual([TENANT, SALE]);
    expect(check?.sql).toMatch(/tenant_id = \$1/);
  });

  it("logs a 'reversal deferred' warning with identifiers only", async () => {
    const { pool } = fakePool(false);
    const warn = jest.fn();
    const consumer = new PostingRequestedConsumer(pool, { warn });

    await consumer.handle(reversalEvent()).catch(() => undefined);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      {
        event: "posting.reversal.deferred",
        tenant_id: TENANT,
        sale_id: SALE,
        source_ref_id: VOID_ID,
        attempts: 2,
      },
      "reversal deferred: sale_post row not created yet",
    );
  });

  it("reversal after the sale_post row exists → the reversal row is inserted, no warning", async () => {
    const { pool, log } = fakePool(true);
    const warn = jest.fn();
    const consumer = new PostingRequestedConsumer(pool, { warn });

    await consumer.handle(reversalEvent());

    expect(inserts(log)).toHaveLength(1);
    expect(inserts(log)[0]?.params[4]).toBe("reversal");
    expect(warn).not.toHaveBeenCalled();
  });

  it("a sale_post event is never gated (no sale_post existence check, row inserted)", async () => {
    const { pool, log } = fakePool(false);
    const consumer = new PostingRequestedConsumer(pool, { warn: jest.fn() });

    await consumer.handle(salePostEvent());

    expect(salePostChecks(log)).toHaveLength(0);
    expect(inserts(log)).toHaveLength(1);
  });
});
