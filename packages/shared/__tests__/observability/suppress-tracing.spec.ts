/**
 * Unit tests for suppress-tracing.ts (RT-684, OBS-9 finding F-B).
 *
 * Uses a real NodeTracerProvider (AsyncLocalStorage context manager) and an
 * InMemorySpanExporter, registered once for the file: a second global
 * register would not replace the first, and "nothing exported" would then
 * pass against a dead exporter. Every test therefore also exports a control
 * span to prove the exporter is live.
 */
import { setTimeout as delay } from "node:timers/promises";

import { trace } from "@opentelemetry/api";

import { createTestTracerProvider, type TestTracerHandle } from "../../src/observability/bullmq-propagation";
import { withTracingSuppressed } from "../../src/observability/suppress-tracing";

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
  return handle.exporter.getFinishedSpans().map((span) => span.name);
}

describe("withTracingSuppressed", () => {
  it("exports no span started inside it, before or after an await", async () => {
    await withTracingSuppressed(async () => {
      emit("inside.sync");
      await delay(1);
      emit("inside.after-await");
    });
    emit("control");

    expect(exportedNames()).toEqual(["control"]);
  });

  it("returns the callback's value and restores tracing afterwards", async () => {
    const value = await withTracingSuppressed(async () => 42);
    emit("after");

    expect(value).toBe(42);
    expect(exportedNames()).toEqual(["after"]);
  });

  it("restores tracing when the callback rejects", async () => {
    await expect(
      withTracingSuppressed(async () => {
        emit("inside");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    emit("after-reject");

    expect(exportedNames()).toEqual(["after-reject"]);
  });

  it("does not suppress work running concurrently outside it", async () => {
    await Promise.all([
      withTracingSuppressed(async () => {
        await delay(5);
        emit("suppressed");
      }),
      (async () => {
        await delay(1);
        emit("concurrent");
      })(),
    ]);

    expect(exportedNames()).toEqual(["concurrent"]);
  });
});
