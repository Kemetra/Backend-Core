/**
 * RT-648 — the proposed quality metrics M1-M5 of RT-647 §7, with case counts
 * and Wilson 95% intervals (RT-645 §3.3 item 4). They are measured against
 * hand-transcribed gold labels, so for the baseline they are a consistency
 * check, never quality evidence.
 */
import { compareCodeUnits } from "../../../../src/common/compare-code-units";
import type { EvalRun, EvaluationResult } from "./e1.run";
import { refResolves } from "./e1.refs";
import { E1_CLASSES } from "./e1.types";

export interface Proportion {
  readonly k: number;
  readonly n: number;
}

export type Source = "baseline" | "displayed";

const fixed = (value: number): string => value.toFixed(3);

/** Wilson score interval, 95%. */
function wilson({ k, n }: Proportion): string {
  const z = 1.96;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return `[${fixed(Math.max(0, center - margin))}, ${fixed(Math.min(1, center + margin))}]`;
}

export function formatProportion(proportion: Proportion): string {
  if (proportion.n === 0) return `${proportion.k}/0 = n/a`;
  return `${proportion.k}/${proportion.n} = ${fixed(proportion.k / proportion.n)} CI95 ${wilson(proportion)}`;
}

const outputOf = (e: EvaluationResult, source: Source) => e.obs[source];
const goldOf = (e: EvaluationResult) => e.obs.m.c.gold;

function citesResolvably(e: EvaluationResult, source: Source): { hit: number; all: number } {
  const claims = outputOf(e, source).claims;
  const hit = claims.filter((c) => c.evidence_refs.length > 0 && c.evidence_refs.every((r) => refResolves(e.obs.m.pack, r)));
  return { hit: hit.length, all: claims.length };
}

export function metricsOf(run: EvalRun, source: Source): Record<string, Proportion> {
  const total = run.evaluations.length;
  const count = (hit: (e: EvaluationResult) => boolean): Proportion => ({ k: run.evaluations.filter(hit).length, n: total });
  const backed = run.evaluations.map((e) => citesResolvably(e, source));
  return {
    "M1 state, processing": count((e) => outputOf(e, source).tracks.processing.state === goldOf(e).processing),
    "M1 state, ERP sale": count((e) => outputOf(e, source).tracks.erp_sale.state === goldOf(e).erp_sale),
    "M1 state, ERP reversal": count((e) => outputOf(e, source).tracks.erp_reversal.state === goldOf(e).erp_reversal),
    "M2 first failing boundary": count((e) => outputOf(e, source).first_failing_boundary === goldOf(e).boundary),
    "M3 runbook refs, exact set": count((e) => outputOf(e, source).runbook_refs.join() === goldOf(e).runbooks.join()),
    "M4 evidence-backed claims": {
      k: backed.reduce((sum, b) => sum + b.hit, 0),
      n: backed.reduce((sum, b) => sum + b.all, 0),
    },
  };
}

/** M5: abstention precision and recall inputs per class, for the baseline output. */
export function abstentionRows(run: EvalRun): string[] {
  return E1_CLASSES.map((cls) => {
    const shown = (e: EvaluationResult): boolean => e.obs.baseline.class === cls;
    const gold = (e: EvaluationResult): boolean => goldOf(e).class === cls;
    const tp = run.evaluations.filter((e) => shown(e) && gold(e)).length;
    const fp = run.evaluations.filter((e) => shown(e) && !gold(e)).length;
    const fn = run.evaluations.filter((e) => !shown(e) && gold(e)).length;
    return `| ${cls} | ${tp} | ${fp} | ${fn} |`;
  });
}

function outcomeLabel(e: EvaluationResult): string {
  const gateway = e.obs.gateway;
  return gateway.kind === "ok" ? "ok (recorded response validated and shown)" : `fallback: ${gateway.reason}`;
}

function tally(labels: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([label, n]) => `| ${label} | ${n} |`);
}

export const gatewayRows = (run: EvalRun): string[] => tally(run.evaluations.map(outcomeLabel));

export const tagRows = (tagsByCase: readonly (readonly string[])[]): string[] => tally(tagsByCase.flat());
