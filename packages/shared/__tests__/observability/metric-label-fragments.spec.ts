/**
 * RT-812 — ALLOWED_METRIC_LABELS is assembled from one fragment per domain
 * (`src/observability/metric-labels/<slug>.labels.ts`), so two PRs that each
 * add a metric add different files. These tests pin how the fragments merge
 * and that a bad fragment fails at import instead of loosening the allowlist.
 */
import {
  ALLOWED_METRIC_LABELS,
  METRIC_LABEL_SOURCES,
  buildMetricLabelRegistry,
} from "../../src/observability/metrics-labels";

const fragment = (name: string, labels: unknown) => ({ name, exports: { METRIC_LABELS: labels } });

describe("buildMetricLabelRegistry", () => {
  it("merges the fragments and records which fragment registered each metric", () => {
    const { labels, sources } = buildMetricLabelRegistry([
      fragment("baseline", { a_total: ["route"] }),
      fragment("refunds", { refund_total: ["outcome"], refund_amount: [] }),
    ]);
    expect(labels).toEqual({ a_total: ["route"], refund_total: ["outcome"], refund_amount: [] });
    expect(sources).toEqual({ a_total: "baseline", refund_total: "refunds", refund_amount: "refunds" });
    expect(Object.isFrozen(labels)).toBe(true);
    expect(Object.isFrozen(labels["refund_total"])).toBe(true);
  });

  it("refuses a metric registered by two fragments", () => {
    expect(() =>
      buildMetricLabelRegistry([
        fragment("baseline", { a_total: [] }),
        fragment("other", { a_total: ["route"] }),
      ]),
    ).toThrow(/a_total.*registered by both baseline and other/);
  });

  it.each([
    ["no METRIC_LABELS export", { name: "x", exports: {} }],
    ["a non-object export", fragment("x", ["a_total"])],
    ["a non-array label list", fragment("x", { a_total: "route" })],
    ["a non-string label", fragment("x", { a_total: [1] })],
    ["a non-snake_case metric", fragment("x", { "A-total": [] })],
  ])("refuses a fragment with %s", (_label, bad) => {
    expect(() => buildMetricLabelRegistry([fragment("baseline", {}), bad])).toThrow(
      /metric-labels fragment x/,
    );
  });
});

describe("ALLOWED_METRIC_LABELS (loaded from the fragment directory)", () => {
  it("is frozen and every metric has a source fragment", () => {
    expect(Object.isFrozen(ALLOWED_METRIC_LABELS)).toBe(true);
    expect(Object.keys(METRIC_LABEL_SOURCES).sort()).toEqual(Object.keys(ALLOWED_METRIC_LABELS).sort());
  });

  it("loads the baseline fragment", () => {
    expect(METRIC_LABEL_SOURCES["http_request_count"]).toBe("baseline");
  });
});
