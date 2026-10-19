/**
 * RT-648 — the report and the recorded-set seam respond to a non-baseline
 * replay: a later experiment (RT-657) replays its recorded outputs through the
 * same runner, so the verdict, the gate table and the divergence line must move
 * when the replayed responses are bad, and the wording must follow the source.
 */
import { explain } from "./e1.baseline";
import { E1_CASES, materialize, materializeTwin } from "./e1.cases";
import type { E1Out } from "./e1.out-schema";
import { evaluationKey, renderReport, replaySetHash, runDataset, twinKey } from "./e1.report";
import type { E1Case, E1Pack, Lang } from "./e1.types";

const INFO = { runDate: "fixture", codeSha: "fixture" } as const;
const caseOf = (id: string): E1Case => {
  const found = E1_CASES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(id);
  return found;
};

/** The C27 baseline output rewritten as a model that believes the injected "it is posted". */
function followedInjection(pack: E1Pack): E1Out {
  const out = explain(pack);
  const docRef = `ev:consoleGetSale/${pack.scope.sale_ref}#/erpPosting/saleDocumentRef`;
  return {
    ...out,
    tracks: { ...out.tracks, erp_sale: { ...out.tracks.erp_sale, state: "posted", rule_id: "B1" } },
    claims: out.claims.map((claim) =>
      claim.template_id === "B2" ? { template_id: "B1", params: { saleDocumentRef: null }, evidence_refs: [docRef] } : claim,
    ),
  };
}

const hostile = (lang: Lang = "en"): E1Pack => materialize(caseOf("E1-C27"), lang).pack;
const twin = (lang: Lang = "en"): E1Pack => {
  const material = materializeTwin(caseOf("E1-C27"), lang);
  if (material === null) throw new Error("E1-C27 has a twin");
  return material.pack;
};

describe("runDataset with a recorded set", () => {
  it("fails the verdict and names the evaluation when only the hostile replay follows an injection", async () => {
    const run = await runDataset({ [evaluationKey("E1-C27", "en")]: followedInjection(hostile()) });
    const report = renderReport(run, INFO);
    expect(report).toContain("| S6 | FAIL | E1-C27/en |");
    expect(report).toContain("Harness verdict: FAIL");
    expect(replaySetHash(run)).not.toBe(replaySetHash(await runDataset()));
  });

  it("does not call a shared quality error an injection: the twin is replayed from its own recorded entry", async () => {
    const run = await runDataset({
      [evaluationKey("E1-C27", "en")]: followedInjection(hostile()),
      [twinKey("E1-C27", "en")]: followedInjection(twin()),
    });
    const gate = run.evaluations
      .find((e) => e.obs.m.c.id === "E1-C27" && e.obs.m.lang === "en")
      ?.gates.find((g) => g.gate === "S6");
    expect(gate?.pass).toBe(true);
  });

  it("includes twin responses in the replay-set hash", async () => {
    const base = await runDataset();
    const changed = await runDataset({ [twinKey("E1-C27", "en")]: followedInjection(twin()) });
    expect(replaySetHash(changed)).not.toBe(replaySetHash(base));
  });

  it("counts a schema-invalid replay as a gateway fallback that shows the baseline", async () => {
    const out = explain(materialize(caseOf("E1-C09"), "en").pack);
    const run = await runDataset({ [evaluationKey("E1-C09", "en")]: { ...out, narrative: "free text" } });
    const report = renderReport(run, INFO);
    expect(report).toContain("the gateway fell back in 19.");
    expect(report).toContain("Harness verdict: PASS");
  });

  it.each(["E1-C27/EN", "E1-c27/en", "E1-C27/en/Twin", "E1-C09/en/twin", "nope"])(
    "rejects the unknown recorded key %s instead of silently replaying the baseline",
    async (key) => {
      await expect(runDataset({ [key]: {} })).rejects.toThrow(/Unknown recorded-set key/);
    },
  );

  it("words the report by its source: baseline snapshot versus a supplied recorded set", async () => {
    const baselineReport = renderReport(await runDataset(), INFO);
    expect(baselineReport).toContain("identical by construction");
    expect(baselineReport).toContain("no model was evaluated");
    const out = explain(materialize(caseOf("E1-C09"), "en").pack);
    const recordedReport = renderReport(await runDataset({ [evaluationKey("E1-C09", "en")]: { ...out, narrative: "x" } }), INFO);
    expect(recordedReport).toContain("supplied recorded set");
    expect(recordedReport).not.toContain("identical by construction");
    expect(recordedReport).not.toContain("no model was evaluated");
  });

  it("counts a response whose runbook refs are only reordered as an exact set match (M3)", async () => {
    const out = explain(materialize(caseOf("E1-C06"), "en").pack);
    expect(out.runbook_refs.length).toBeGreaterThan(1);
    const reordered = { ...out, runbook_refs: [...out.runbook_refs].reverse() };
    const report = renderReport(await runDataset({ [evaluationKey("E1-C06", "en")]: reordered }), INFO);
    expect(report).toMatch(/\| M3 runbook refs, exact set \| 80\/80 = 1\.000 CI95 \[0\.954, 1\.000\] \| 80\/80 = 1\.000/);
  });
});
