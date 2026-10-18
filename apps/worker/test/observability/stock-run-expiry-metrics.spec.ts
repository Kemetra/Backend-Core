/**
 * RT-688 — `erpnext_stock_run_stranded` (gauge) and
 * `erpnext_stock_run_expired_total` (counter) label policy and emission.
 *
 * The gauge carries only the closed `outcome` label (`report_incomplete` /
 * `report_complete`); the counter is unlabeled. Tenant, store and run ids live
 * on the run row, its audit row and the sweep log, never on a label
 * (FR-B-006 / FR-B-012). Emission is observed by loading worker.metrics
 * against a recording Meter in an isolated module registry.
 */
import {
  ALLOWED_METRIC_LABELS,
  validateMetricLabels,
} from "@data-pulse-2/shared";
import {
  STOCK_RUN_STRANDED_OUTCOMES,
  WORKER_METRIC_NAMES,
} from "../../src/observability/metrics/worker.metrics";

const GAUGE = "erpnext_stock_run_stranded";
const COUNTER = "erpnext_stock_run_expired_total";

type Observation = { value: number; attributes: unknown };
type GaugeCallback = (result: { observe: (v: number, a?: unknown) => void }) => void;

function loadWithRecordingMeter(): {
  counters: string[];
  gauges: string[];
  adds: Array<{ name: string; value: number; attributes: unknown }>;
  scrape: (name: string) => Observation[];
  metrics: typeof import("../../src/observability/metrics/worker.metrics");
} {
  const counters: string[] = [];
  const gauges: string[] = [];
  const adds: Array<{ name: string; value: number; attributes: unknown }> = [];
  const callbacks = new Map<string, GaugeCallback[]>();
  const instrument = (name: string) => ({
    add: (value: number, attributes?: unknown) => adds.push({ name, value, attributes }),
    record: () => undefined,
    addCallback: (cb: GaugeCallback) => {
      callbacks.set(name, [...(callbacks.get(name) ?? []), cb]);
    },
    removeCallback: () => undefined,
  });
  const meter = {
    createCounter: (name: string) => {
      counters.push(name);
      return instrument(name);
    },
    createHistogram: (name: string) => instrument(name),
    createObservableGauge: (name: string) => {
      gauges.push(name);
      return instrument(name);
    },
  };
  const scrape = (name: string): Observation[] => {
    const seen: Observation[] = [];
    for (const cb of callbacks.get(name) ?? []) {
      cb({ observe: (value, attributes) => seen.push({ value, attributes }) });
    }
    return seen;
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
  return { counters, gauges, adds, scrape, metrics };
}

describe("RT-688 — stock run stranded / expired signals", () => {
  afterEach(() => {
    jest.dontMock("@data-pulse-2/shared");
  });

  it("are allowlisted: the gauge with `outcome` only, the counter unlabeled", () => {
    expect(ALLOWED_METRIC_LABELS[GAUGE]).toEqual(["outcome"]);
    expect(ALLOWED_METRIC_LABELS[COUNTER]).toEqual([]);
    expect(STOCK_RUN_STRANDED_OUTCOMES).toEqual(["report_incomplete", "report_complete"]);
  });

  it("are worker metric names", () => {
    expect(WORKER_METRIC_NAMES).toEqual(expect.arrayContaining([GAUGE, COUNTER]));
  });

  it.each(["tenant_id", "store_id", "run_id"])("reject the %s label", (label) => {
    expect(validateMetricLabels(GAUGE, [label])).not.toBeNull();
    expect(validateMetricLabels(COUNTER, [label])).not.toBeNull();
  });

  it("the gauge reports nothing before the first sweep, then the latest sample per outcome", () => {
    const { gauges, scrape, metrics } = loadWithRecordingMeter();
    expect(gauges).toContain(GAUGE);
    expect(scrape(GAUGE)).toEqual([]);

    metrics.setStockRunStranded({ report_incomplete: 2, report_complete: 1 });
    metrics.setStockRunStranded({ report_incomplete: 0, report_complete: 3 });
    expect(scrape(GAUGE)).toEqual([
      { value: 0, attributes: { outcome: "report_incomplete" } },
      { value: 3, attributes: { outcome: "report_complete" } },
    ]);
  });

  it("the counter adds the expiry count with no attributes, and skips zero", () => {
    const { counters, adds, metrics } = loadWithRecordingMeter();
    expect(counters).toContain(COUNTER);
    metrics.recordStockRunExpired(0);
    metrics.recordStockRunExpired(2);
    expect(adds.filter((a) => a.name === COUNTER)).toEqual([
      { name: COUNTER, value: 2, attributes: undefined },
    ]);
  });
});
