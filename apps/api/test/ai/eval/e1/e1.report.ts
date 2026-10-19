/**
 * RT-648 — run the pinned dataset through the replay harness and emit the
 * RT-645 §3.3 evaluation report.
 *
 * The report is deterministic: no clock, no timing, no host data. The only
 * run-specific inputs (`runDate`, `codeSha`) are passed in and are the only
 * values that may differ between two renders of the same run. It carries no AI
 * quality score: the harness runs on fixtures and no model is evaluated.
 */
import { sha256Of, datasetHash } from "./e1.canonical";
import { E1_CASES, E1_DATASET_VERSION, materialize, materializeTwin } from "./e1.cases";
import { AUTOMATED_GATES, evaluateGates, type GateId, type GateOutcome } from "./e1.gates";
import { observe, type Observation } from "./e1.replay";
import { refResolves } from "./e1.gates";
import { E1_CLASSES, E1_VERSIONS, type Lang } from "./e1.types";

export interface EvaluationResult {
  readonly obs: Observation;
  readonly twin: Observation | null;
  readonly gates: readonly GateOutcome[];
}

export interface EvalRun {
  readonly evaluations: readonly EvaluationResult[];
}

export interface RunInfo {
  readonly runDate: string;
  readonly codeSha: string;
}

const LANGS: readonly Lang[] = ["en", "ar"];

/** Replay every evaluation (case × language) and evaluate the automated gates. */
export async function runDataset(): Promise<EvalRun> {
  const evaluations: EvaluationResult[] = [];
  for (const c of E1_CASES) {
    for (const lang of LANGS) {
      const obs = await observe(materialize(c, lang));
      const twinMaterial = materializeTwin(c, lang);
      const twin = twinMaterial === null ? null : await observe(twinMaterial);
      evaluations.push({ obs, twin, gates: evaluateGates(obs, twin) });
    }
  }
  return { evaluations };
}

/** The recorded responses replayed, keyed by evaluation: what a replay re-serves. */
export function replaySetHash(run: EvalRun): string {
  return sha256Of(
    Object.fromEntries(run.evaluations.map(({ obs }) => [`${obs.m.c.id}/${obs.m.lang}`, obs.raw])),
  );
}

interface Proportion {
  readonly k: number;
  readonly n: number;
}

const pct = (value: number): string => value.toFixed(3);

/** Wilson score interval, 95%. */
function wilson({ k, n }: Proportion): string {
  if (n === 0) return "n/a";
  const z = 1.96;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return `[${pct(Math.max(0, center - margin))}, ${pct(Math.min(1, center + margin))}]`;
}

const cell = ({ k, n }: Proportion): string => `${k}/${n} = ${n === 0 ? "n/a" : pct(k / n)} CI95 ${wilson({ k, n })}`;

type Source = "baseline" | "displayed";

function metrics(run: EvalRun, source: Source): Record<string, Proportion> {
  const total = run.evaluations.length;
  const count = (hit: (e: EvaluationResult) => boolean): Proportion => ({
    k: run.evaluations.filter(hit).length,
    n: total,
  });
  const out = (e: EvaluationResult) => e.obs[source];
  const gold = (e: EvaluationResult) => e.obs.m.c.gold;
  const claims = run.evaluations.flatMap((e) => out(e).claims.map((claim) => ({ e, claim })));
  return {
    "M1 state, processing": count((e) => out(e).tracks.processing.state === gold(e).processing),
    "M1 state, ERP sale": count((e) => out(e).tracks.erp_sale.state === gold(e).erp_sale),
    "M1 state, ERP reversal": count((e) => out(e).tracks.erp_reversal.state === gold(e).erp_reversal),
    "M2 first failing boundary": count((e) => out(e).first_failing_boundary === gold(e).boundary),
    "M3 runbook refs, exact set": count((e) => out(e).runbook_refs.join() === gold(e).runbooks.join()),
    "M4 evidence-backed claims": {
      k: claims.filter(({ e, claim }) => claim.evidence_refs.length > 0 && claim.evidence_refs.every((ref) => refResolves(e.obs.m.pack, ref))).length,
      n: claims.length,
    },
  };
}

function abstentionRows(run: EvalRun): string[] {
  return E1_CLASSES.map((cls) => {
    const shown = (e: EvaluationResult) => e.obs.baseline.class;
    const tp = run.evaluations.filter((e) => shown(e) === cls && e.obs.m.c.gold.class === cls).length;
    const fp = run.evaluations.filter((e) => shown(e) === cls && e.obs.m.c.gold.class !== cls).length;
    const fn = run.evaluations.filter((e) => shown(e) !== cls && e.obs.m.c.gold.class === cls).length;
    return `| ${cls} | ${tp} | ${fp} | ${fn} |`;
  });
}

function gatewayRows(run: EvalRun): string[] {
  const counts = new Map<string, number>();
  for (const { obs } of run.evaluations) {
    const key = obs.gateway.kind === "ok" ? "ok (recorded response validated and shown)" : `fallback: ${obs.gateway.reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, n]) => `| ${key} | ${n} |`);
}

function tagRows(): string[] {
  const counts = new Map<string, number>();
  for (const c of E1_CASES) for (const tag of c.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([tag, n]) => `| ${tag} | ${n} |`);
}

function gateRows(run: EvalRun): string[] {
  const rows = AUTOMATED_GATES.map((gate: GateId) => {
    const failing = run.evaluations
      .filter((e) => e.gates.some((g) => g.gate === gate && !g.pass))
      .map((e) => `${e.obs.m.c.id}/${e.obs.m.lang}`);
    const declared = E1_CASES.filter((c) => c.gates.includes(gate)).map((c) => c.id);
    const verdict = failing.length === 0 ? "PASS" : "FAIL";
    return `| ${gate} | ${verdict} | ${failing.length === 0 ? "none" : failing.join(", ")} | ${declared.length === 0 ? "none declared" : declared.join(", ")} |`;
  });
  return rows;
}

function metricRows(run: EvalRun): string[] {
  const baseline = metrics(run, "baseline");
  const replay = metrics(run, "displayed");
  return Object.keys(baseline).map((name) => `| ${name} | ${cell(baseline[name] as Proportion)} | ${cell(replay[name] as Proportion)} |`);
}

function divergenceLine(run: EvalRun): string {
  const same = run.evaluations.filter((e) => JSON.stringify(e.obs.displayed) === JSON.stringify(e.obs.baseline)).length;
  const fallbacks = run.evaluations.filter((e) => e.obs.gateway.kind === "fallback").length;
  return `Displayed output equals the baseline output in ${same}/${run.evaluations.length} evaluations; the gateway fell back in ${fallbacks}.`;
}

export function renderReport(run: EvalRun, info: RunInfo): string {
  const dataset = datasetHash();
  const replay = replaySetHash(run);
  const runId = sha256Of({ dataset, replay, evaluator: E1_VERSIONS.evaluator }).slice(0, 16);
  const allPass = run.evaluations.every((e) => e.gates.every((g) => g.pass));
  const lines: string[] = [
    "# RT-648 offline eval report — Sync Doctor E1 (replay-only)",
    "",
    "> This is a harness self-check on synthetic fixtures only. No model was evaluated, no provider or network was used, and",
    "> no AI quality score exists. It follows the RT-645 §3.3 report template.",
    "",
    "## 1. Run identity",
    "",
    `- Run ID: ${runId}`,
    `- Run date: ${info.runDate}`,
    `- Code SHA: ${info.codeSha}`,
    `- RT-647 contract baseline: Kemetra/Backend-Core main 99764580 (E1-EP v1, E1-BL v1, e1-gold/1)`,
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
    "## 2. Scope",
    "",
    "- Slice: sync_doctor.explain_sale (E1). Phase: P0, synthetic fixtures only, no model calls.",
    "- Tenants and stores: synthetic. T-A has store A1 (Africa/Cairo) and A2 (UTC); T-B has store B1.",
    `- Cases: ${E1_CASES.length}; evaluations: ${run.evaluations.length} (each case with an EN and an AR question).`,
    "",
    "| Coverage tag | Cases |",
    "| --- | --- |",
    ...tagRows(),
    "",
    "## 3. Safety gates",
    "",
    "| Gate | Result | Failing evaluations | Cases declaring the gate |",
    "| --- | --- | --- | --- |",
    ...gateRows(run),
    "",
    "- S4: not automated in RT-648 (forbidden-claim and numeric-trace evaluators).",
    "- S7: not automated in RT-648 (provider outage and kill switch need a live-path test).",
    "- S8: not automated in RT-648 (the frozen-pack field allowlist is asserted in the dataset spec, not scored as a gate).",
    "- S9: not automated in RT-648 (POS independence).",
    "",
    "## 4. Quality versus the deterministic baseline",
    "",
    "Both columns are measured against hand-transcribed gold labels. The baseline implements the same RT-647 rule table the",
    "labels were transcribed from, so agreement is a consistency check, not quality evidence. The replay variant replays the",
    "baseline's own snapshot, so its column is identical by construction: it validates the replay plumbing, not a model.",
    "",
    "| Metric | Baseline vs gold (consistency check, not quality evidence) | Replay variant vs gold (synthetic snapshot) |",
    "| --- | --- | --- |",
    ...metricRows(run),
    "",
    divergenceLine(run),
    "Quality of any real model: not measured; no model was evaluated.",
    "",
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
  return lines.join("\n");
}

