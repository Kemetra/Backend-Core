/**
 * RT-648 — run the pinned dataset through the replay harness.
 *
 * `recorded` is the seam a later real-provider experiment (RT-657) plugs
 * recorded outputs into. It maps `<caseId>/<lang>` to the response replayed for
 * that evaluation and `<caseId>/<lang>/twin` to the response replayed for its
 * clean S6 twin; an evaluation without an entry replays the baseline's own
 * snapshot. Twins have their own key so a model's behaviour on the clean twin
 * is compared with its behaviour on the hostile case, not with the baseline.
 */
import { sha256Of } from "./e1.canonical";
import { E1_CASES, materialize, materializeTwin } from "./e1.cases";
import { evaluateGates, type GateOutcome } from "./e1.gates";
import { observe, type Observation } from "./e1.replay";
import type { E1Case, Lang } from "./e1.types";

export interface EvaluationResult {
  readonly obs: Observation;
  readonly twin: Observation | null;
  readonly gates: readonly GateOutcome[];
}

export interface EvalRun {
  readonly evaluations: readonly EvaluationResult[];
}

export type RecordedSet = Readonly<Record<string, unknown>>;

const LANGS: readonly Lang[] = ["en", "ar"];

/** Key of one evaluation in a recorded set: `<caseId>/<lang>`. */
export const evaluationKey = (caseId: string, lang: Lang): string => `${caseId}/${lang}`;

/** Key of the clean twin of one evaluation: `<caseId>/<lang>/twin`. */
export const twinKey = (caseId: string, lang: Lang): string => `${evaluationKey(caseId, lang)}/twin`;

async function evaluate(c: E1Case, lang: Lang, recorded: RecordedSet): Promise<EvaluationResult> {
  const obs = await observe(materialize(c, lang), recorded[evaluationKey(c.id, lang)]);
  const twinMaterial = materializeTwin(c, lang);
  const twin = twinMaterial === null ? null : await observe(twinMaterial, recorded[twinKey(c.id, lang)]);
  return { obs, twin, gates: evaluateGates(obs, twin) };
}

/** Replay every evaluation (case × language) and evaluate the automated gates. */
export async function runDataset(recorded: RecordedSet = {}): Promise<EvalRun> {
  const jobs = E1_CASES.flatMap((c) => LANGS.map((lang) => evaluate(c, lang, recorded)));
  return { evaluations: await Promise.all(jobs) };
}

/** The recorded responses replayed, twins included: what a replay re-serves. */
export function replaySetHash(run: EvalRun): string {
  const entries = run.evaluations.flatMap(({ obs, twin }) => {
    const key = evaluationKey(obs.m.c.id, obs.m.lang);
    return twin === null ? [[key, obs.raw]] : [[key, obs.raw], [`${key}/twin`, twin.raw]];
  });
  return sha256Of(Object.fromEntries(entries));
}

/** True when every replayed response (twins included) is the baseline's own snapshot. */
export function isBaselineSnapshot(run: EvalRun): boolean {
  const same = (obs: Observation): boolean => JSON.stringify(obs.raw) === JSON.stringify(obs.baseline);
  return run.evaluations.every(({ obs, twin }) => same(obs) && (twin === null || same(twin)));
}
