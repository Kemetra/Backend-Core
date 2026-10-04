/**
 * RT-207 — a reversal deferred for its `sale_post` row, driven through the real
 * outbox `DrainerProcessor` and the real `PostingRequestedConsumer`.
 *
 * Proves, without Docker, that the drainer and the consumer agree on which
 * attempt dead-letters:
 *   - every deferral is counted in `queue_failed_total` under its own
 *     `ReversalAwaitingSalePostError` class, never `UnknownError`;
 *   - the reversal that dead-letters while still awaiting its sale_post
 *     increments `erpnext_posting_reversal_deferred_dead_letter_total` exactly
 *     once and logs one structured error;
 *   - retried deferrals and other dead-letters do not increment it.
 *
 * The outbox state transitions (`markFailed` / `markDeadLettered` / lease
 * renewal / stale-claim recovery) are stubbed; their SQL is proven by the
 * Testcontainers suites (`outbox/retry-budget.spec.ts`, `claim-recovery.spec.ts`).
 * The consumer's pool is the same scripted fake as the consumer unit spec.
 */
jest.mock("@data-pulse-2/db", () => ({
  ...jest.requireActual("@data-pulse-2/db"),
  markDelivered: jest.fn(async () => undefined),
  markFailed: jest.fn(async () => undefined),
  markDeadLettered: jest.fn(async () => undefined),
  heartbeatClaim: jest.fn(async () => true),
  reclaimStaleClaims: jest.fn(async () => ({ reclaimed: 0, deadLetteredEventTypes: [] })),
}));

import type { Pool } from "pg";
import {
  MAX_ATTEMPTS,
  markDeadLettered,
  markFailed,
  reclaimStaleClaims,
  type ClaimedOutboxEvent,
} from "@data-pulse-2/db";
import type { OutboxConsumer } from "@data-pulse-2/shared";

import { PostingRequestedConsumer } from "../../src/erpnext-posting/posting-requested.consumer";
import { DrainerProcessor } from "../../src/outbox/drainer.processor";
import { OutboxConsumerRegistry } from "../../src/outbox/registry";
import * as workerMetrics from "../../src/observability/metrics/worker.metrics";

const TENANT = "01900000-0000-7000-8000-0000000e1111";
const STORE = "01900000-0000-7000-8000-0000000e2222";
const SALE = "01900000-0000-7000-8000-0000000e3333";
const VOID_ID = "01900000-0000-7000-8000-0000000e4444";
const EVENT_ID = "01900000-0000-7000-8000-0000000e5555";

/** Consumer pool: answers "no sale_post row yet" (or "it exists"). */
function consumerPool(salePostExists: boolean): Pool {
  const query = async (sql: string) => {
    if (/kind = 'sale_post'/.test(sql)) {
      return { rows: salePostExists ? [{ exists: 1 }] : [], rowCount: salePostExists ? 1 : 0 };
    }
    if (/FROM erpnext_warehouse_map/.test(sql)) return { rows: [{ count: "1" }], rowCount: 1 };
    if (/FROM sale_lines/.test(sql)) return { rows: [{ count: "0" }], rowCount: 1 };
    if (/INSERT INTO erpnext_posting_status/.test(sql)) return { rows: [{ id: "x" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
}

/** Drainer pool: never queried directly here (transitions are stubbed). */
const drainerPool = { options: { max: 10 } } as unknown as Pool;

function claimed(
  attempts: number,
  overrides: Partial<ClaimedOutboxEvent> = {},
): ClaimedOutboxEvent {
  return {
    event_id: EVENT_ID,
    event_type: "erpnext.posting.requested",
    tenant_id: TENANT,
    store_id: STORE,
    payload: { sale_id: SALE, store_id: STORE, kind: "reversal", source_ref_id: VOID_ID },
    correlation_id: null,
    occurred_at: new Date("2026-10-04T00:00:00.000Z"),
    attempts,
    ...overrides,
  };
}

function drainerFor(
  consumer: OutboxConsumer<unknown>,
  row: ClaimedOutboxEvent,
): DrainerProcessor {
  const registry = new OutboxConsumerRegistry();
  registry.register(consumer);
  return new DrainerProcessor({ pool: drainerPool, registry, claimFn: async () => [row] });
}

let failedSpy: jest.SpyInstance;
let deadLetterCounter: jest.SpyInstance;
let errorLog: jest.Mock;

beforeEach(() => {
  (reclaimStaleClaims as jest.Mock).mockResolvedValue({ reclaimed: 0, deadLetteredEventTypes: [] });
  failedSpy = jest.spyOn(workerMetrics, "recordQueueFailed").mockImplementation(() => undefined);
  deadLetterCounter = jest
    .spyOn(workerMetrics, "recordErpnextPostingReversalDeferredDeadLetter")
    .mockImplementation(() => undefined);
  errorLog = jest.fn();
});

const reversalConsumer = (salePostExists = false) =>
  new PostingRequestedConsumer(consumerPool(salePostExists), { warn: jest.fn(), error: errorLog }) as
    OutboxConsumer<unknown>;

describe("RT-207 — drainer + PostingRequestedConsumer: reversal awaiting sale_post", () => {
  it("a retried deferral is counted under its own error_class, not UnknownError", async () => {
    await drainerFor(reversalConsumer(), claimed(3)).tick();

    expect(failedSpy).toHaveBeenCalledTimes(1);
    expect(failedSpy).toHaveBeenCalledWith({
      queue: "outbox-drainer",
      error_class: "ReversalAwaitingSalePostError",
    });
    expect(markFailed).toHaveBeenCalledWith(drainerPool, EVENT_ID, 3, "ReversalAwaitingSalePostError");
    expect(markDeadLettered).not.toHaveBeenCalled();
    expect(deadLetterCounter).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("the dead-lettering deferral increments the dedicated counter exactly once and logs once", async () => {
    await drainerFor(reversalConsumer(), claimed(MAX_ATTEMPTS)).tick();

    expect(markDeadLettered).toHaveBeenCalledTimes(1);
    expect(markDeadLettered).toHaveBeenCalledWith(
      drainerPool,
      EVENT_ID,
      "ReversalAwaitingSalePostError",
      MAX_ATTEMPTS,
    );
    expect(markFailed).not.toHaveBeenCalled();
    expect(failedSpy).toHaveBeenCalledWith({
      queue: "outbox-drainer",
      error_class: "ReversalAwaitingSalePostError",
    });
    expect(deadLetterCounter).toHaveBeenCalledTimes(1);
    expect(deadLetterCounter).toHaveBeenCalledWith();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0]?.[0]).toMatchObject({
      event: "posting.reversal.dead_lettered",
      tenant_id: TENANT,
      sale_id: SALE,
      event_id: EVENT_ID,
    });
  });

  it("a full deferral lifecycle (attempts 1..MAX) counts the dead-letter once, at the last attempt", async () => {
    const consumer = reversalConsumer();
    for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts += 1) {
      await drainerFor(consumer, claimed(attempts)).tick();
    }

    expect(markFailed).toHaveBeenCalledTimes(MAX_ATTEMPTS - 1);
    expect(markDeadLettered).toHaveBeenCalledTimes(1);
    expect(failedSpy).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    for (const [attrs] of failedSpy.mock.calls) {
      expect(attrs).toEqual({ queue: "outbox-drainer", error_class: "ReversalAwaitingSalePostError" });
    }
    expect(deadLetterCounter).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it("another consumer's dead-letter does not increment the reversal counter", async () => {
    const poison: OutboxConsumer<unknown> = {
      consumerId: "test.poison",
      eventType: "test.event.poison",
      async handle() {
        throw new Error("boom");
      },
    };

    await drainerFor(poison, claimed(MAX_ATTEMPTS, { event_type: "test.event.poison" })).tick();

    expect(markDeadLettered).toHaveBeenCalledTimes(1);
    expect(deadLetterCounter).not.toHaveBeenCalled();
  });

  it("a posting-requested dead-letter for another reason does not increment it", async () => {
    const malformed = claimed(MAX_ATTEMPTS, { payload: { sale_id: "not-a-uuid" } });

    await drainerFor(reversalConsumer(), malformed).tick();

    expect(markDeadLettered).toHaveBeenCalledTimes(1);
    expect(deadLetterCounter).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("a final-attempt reversal whose sale_post now exists is delivered, not counted", async () => {
    await drainerFor(reversalConsumer(true), claimed(MAX_ATTEMPTS)).tick();

    expect(markDeadLettered).not.toHaveBeenCalled();
    expect(failedSpy).not.toHaveBeenCalled();
    expect(deadLetterCounter).not.toHaveBeenCalled();
  });
});
