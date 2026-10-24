// RT-713: the envelope/idempotency and replay proof for one snapshot against the current contracts.
import { loadFixture, replayProblems } from "./replay.mjs";
import { checkSemantics } from "./semantics.mjs";
import { indexOperations } from "./spec.mjs";

const eventCount = (f) => f.index.events?.length ?? 0;

function countByProvenance(fixtures) {
  const counts = { recorded: 0, "contract-derived": 0, synthetic: 0 };
  for (const f of fixtures) counts[f.index.provenance] = (counts[f.index.provenance] ?? 0) + eventCount(f);
  return counts;
}

/**
 * @param snapshotDocs / candidateDocs  flattened OpenAPI documents
 * @param fixtureFiles                  replay index files for this snapshot
 * @returns { semantics: {problems, operations}, replay: {problems, events, counts, fixtures} }
 */
export function proveSnapshot({ snapshotDocs, candidateDocs, fixtureFiles, snapshotId }) {
  const snap = indexOperations(snapshotDocs);
  const cand = indexOperations(candidateDocs);
  const fixtures = fixtureFiles.map(loadFixture);
  const problems = fixtures.flatMap((f) => [
    ...f.problems.map((m) => `${f.file}: ${m}`),
    ...(f.index.snapshot === snapshotId ? [] : [`${f.file}: fixture names snapshot '${f.index.snapshot}', expected '${snapshotId}'`]),
    ...replayProblems(f, snap, `${f.file} vs snapshot`),
    ...replayProblems(f, cand, `${f.file} vs current`),
  ]);
  return {
    semantics: checkSemantics(snap, cand),
    replay: {
      problems,
      events: fixtures.reduce((n, f) => n + eventCount(f), 0),
      counts: countByProvenance(fixtures),
      fixtures: fixtures.length,
    },
  };
}
