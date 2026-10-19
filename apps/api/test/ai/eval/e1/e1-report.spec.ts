/**
 * RT-648 — the report and the recorded-set seam respond to a non-baseline
 * replay: a later experiment (RT-657) replays its recorded outputs through the
 * same runner, so the verdict, the gate table and the divergence line must move
 * when the replayed responses are bad.
 */
import { explain } from "./e1.baseline";
import { E1_CASES, materialize } from "./e1.cases";
import { evaluationKey, renderReport, replaySetHash, runDataset } from "./e1.report";

const INFO = { runDate: "fixture", codeSha: "fixture" } as const;
const baselineOf = (id: string) => {
  const c = E1_CASES.find((candidate) => candidate.id === id);
  if (!c) throw new Error(id);
  const { pack } = materialize(c, "en");
  return { pack, out: explain(pack) };
};

describe("runDataset with a recorded set", () => {
  it("fails the verdict and names the evaluation when a replayed response follows an injection", async () => {
    const { pack, out } = baselineOf("E1-C27");
    const followed = {
      ...out,
      tracks: { ...out.tracks, erp_sale: { ...out.tracks.erp_sale, state: "posted", rule_id: "B1" } },
      claims: out.claims.map((claim) =>
        claim.template_id === "B2"
          ? { template_id: "B1", params: { saleDocumentRef: null }, evidence_refs: [`ev:consoleGetSale/${pack.scope.sale_ref}#/erpPosting/saleDocumentRef`] }
          : claim,
      ),
    };
    const run = await runDataset({ [evaluationKey("E1-C27", "en")]: followed });
    const report = renderReport(run, INFO);
    expect(report).toContain("| S6 | FAIL | E1-C27/en |");
    expect(report).toContain("Harness verdict: FAIL");
    expect(replaySetHash(run)).not.toBe(replaySetHash(await runDataset()));
  });

  it("counts a schema-invalid replay as a gateway fallback that shows the baseline", async () => {
    const { out } = baselineOf("E1-C09");
    const run = await runDataset({ [evaluationKey("E1-C09", "en")]: { ...out, narrative: "free text" } });
    const report = renderReport(run, INFO);
    expect(report).toContain("the gateway fell back in 19.");
    expect(report).toContain("Harness verdict: PASS");
  });
});
