/**
 * RT-648 — emit the RT-645 §3.3 evaluation report for a replayed run.
 *
 * The report is deterministic: no clock, no timing, no host data. The only
 * run-specific inputs (`runDate`, `codeSha`) are passed in and are the only
 * values that may differ between two renders of the same run. It carries no AI
 * quality score: the harness runs on fixtures against transcribed labels.
 *
 * The wording follows the replay source: when every replayed response is the
 * baseline's own snapshot the report says so; when a recorded set was supplied
 * it says that instead, and never claims the column is the baseline.
 */
import { datasetHash, sha256Of } from "./e1.canonical";
import { E1_CASES, E1_DATASET_VERSION } from "./e1.cases";
import { AUTOMATED_GATES, type GateId } from "./e1.gates";
import { abstentionRows, formatProportion, gatewayRows, metricsOf, tagRows } from "./e1.metrics";
import { evaluationKey, isBaselineSnapshot, replaySetHash, runDataset, twinKey, type EvalRun, type EvaluationResult } from "./e1.run";
import { E1_VERSIONS } from "./e1.types";

export { evaluationKey, replaySetHash, runDataset, twinKey } from "./e1.run";
export type { EvalRun, EvaluationResult } from "./e1.run";

export interface RunInfo {
  readonly runDate: string;
  readonly codeSha: string;
}

const failingIds = (run: EvalRun, gate: GateId): string[] =>
  run.evaluations
    .filter((e) => e.gates.some((g) => g.gate === gate && !g.pass))
    .map((e) => `${e.obs.m.c.id}/${e.obs.m.lang}`);

const listOrNone = (ids: readonly string[], none: string): string => (ids.length === 0 ? none : ids.join(", "));

function gateRow(run: EvalRun, gate: GateId): string {
  const failing = failingIds(run, gate);
  const declared = E1_CASES.filter((c) => c.gates.includes(gate)).map((c) => c.id);
  return `| ${gate} | ${failing.length === 0 ? "PASS" : "FAIL"} | ${listOrNone(failing, "none")} | ${listOrNone(declared, "none declared")} |`;
}

const HEADER_BASELINE = [
  "> This is a harness self-check on synthetic fixtures only. No model was evaluated, no provider or network was used, and",
  "> no AI quality score exists. It follows the RT-645 §3.3 report template.",
];
const HEADER_RECORDED = [
  "> This report replays a supplied recorded set through the offline harness; the harness itself used no provider or network.",
  "> Gold labels are spec-transcribed, not human-adjudicated, so no figure here is a validated quality score. It follows the RT-645 §3.3 report template.",
];

function identityLines(run: EvalRun, info: RunInfo): string[] {
  const dataset = datasetHash();
  const replay = replaySetHash(run);
  const runId = sha256Of({ dataset, replay, evaluator: E1_VERSIONS.evaluator }).slice(0, 16);
  return [
    "## 1. Run identity",
    "",
    `- Run ID: ${runId}`,
    `- Run date: ${info.runDate}`,
    `- Code SHA: ${info.codeSha}`,
    "- RT-647 contract baseline: Kemetra/Backend-Core main 99764580 (E1-EP v1, E1-BL v1, e1-gold/1)",
    `- Dataset: ${E1_DATASET_VERSION}, sha256 ${dataset}`,
    `- Replay set (recorded responses): sha256 ${replay}`,
    `- Prompt template: ${E1_VERSIONS.promptTemplateId}@${E1_VERSIONS.promptTemplateVersion}`,
    `- Output schema: ${E1_VERSIONS.outputSchemaId}`,
    `- Provider: ${E1_VERSIONS.providerKey} (RecordedModelProvider; no network, no credential, no SDK)`,
    `- Model ID: ${E1_VERSIONS.modelId} (replay fixture, not a model)`,
    "- Parameters: none (no sampling; responses are replayed)",
    "- Tool definitions: none (no model tool calling in slice 1)",
    `- Baseline: ${E1_VERSIONS.baseline}`,
    `- Evaluator: ${E1_VERSIONS.evaluator}`,
    "",
  ];
}

function scopeLines(run: EvalRun): string[] {
  return [
    "## 2. Scope",
    "",
    "- Slice: sync_doctor.explain_sale (E1). Phase: P0, synthetic fixtures only, no model calls.",
    "- Tenants and stores: synthetic. T-A has store A1 (Africa/Cairo) and A2 (UTC); T-B has store B1.",
    `- Cases: ${E1_CASES.length}; evaluations: ${run.evaluations.length} (each case with an EN and an AR question).`,
    "",
    "| Coverage tag | Cases |",
    "| --- | --- |",
    ...tagRows(E1_CASES.map((c) => c.tags)),
    "",
  ];
}

function gateLines(run: EvalRun): string[] {
  return [
    "## 3. Safety gates",
    "",
    "| Gate | Result | Failing evaluations | Cases declaring the gate |",
    "| --- | --- | --- | --- |",
    ...AUTOMATED_GATES.map((gate) => gateRow(run, gate)),
    "",
    "- S4: not automated in RT-648 (forbidden-claim and numeric-trace evaluators).",
    "- S7: not automated in RT-648 (provider outage and kill switch need a live-path test).",
    "- S8: not automated in RT-648 (the frozen-pack field allowlist is asserted in the dataset spec, not scored as a gate).",
    "- S9: not automated in RT-648 (POS independence).",
    "",
  ];
}

const QUALITY_INTRO_BASELINE = [
  "Both columns are measured against hand-transcribed gold labels. The baseline implements the same RT-647 rule table the",
  "labels were transcribed from, so agreement is a consistency check, not quality evidence. The replay variant replays the",
  "baseline's own snapshot, so its column is identical by construction: it validates the replay plumbing, not a model.",
];
const QUALITY_INTRO_RECORDED = [
  "Both columns are measured against hand-transcribed gold labels. The baseline implements the same RT-647 rule table the",
  "labels were transcribed from, so its agreement is a consistency check, not quality evidence. The replay column is computed",
  "from the supplied recorded set; the gold labels are not human-adjudicated, so it is not a validated quality score either.",
];

function qualityLines(run: EvalRun, baselineOnly: boolean): string[] {
  const baseline = metricsOf(run, "baseline");
  const replay = metricsOf(run, "displayed");
  const rows = Object.keys(baseline).map(
    (name) => `| ${name} | ${formatProportion(baseline[name] ?? { k: 0, n: 0 })} | ${formatProportion(replay[name] ?? { k: 0, n: 0 })} |`,
  );
  const same = run.evaluations.filter((e) => JSON.stringify(e.obs.displayed) === JSON.stringify(e.obs.baseline)).length;
  const fallbacks = run.evaluations.filter((e) => e.obs.gateway.kind === "fallback").length;
  return [
    "## 4. Quality versus the deterministic baseline",
    "",
    ...(baselineOnly ? QUALITY_INTRO_BASELINE : QUALITY_INTRO_RECORDED),
    "",
    `| Metric | Baseline vs gold (consistency check, not quality evidence) | Replay variant vs gold (${baselineOnly ? "synthetic snapshot" : "supplied recorded set"}) |`,
    "| --- | --- | --- |",
    ...rows,
    "",
    `Displayed output equals the baseline output in ${same}/${run.evaluations.length} evaluations; the gateway fell back in ${fallbacks}.`,
    baselineOnly
      ? "Quality of any real model: not measured; no model was evaluated."
      : "Quality of the supplied recorded set: see the replay column above; no human review has been performed.",
    "",
  ];
}

function abstentionLines(run: EvalRun): string[] {
  return [
    "## 5. Abstention analysis (baseline vs gold)",
    "",
    "| Class | Correct | Incorrect (shown, not gold) | Missed (gold, not shown) |",
    "| --- | --- | --- | --- |",
    ...abstentionRows(run),
    "",
    "Gateway outcomes (abstentions are decided before any provider request):",
    "",
    "| Outcome | Evaluations |",
    "| --- | --- |",
    ...gatewayRows(run),
    "",
  ];
}

function closingLines(run: EvalRun): string[] {
  const allPass = run.evaluations.every((e) => e.gates.every((g) => g.pass));
  return [
    "## 6. Latency and cost",
    "",
    "- Latency: not measured (replay only).",
    "- Cost: not measured (no spend, no provider).",
    "",
    "## 7. Human review",
    "",
    "- Human review: not performed. Gold labels are spec-transcribed from RT-647 §6.2; no dual human labelling or adjudication has taken place on this dataset.",
    "",
    "## 8. Known gaps and deviations",
    "",
    "- The harness is DB-less: S1 and S3 are checked at the pack-builder and gateway layer. RLS and the DB write audit are not exercised.",
    "- The pack builder is a test-tree stand-in; no production E1 evidence builder exists yet.",
    "- Interpretations of RT-647: 429 (RT-620) is a read failure; RB-E1-00 is suppressed when another runbook applies; template ids X1/X2/H0 are implementer names.",
    "- Baseline constants OD-3 (10 × 200 walk cap, 30 s skew, document-ref pattern) and OD-1/OD-2/OD-4 were approved by the owner on 2026-10-17; OD-5 is open for later dataset versions.",
    "- Runtime and business data are not verified (RT-651). Fixtures follow the contracts, not observed data.",
    "",
    "## 9. Recommendation",
    "",
    `- Harness verdict: ${allPass ? "PASS" : "FAIL"} (gates S1, S2, S3, S5, S6 on ${run.evaluations.length} replayed evaluations).`,
    "- Phase recommendation: none. This is an input to the owner's decision, not a decision. P1 (a model run) needs separate provider, credential and spend approval.",
    "",
  ];
}

export function renderReport(run: EvalRun, info: RunInfo): string {
  const baselineOnly = isBaselineSnapshot(run);
  return [
    "# RT-648 offline eval report — Sync Doctor E1 (replay-only)",
    "",
    ...(baselineOnly ? HEADER_BASELINE : HEADER_RECORDED),
    "",
    ...identityLines(run, info),
    ...scopeLines(run),
    ...gateLines(run),
    ...qualityLines(run, baselineOnly),
    ...abstentionLines(run),
    ...closingLines(run),
  ].join("\n");
}
