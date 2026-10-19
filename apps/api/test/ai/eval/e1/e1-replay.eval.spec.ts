/**
 * RT-648 — the offline eval gold run.
 *
 * Replays the pinned `e1-gold/1` dataset (40 cases × EN/AR) through the real
 * AiGateway and `ModelProviderPort`, served by recorded responses only, then
 * evaluates gates S1, S2, S3, S5 and S6 on every evaluation. ANY single gate
 * failure fails this suite, which is the CI job's pass/fail.
 *
 * This is a harness self-check on synthetic fixtures. It measures NO model:
 * the recorded response is the deterministic baseline's own snapshot, so no AI
 * quality score exists or is reported anywhere here.
 *
 * To refresh the committed report after an intentional dataset or baseline
 * change (a new dataset version): UPDATE_E1_GOLDEN=1 pnpm --filter
 * @data-pulse-2/api test -- e1-replay.eval
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AUTOMATED_GATES } from "./e1.gates";
import type { Observation } from "./e1.replay";
import { renderReport, replaySetHash, runDataset, type EvalRun } from "./e1.report";

const GOLDEN = join(__dirname, "e1-report.golden.md");
const PINNED_REPLAY_SET_SHA256 = "dab546e801abf9ddb6d952db75f9e74fe433904702d631efb2cef7159aa49726";
const FIXTURE_RUN_INFO = { runDate: "fixture", codeSha: "fixture" } as const;

const normalize = (text: string): string => text.replace(/\r\n/g, "\n");

const isAnswerable = (obs: Observation): boolean => ["answer", "refuse_unsafe"].includes(obs.m.c.gold.class);

/** One provider request for an answerable pack; no evidence, no request for an abstention. */
function decidedAsExpected(obs: Observation): boolean {
  const requested = obs.gateway.kind === "ok" && obs.consultations === 1 && obs.requests.length === 1;
  const refused = obs.gateway.kind === "fallback" && obs.consultations === 0 && obs.requests.length === 0;
  return isAnswerable(obs) ? requested : refused;
}

describe("e1 offline replay eval (gold run)", () => {
  let run: EvalRun;
  beforeAll(async () => {
    run = await runDataset();
  });

  it("replays all 80 evaluations through the gateway with recorded responses only", () => {
    expect(run.evaluations).toHaveLength(80);
    const provider = new Set(run.evaluations.flatMap((e) => e.obs.requests.map((r) => r.route.providerKey)));
    expect([...provider]).toEqual(["recorded"]);
  });

  it("sends only answerable packs to the provider port; every abstention is decided before any request", () => {
    const wrong = run.evaluations.filter(({ obs }) => !decidedAsExpected(obs)).map(({ obs }) => `${obs.m.c.id}/${obs.m.lang}`);
    expect(wrong).toEqual([]);
  });

  it("refuses unauthorized callers with the real authorization code, before evidence or a request", () => {
    const reasons = Object.fromEntries(
      run.evaluations
        .filter(({ obs }) => obs.m.lang === "en" && obs.m.c.gold.class === "abstain_unauthorized")
        .map(({ obs }) => [obs.m.c.id, obs.gateway.kind === "fallback" ? obs.gateway.reason : "ok"]),
    );
    expect(reasons).toEqual({
      "E1-C31": "store_out_of_scope",
      "E1-C32": "evidence_unavailable",
      "E1-C33": "evidence_unavailable",
      "E1-C34": "not_authorized",
    });
  });

  it("passes every automated gate on every evaluation (one failure fails the job)", () => {
    const failures = run.evaluations.flatMap((e) => e.gates.flatMap((gate) => gate.failures));
    expect(failures).toEqual([]);
    for (const gate of AUTOMATED_GATES) {
      expect(run.evaluations.every((e) => e.gates.some((g) => g.gate === gate && g.pass))).toBe(true);
    }
  });

  it("pins the replay set (the recorded responses) by content hash", () => {
    expect(replaySetHash(run)).toBe(PINNED_REPLAY_SET_SHA256);
  });

  it("renders the RT-645 §3.3 report byte-for-byte equal to the committed golden", () => {
    const report = renderReport(run, FIXTURE_RUN_INFO);
    if (process.env["UPDATE_E1_GOLDEN"] === "1") writeFileSync(GOLDEN, report, "utf8");
    expect(existsSync(GOLDEN)).toBe(true);
    expect(normalize(readFileSync(GOLDEN, "utf8"))).toBe(report);
  });

  it("is reproducible: a second full run renders the identical report", async () => {
    const again = await runDataset();
    expect(renderReport(again, FIXTURE_RUN_INFO)).toBe(renderReport(run, FIXTURE_RUN_INFO));
    expect(replaySetHash(again)).toBe(replaySetHash(run));
  });

  it("states what was not measured and never presents a model quality score", () => {
    const report = renderReport(run, FIXTURE_RUN_INFO);
    for (const required of [
      "synthetic fixtures only",
      "S4: not automated in RT-648",
      "S7: not automated in RT-648",
      "S8: not automated in RT-648",
      "S9: not automated in RT-648",
      "Latency: not measured",
      "Cost: not measured",
      "Human review: not performed",
      "consistency check, not quality evidence",
      "no model was evaluated",
    ]) {
      expect(report).toContain(required);
    }
    expect(report).not.toMatch(/\bGO\b(?! |\/)/);
  });
});
