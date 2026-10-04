/**
 * RT-207 — `erpnext_posting_reversal_deferred_dead_letter_total` label policy.
 *
 * The counter is UNLABELED: the affected tenant, sale and outbox event live on
 * the dead-lettered outbox row and the structured error log, never on a metric
 * label (FR-B-006 / FR-B-012). This spec pins that at three layers:
 *   1. the closed allowlist entry is empty and rejects tenant / sale ids;
 *   2. the instrument is created under that exact name as a counter;
 *   3. the emission helper adds 1 with NO attributes — observed by loading
 *      worker.metrics against a recording Meter in an isolated module registry.
 */
import {
  ALLOWED_METRIC_LABELS,
  validateMetricLabels,
} from "@data-pulse-2/shared";
import { WORKER_METRIC_NAMES } from "../../src/observability/metrics/worker.metrics";

const METRIC = "erpnext_posting_reversal_deferred_dead_letter_total";

interface RecordedAdd {
  readonly name: string;
  readonly value: number;
  readonly attributes: unknown;
}

/** Load worker.metrics against a Meter that records counter creation and adds. */
function loadWithRecordingMeter(): {
  created: string[];
  adds: RecordedAdd[];
  metrics: typeof import("../../src/observability/metrics/worker.metrics");
} {
  const created: string[] = [];
  const adds: RecordedAdd[] = [];
  const instrument = (name: string) => ({
    add: (value: number, attributes?: unknown) => adds.push({ name, value, attributes }),
    record: () => undefined,
    addCallback: () => undefined,
    removeCallback: () => undefined,
  });
  const meter = {
    createCounter: (name: string) => {
      created.push(name);
      return instrument(name);
    },
    createHistogram: (name: string) => instrument(name),
    createObservableGauge: (name: string) => instrument(name),
  };
  let metrics!: typeof import("../../src/observability/metrics/worker.metrics");
  jest.isolateModules(() => {
    jest.doMock("@data-pulse-2/shared", () => ({
      ...jest.requireActual("@data-pulse-2/shared"),
      getMeter: () => meter,
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    metrics = require("../../src/observability/metrics/worker.metrics");
  });
  return { created, adds, metrics };
}

describe("RT-207 — reversal dead-letter counter: name and labels", () => {
  afterEach(() => {
    jest.dontMock("@data-pulse-2/shared");
  });

  it("is registered in ALLOWED_METRIC_LABELS with NO labels", () => {
    expect(ALLOWED_METRIC_LABELS[METRIC]).toEqual([]);
  });

  it("is a worker metric name (signal-presence registry)", () => {
    expect((WORKER_METRIC_NAMES as readonly string[]).includes(METRIC)).toBe(true);
  });

  it.each(["tenant_id", "sale_id", "outbox_event_id", "event_id", "source_ref_id", "store_id"])(
    "rejects the %s label",
    (label) => {
      expect(validateMetricLabels(METRIC, [label])).not.toBeNull();
    },
  );

  it("is created as a counter under that exact name", () => {
    const { created } = loadWithRecordingMeter();
    expect(created).toContain(METRIC);
  });

  it("the helper adds exactly 1 with no attributes (no tenant / sale ids)", () => {
    const { adds, metrics } = loadWithRecordingMeter();

    metrics.recordErpnextPostingReversalDeferredDeadLetter();

    const mine = adds.filter((a) => a.name === METRIC);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.value).toBe(1);
    expect(mine[0]?.attributes ?? {}).toEqual({});
  });

  it("the helper takes no arguments, so a call site cannot pass labels", () => {
    const { metrics } = loadWithRecordingMeter();
    expect(metrics.recordErpnextPostingReversalDeferredDeadLetter).toHaveLength(0);
  });
});
