/**
 * RT-648 — gate rules R-G2..R-G5 and consistency rules R-C1..R-C3 of `E1-BL v1`
 * (RT-647 §5.1). The first match ends evaluation with an abstention. R-G1 (an
 * action request) does not end it and is handled by the answer path.
 */
import { ref, rec, str, text, type Abstain, type View } from "./e1.baseline.base";
import type { E1Out } from "./e1.out-schema";
import { matchesHealthQuestion } from "./e1.question";
import type { E1Pack, E1Read } from "./e1.types";

export const SKEW_LIMIT_MS = 30_000;
const DENIED = new Set<unknown>([401, 403, 404]);
const UNREADABLE = new Set<unknown>([400, 429, 500, "timeout"]);

const GAP_IDS = ["S3", "S4", "S6"] as const;
export const GAP_REFS = GAP_IDS.map((id) => `ev:pack#/known_gaps/${id}`);
export const GAP_ENTRIES = GAP_IDS.map((gap) => ({ gap_id: gap, evidence_ref: `ev:pack#/known_gaps/${gap}` }));

export function abstainOut(pack: E1Pack, abstain: Abstain): E1Out {
  const notApplicable = { state: "n/a" as const, rule_id: abstain.rule };
  return {
    schema_version: "e1-out/1",
    pack_id: pack.pack_id,
    class: abstain.cls,
    tracks: {
      processing: notApplicable,
      erp_sale: { ...notApplicable, backlog_class: "n/a" },
      erp_reversal: notApplicable,
    },
    first_failing_boundary: "not_applicable",
    open_unknowns: [],
    runbook_refs: [],
    claims: [{ template_id: abstain.template, params: {}, evidence_refs: [...abstain.refs] }],
    known_gaps: abstain.template === "G5" ? GAP_ENTRIES : [],
  };
}

const readsOf = (view: View): E1Read[] =>
  [view.r1, view.r2, view.r3, ...view.r4].filter((read): read is E1Read => read !== undefined);

const unauthorized = (rule: string): Abstain => ({
  cls: "abstain_unauthorized", rule, template: "G2", refs: ["ev:pack#/scope/actor_role"],
});

function deniedAbstain(view: View): Abstain | null {
  if (DENIED.has(view.r2?.http_status) || DENIED.has(view.r1?.http_status)) return unauthorized("R-G2");
  const readable = view.r1?.http_status === 200;
  return readable && readsOf(view).some((read) => DENIED.has(read.http_status)) ? unauthorized("R-G3") : null;
}

function unreadableAbstain(view: View): Abstain | null {
  const incomplete = [view.r1, view.r2, view.r3].some((read) => read === undefined);
  const failed = readsOf(view).some((read) => UNREADABLE.has(read.http_status));
  return incomplete || failed
    ? { cls: "abstain_missing", rule: "R-G4", template: "G4", refs: ["ev:pack#/assembled_at"] }
    : null;
}

function healthAbstain(pack: E1Pack): Abstain | null {
  return matchesHealthQuestion(pack.question.text)
    ? { cls: "abstain_missing", rule: "R-G5", template: "G5", refs: GAP_REFS }
    : null;
}

/** Gate rules R-G2..R-G5, in order. */
export function gateAbstain(pack: E1Pack, view: View): Abstain | null {
  return deniedAbstain(view) ?? unreadableAbstain(view) ?? healthAbstain(pack);
}

interface Bodies {
  readonly sale: ReturnType<typeof rec>;
  readonly summary: ReturnType<typeof rec>;
  readonly status: ReturnType<typeof rec>;
  readonly timeline: ReturnType<typeof rec>;
}

const bodiesOf = (view: View): Bodies => {
  const sale = rec(view.r1?.body);
  return { sale, summary: rec(sale["summary"]), status: rec(view.r2?.body), timeline: rec(view.r3?.body) };
};

const stale = (rule: string, template: "X1" | "X2", refs: string[]): Abstain => ({
  cls: "abstain_stale", rule, template, refs,
});

/** R-C1: the three reads describe different sales or stores. */
function identityAbstain({ summary, status, timeline }: Bodies): Abstain | null {
  const mismatches = [
    summary["saleRef"] !== status["saleRef"],
    summary["storeRef"] !== status["storeId"],
    timeline["saleRef"] !== status["saleRef"],
  ];
  const statusRef = ref("consoleGetSaleSyncStatus", text(status["saleRef"]), "/saleRef");
  return mismatches.some(Boolean) ? stale("R-C1", "X1", [statusRef]) : null;
}

/** R-C2: the sale changed between reads, or the reads are too far apart. */
function snapshotAbstain(pack: E1Pack, { sale, summary, status }: Bodies): Abstain | null {
  const changed = [
    summary["syncStatus"] !== status["syncStatus"],
    summary["erpPostingState"] !== rec(sale["erpPosting"])["sale"],
    pack.max_read_skew_ms > SKEW_LIMIT_MS,
  ];
  return changed.some(Boolean) ? stale("R-C2", "X2", ["ev:pack#/max_read_skew_ms"]) : null;
}

/** R-C3: a failed status without an open dead letter, or a dead letter without a failed status. */
function deadLetterAbstain({ status }: Bodies): Abstain | null {
  const failed = ["failed-retryable", "failed-needs-repair"].includes(str(status["syncStatus"]) ?? "");
  const hasDeadLetter = status["deadLetter"] !== null && status["deadLetter"] !== undefined;
  const statusRef = ref("consoleGetSaleSyncStatus", text(status["saleRef"]), "/saleRef");
  return failed === hasDeadLetter ? null : stale("R-C3", "X2", [statusRef]);
}

/** Consistency rules R-C1..R-C3: the four reads are not one snapshot (RT-647 F-7). */
export function staleAbstain(pack: E1Pack, view: View): Abstain | null {
  const bodies = bodiesOf(view);
  return identityAbstain(bodies) ?? snapshotAbstain(pack, bodies) ?? deadLetterAbstain(bodies);
}
