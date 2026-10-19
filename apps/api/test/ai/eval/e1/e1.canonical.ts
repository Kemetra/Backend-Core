/**
 * RT-648 — canonical hashing for the pinned dataset, replay set and report.
 *
 * Hashes are over canonical JSON of parsed values (keys sorted by code unit via
 * the repo serializer), never over raw file bytes, so line-ending conversion on
 * a Windows checkout cannot change them.
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "../../../../src/idempotency/canonical-json";
import { E1_CASES, E1_DATASET_VERSION, materialize, materializeTwin } from "./e1.cases";

export function sha256Of(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** The dataset: every case, its frozen EN and AR packs, and the gold labels. */
export function datasetHash(): string {
  return sha256Of({
    version: E1_DATASET_VERSION,
    cases: E1_CASES.map((c) => ({
      id: c.id,
      actor: c.actor,
      scopeStores: c.scopeStores,
      question: c.question,
      gold: c.gold,
      tags: c.tags,
      gates: c.gates,
      scenario: c.scenario,
      twin: c.twin ?? null,
      packs: { en: materialize(c, "en").pack, ar: materialize(c, "ar").pack },
      twinPacks: { en: materializeTwin(c, "en")?.pack ?? null, ar: materializeTwin(c, "ar")?.pack ?? null },
    })),
  });
}
