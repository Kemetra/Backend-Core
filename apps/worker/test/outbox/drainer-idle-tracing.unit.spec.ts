/**
 * RT-684 (OBS-9 F-B) — an idle outbox drainer exports no spans.
 *
 * The drainer polls every second. Its two poll queries (stale-claim recovery
 * and the claim itself) used to produce root spans on every tick, idle or not:
 * about 4.3k sampled spans an hour on an idle lab. They now run with tracing
 * suppressed. Processing a claimed row stays traced as before.
 *
 * Without Docker: the outbox state functions are stubbed and each stub starts
 * and ends a span, standing in for the `pg` instrumentation's query spans.
 * One tracer provider is registered for the file; every test also exports a
 * control span, so "nothing exported" cannot pass against a dead exporter.
 */
jest.mock("@data-pulse-2/db", () => {
  const { trace } = jest.requireActual<typeof import("@data-pulse-2/shared")>("@data-pulse-2/shared");
  const querySpan = (name: string) => trace.getTracer("pg-stub").startSpan(name).end();
  return {
    ...jest.requireActual("@data-pulse-2/db"),
    reclaimStaleClaims: jest.fn(async () => {
      querySpan("pg.reclaimStaleClaims");
      return { reclaimed: 0, deadLetteredEventTypes: [] };
    }),
    heartbeatClaim: jest.fn(async () => true),
    markDelivered: jest.fn(async () => {
      querySpan("pg.markDelivered");
    }),
    markFailed: jest.fn(async () => undefined),
    markDeadLettered: jest.fn(async () => undefined),
  };
});

import type { Pool } from "pg";
import type { ClaimedOutboxEvent } from "@data-pulse-2/db";
import {
  createTestTracerProvider,
  trace,
  type OutboxConsumer,
  type TestTracerHandle,
} from "@data-pulse-2/shared";

import { DrainerProcessor } from "../../src/outbox/drainer.processor";
import { OutboxConsumerRegistry } from "../../src/outbox/registry";

const EVENT_TYPE = "test.rt684.event";
const ROW: ClaimedOutboxEvent = {
  event_id: "01900000-0000-7000-8000-000000684001",
  event_type: EVENT_TYPE,
  tenant_id: "01900000-0000-7000-8000-000000684002",
  store_id: null,
  payload: {},
  correlation_id: null,
  occurred_at: new Date("2026-10-18T00:00:00Z"),
  attempts: 1,
} as unknown as ClaimedOutboxEvent;

let handle: TestTracerHandle;

beforeAll(() => {
  handle = createTestTracerProvider();
});

afterAll(async () => {
  await handle.teardown();
});

beforeEach(() => {
  handle.exporter.reset();
});

function emit(name: string): void {
  trace.getTracer("rt-684-test").startSpan(name).end();
}

function exportedNames(): string[] {
  return handle.exporter.getFinishedSpans().map((span) => span.name).sort();
}

function drainer(claimed: readonly ClaimedOutboxEvent[]): DrainerProcessor {
  const consumer: OutboxConsumer<unknown> = {
    eventType: EVENT_TYPE,
    handle: async () => emit("consumer.handle"),
  } as unknown as OutboxConsumer<unknown>;
  const registry = new OutboxConsumerRegistry();
  registry.register(consumer);
  return new DrainerProcessor({
    pool: { options: { max: 10 } } as unknown as Pool,
    registry,
    claimFn: async () => {
      emit("pg.claimBatch");
      return [...claimed];
    },
  });
}

describe("DrainerProcessor tracing (RT-684)", () => {
  it("an idle poll cycle exports no span", async () => {
    await drainer([]).tick();
    emit("control");

    expect(exportedNames()).toEqual(["control"]);
  });

  it("a poll cycle that finds work keeps its processing spans", async () => {
    await drainer([ROW]).tick();
    emit("control");

    // The poll queries stay untraced; the claimed row's consumer and its
    // delivered transition are exported as before.
    expect(exportedNames()).toEqual(["consumer.handle", "control", "pg.markDelivered"]);
  });
});
