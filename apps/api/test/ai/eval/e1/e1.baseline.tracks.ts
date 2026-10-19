/**
 * RT-648 — tracks A (Backend-Core processing), B (ERP sale posting) and C (ERP
 * void reversal) of `E1-BL v1` (RT-647 §5.1). Track A never reports ERP state
 * (trap: `synced` is not ERP posting).
 */
import {
  arr, claim, quietTrack, rec, ref, str, text,
  type Abstain, type Params, type Track, type View,
} from "./e1.baseline.base";
import { REJECTION_VOCABULARY } from "./e1.text";
import type { E1Pack } from "./e1.types";

const STATUS_OP = "consoleGetSaleSyncStatus";
const SALE_OP = "consoleGetSale";
const NO_UNKNOWNS: readonly string[] = [];

interface Ctx {
  readonly view: View;
  readonly saleRef: string;
}

const track = (state: string, rule: string, rest: Partial<Track>): Track => ({ ...quietTrack(state, rule), ...rest });

function syncedTrack({ view, saleRef }: Ctx): Track {
  const status = rec(view.r2?.body);
  const entries = arr(rec(view.r3?.body)["entries"]);
  const repaired = entries.findIndex((entry) => rec(entry)["event"] === "repair.resolved");
  const claims = [claim("A1", { processedAt: str(status["processedAt"]) }, ref(STATUS_OP, saleRef, "/processedAt"))];
  if (repaired >= 0) {
    const resolvedRef = ref("consoleGetSaleAuditTimeline", saleRef, `/entries/${repaired}`);
    claims.push(claim("A1R", { resolvedAt: str(rec(entries[repaired])["at"]) }, resolvedRef));
  }
  return track("synced", "A1", { claims });
}

function capturedTrack({ view, saleRef }: Ctx): Track {
  const received = str(rec(rec(view.r1?.body)["summary"])["receivedAt"]);
  const claims = [claim("A2", { receivedAt: received }, ref(SALE_OP, saleRef, "/summary/receivedAt"))];
  return track("captured", "A2", { claims, runbooks: ["01"] });
}

interface FailedProcessing {
  readonly state: string;
  readonly rule: "A3" | "A4";
  readonly runbook: string;
  readonly extra: Params;
}

/** A failed processing track: the open dead letter's reason, plus what only this class reports. */
function failedProcessingTrack({ view, saleRef }: Ctx, spec: FailedProcessing): Track {
  const dead = rec(rec(view.r2?.body)["deadLetter"]);
  const params: Params = { reasonCode: str(dead["reasonCode"]), quarantinedAt: str(dead["quarantinedAt"]), ...spec.extra };
  const refs = [ref(STATUS_OP, saleRef, "/deadLetter/reasonCode"), ref(STATUS_OP, saleRef, "/deadLetter/quarantinedAt")];
  return track(spec.state, spec.rule, { claims: [claim(spec.rule, params, ...refs)], runbooks: [spec.runbook], failed: true });
}

function retryableTrack(ctx: Ctx): Track {
  const retries = rec(rec(ctx.view.r2?.body)["deadLetter"])["retryCount"];
  const extra: Params = { retryCount: typeof retries === "number" ? retries : null };
  return failedProcessingTrack(ctx, { state: "failed-retryable", rule: "A3", runbook: "02", extra });
}

function repairTrack(ctx: Ctx): Track {
  return failedProcessingTrack(ctx, { state: "failed-needs-repair", rule: "A4", runbook: "03", extra: {} });
}

const PROCESSING: Readonly<Record<string, (ctx: Ctx) => Track>> = {
  synced: syncedTrack,
  captured: capturedTrack,
  "failed-retryable": retryableTrack,
  "failed-needs-repair": repairTrack,
};

export function processingTrack(view: View, saleRef: string): Track {
  const state = text(rec(view.r2?.body)["syncStatus"]);
  return (PROCESSING[state] ?? repairTrack)({ view, saleRef });
}

const RUNBOOK_BY_CLASS: Readonly<Record<string, string>> = {
  unmapped_item: "05", unmapped_store: "05", unmapped_account: "05",
  validation: "06", closed_period: "07", retry_budget_exhausted: "08",
  reconciliation_required: "09", other: "10",
};

/** The matched dead-letter item of the backlog walk. */
function backlogItem(pack: E1Pack, view: View): ReturnType<typeof rec> | null {
  const wanted = pack.backlog_match.posting_status_id;
  const items = view.r4.flatMap((read) => arr(rec(read.body)["items"])).map(rec);
  return items.find((item) => item["postingStatusId"] === wanted) ?? null;
}

function rejectedTrack(template: "B3" | "B4" | "B5", params: Params, klass: string, refs: string[], runbook: string): Track {
  return track("failed", template, {
    claims: [claim(template, params, ...refs)],
    runbooks: [runbook],
    failed: true,
    unknowns: template === "B3" ? NO_UNKNOWNS : ["rejection_class"],
    backlogClass: klass,
  });
}

const GAP_AT_LIMIT: Abstain = { cls: "abstain_stale", rule: "B6", template: "X1", refs: ["ev:pack#/backlog_match/status"] };
const MISSING_ITEM: Abstain = { cls: "abstain_missing", rule: "R-G4", template: "G4", refs: ["ev:pack#/assembled_at"] };

function matchedTrack(item: ReturnType<typeof rec>): Track {
  const id = text(item["postingStatusId"]);
  const klass = str(item["rejectionClass"]);
  const classRef = ref("consoleListPostingBacklog", id, "/rejectionClass");
  if (klass === null || !REJECTION_VOCABULARY.has(klass)) return rejectedTrack("B4", {}, "unrecognised", [classRef], "10");
  const params: Params = { rejectionClass: klass, deadLetteredAt: str(item["deadLetteredAt"]) };
  const refs = [classRef, ref("consoleListPostingBacklog", id, "/deadLetteredAt")];
  return rejectedTrack("B3", params, klass, refs, RUNBOOK_BY_CLASS[klass] ?? "10");
}

function failedSaleTrack(pack: E1Pack, view: View): Track | Abstain {
  const status = pack.backlog_match.status;
  if (status === "not_determined_walk_capped") {
    return rejectedTrack("B5", {}, "not_determined", ["ev:pack#/backlog_match/status"], "10");
  }
  if (status === "no_match_walk_complete") return GAP_AT_LIMIT;
  const item = status === "matched" ? backlogItem(pack, view) : null;
  return item === null ? MISSING_ITEM : matchedTrack(item);
}

function postedTrack(saleRef: string, posting: ReturnType<typeof rec>): Track {
  const claims = [claim("B1", { saleDocumentRef: str(posting["saleDocumentRef"]) }, ref(SALE_OP, saleRef, "/erpPosting/saleDocumentRef"))];
  return track("posted", "B1", { claims, runbooks: ["00"] });
}

function stateOnlyTrack(state: string, rule: "B2" | "B7", saleRef: string, runbook: string, unknowns: string[]): Track {
  const claims = [claim(rule, {}, ref(SALE_OP, saleRef, "/erpPosting/sale"))];
  return track(state, rule, { claims, runbooks: [runbook], unknowns });
}

export function erpSaleTrack(pack: E1Pack, view: View, saleRef: string): Track | Abstain {
  const posting = rec(rec(view.r1?.body)["erpPosting"]);
  const state = text(posting["sale"]);
  if (state === "posted") return postedTrack(saleRef, posting);
  if (state === "pending") return stateOnlyTrack("pending", "B2", saleRef, "04", []);
  if (state === "failed") return failedSaleTrack(pack, view);
  return stateOnlyTrack("unknown", "B7", saleRef, "11", ["erp_sale_state"]);
}

interface ReversalRule {
  readonly rule: "C1" | "C2" | "C3" | "C4";
  readonly runbooks: readonly string[];
  readonly unknowns: readonly string[];
  readonly failed: boolean;
}

const REVERSAL: Readonly<Record<string, ReversalRule>> = {
  posted: { rule: "C1", runbooks: [], unknowns: [], failed: false },
  pending: { rule: "C2", runbooks: ["12"], unknowns: [], failed: false },
  failed: { rule: "C3", runbooks: ["12"], unknowns: ["reversal_class"], failed: true },
  unknown: { rule: "C4", runbooks: ["12"], unknowns: ["erp_reversal_state"], failed: false },
};

export function reversalTrack(view: View, saleRef: string): Track {
  const sale = rec(view.r1?.body);
  if (rec(sale["summary"])["voided"] !== true) return quietTrack("not_voided", "C0");
  const posting = rec(sale["erpPosting"]);
  const reported = str(posting["reversal"]) ?? "unknown";
  const rule = REVERSAL[reported] ?? REVERSAL["unknown"] as ReversalRule;
  const posted = rule.rule === "C1";
  const params: Params = posted ? { reversalDocumentRef: str(posting["reversalDocumentRef"]) } : {};
  const pointer = posted ? "/erpPosting/reversalDocumentRef" : "/erpPosting/reversal";
  return track(rule.rule === "C4" ? "unknown" : reported, rule.rule, {
    claims: [claim(rule.rule, params, ref(SALE_OP, saleRef, pointer))],
    runbooks: rule.runbooks,
    unknowns: rule.unknowns,
    failed: rule.failed,
  });
}
