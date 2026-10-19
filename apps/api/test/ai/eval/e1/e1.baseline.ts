/**
 * RT-648 — the deterministic rule-table baseline `E1-BL v1` (RT-647 §5).
 *
 * A pure function `explain(pack) → E1-OUT`: no I/O, no clock, no randomness.
 * Rules run in the RT-647 order: gate rules and consistency rules
 * (`e1.baseline.rules.ts`), then tracks A, B and C (`e1.baseline.tracks.ts`).
 * The D0 semantic traps are encoded: no dead letter is not "posted", `synced`
 * is not ERP posting, `unknown` is not "not posted", and nothing is ever
 * "healthy".
 *
 * Interpretations made while implementing (also listed in the PR body):
 *  - 429 (added to the four reads by RT-620 after the RT-647 baseline) is a read
 *    failure, handled by R-G4;
 *  - RB-E1-00 ("none required") is suppressed when another runbook applies,
 *    which reconciles RT-647 §6.2 C22/C23 with rule B1;
 *  - template ids X1/X2 name the two consistency messages (R-C1..R-C3, B6),
 *    and H0 is the header line that quotes `businessDate` verbatim.
 */
import { arr, claim, rec, ref, str, text, viewOf, type Track, type View } from "./e1.baseline.base";
import { abstainOut, GAP_ENTRIES, gateAbstain, staleAbstain } from "./e1.baseline.rules";
import { erpSaleTrack, processingTrack, reversalTrack } from "./e1.baseline.tracks";
import type { E1Claim, E1Out } from "./e1.out-schema";
import { matchesActionRequest } from "./e1.text";
import type { E1Boundary, E1Pack } from "./e1.types";

const UNKNOWN_ORDER = ["erp_sale_state", "rejection_class", "erp_reversal_state", "reversal_class", "refund_reversal_state"] as const;
const BOUNDARY_ORDER: readonly E1Boundary[] = ["bc_sale_processing", "erp_sale_posting", "erp_reversal_posting"];

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function boundaryOf(tracks: readonly Track[], unknowns: readonly string[]): E1Boundary {
  const failed = tracks.findIndex((candidate) => candidate.failed);
  if (failed >= 0) return BOUNDARY_ORDER[failed] ?? "undetermined";
  return unknowns.length > 0 ? "undetermined" : "none_failed";
}

/** RB-E1-00 means "none required": it is dropped when any other runbook applies. */
function runbooksOf(tracks: readonly Track[]): string[] {
  const codes = [...new Set(tracks.flatMap((candidate) => candidate.runbooks))].sort(compareText);
  const others = codes.filter((code) => code !== "00");
  return (others.length > 0 ? others : codes).map((code) => `RB-E1-${code}`);
}

function headerClaim(view: View, saleRef: string): E1Claim {
  const summary = rec(rec(view.r1?.body)["summary"]);
  const at = (name: string): string => ref("consoleGetSale", saleRef, `/summary/${name}`);
  const params = {
    saleNumber: str(summary["saleNumber"]),
    businessDate: str(summary["businessDate"]),
    occurredAt: str(summary["occurredAt"]),
    currencyCode: str(summary["currencyCode"]),
    posTotal: str(summary["posTotal"]),
  };
  return claim("H0", params, at("businessDate"), at("occurredAt"), at("posTotal"));
}

function returnsClaims(view: View, saleRef: string): E1Claim[] {
  const count = arr(rec(view.r1?.body)["returns"]).length;
  return count > 0 ? [claim("C5", { n: count }, ref("consoleGetSale", saleRef, "/returns"))] : [];
}

type TrackStates = E1Out["tracks"];

function tracksOf(processing: Track, erp: Track, reversal: Track): TrackStates {
  return {
    processing: { state: processing.state as TrackStates["processing"]["state"], rule_id: processing.rule },
    erp_sale: { state: erp.state as TrackStates["erp_sale"]["state"], rule_id: erp.rule, backlog_class: erp.backlogClass },
    erp_reversal: { state: reversal.state as TrackStates["erp_reversal"]["state"], rule_id: reversal.rule },
  };
}

function answerOut(pack: E1Pack, view: View, saleRef: string, erp: Track): E1Out {
  const processing = processingTrack(view, saleRef);
  const reversal = reversalTrack(view, saleRef);
  const returns = returnsClaims(view, saleRef);
  const found = [...erp.unknowns, ...reversal.unknowns, ...(returns.length > 0 ? ["refund_reversal_state"] : [])];
  const action = matchesActionRequest(pack.question.text);
  const refusal = action ? [claim("G1", {}, "ev:pack#/question/lang")] : [];
  const tracks = [processing, erp, reversal];
  return {
    schema_version: "e1-out/1",
    pack_id: pack.pack_id,
    class: action ? "refuse_unsafe" : "answer",
    tracks: tracksOf(processing, erp, reversal),
    first_failing_boundary: boundaryOf(tracks, found),
    open_unknowns: UNKNOWN_ORDER.filter((name) => found.includes(name)),
    runbook_refs: runbooksOf(tracks),
    claims: [...refusal, headerClaim(view, saleRef), ...tracks.flatMap((candidate) => candidate.claims), ...returns],
    known_gaps: GAP_ENTRIES,
  };
}

export function explain(pack: E1Pack): E1Out {
  const view = viewOf(pack);
  const early = gateAbstain(pack, view) ?? staleAbstain(pack, view);
  if (early !== null) return abstainOut(pack, early);
  const saleRef = text(rec(view.r2?.body)["saleRef"]);
  const erp = erpSaleTrack(pack, view, saleRef);
  return "cls" in erp ? abstainOut(pack, erp) : answerOut(pack, view, saleRef, erp);
}
