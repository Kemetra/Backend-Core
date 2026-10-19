/**
 * RT-648 — the deterministic rule-table baseline `E1-BL v1` (RT-647 §5).
 *
 * A pure function `explain(pack) → E1-OUT`: no I/O, no clock, no randomness.
 * Rules run in the RT-647 order: gate rules (G), consistency rules (R-C), then
 * tracks A (Backend-Core processing), B (ERP sale posting) and C (ERP void
 * reversal). The D0 semantic traps are encoded: no dead letter is not "posted",
 * `synced` is not ERP posting, `unknown` is not "not posted", and nothing is
 * ever "healthy".
 *
 * Interpretations made while implementing (also listed in the PR body):
 *  - 429 (added to the four reads by RT-620 after the RT-647 baseline) is a read
 *    failure, handled by R-G4;
 *  - RB-E1-00 ("none required") is suppressed when another runbook applies,
 *    which reconciles RT-647 §6.2 C22/C23 with rule B1;
 *  - template ids X1/X2 name the two consistency messages (R-C1..R-C3, B6),
 *    and H0 is the header line that quotes `businessDate` verbatim.
 */
import { isDisplayable, matchesActionRequest, matchesHealthQuestion, REJECTION_VOCABULARY } from "./e1.text";
import type { E1Claim, E1Out, ParamName } from "./e1.out-schema";
import type { E1Boundary, E1Class, E1Op, E1Pack, E1Read, Json } from "./e1.types";

const SKEW_LIMIT_MS = 30_000;
const DENIED = new Set<unknown>([401, 403, 404]);
const UNREADABLE = new Set<unknown>([400, 429, 500, "timeout"]);

type Rec = { readonly [key: string]: Json };
type Params = E1Claim["params"];

function rec(value: Json | null | undefined): Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : {};
}
const str = (value: Json | undefined): string | null => (typeof value === "string" ? value : null);
const arr = (value: Json | undefined): readonly Json[] => (Array.isArray(value) ? (value as readonly Json[]) : []);

interface View {
  readonly r1: E1Read | undefined;
  readonly r2: E1Read | undefined;
  readonly r3: E1Read | undefined;
  readonly r4: readonly E1Read[];
}

function viewOf(pack: E1Pack): View {
  const only = (op: E1Op): E1Read | undefined => pack.reads.find((read) => read.op === op);
  return {
    r1: only("consoleGetSale"),
    r2: only("consoleGetSaleSyncStatus"),
    r3: only("consoleGetSaleAuditTimeline"),
    r4: pack.reads.filter((read) => read.op === "consoleListPostingBacklog"),
  };
}

const ref = (op: E1Op, id: string, pointer: string): string => `ev:${op}/${id}#${pointer}`;

interface Abstain {
  readonly cls: E1Class;
  readonly rule: string;
  readonly template: "G2" | "G4" | "G5" | "X1" | "X2";
  readonly refs: readonly string[];
}

const GAP_REFS = ["S3", "S4", "S6"].map((id) => `ev:pack#/known_gaps/${id}`);
const GAP_ENTRIES = ["S3", "S4", "S6"].map((gap) => ({ gap_id: gap as "S3" | "S4" | "S6", evidence_ref: `ev:pack#/known_gaps/${gap}` }));

function abstainOut(pack: E1Pack, abstain: Abstain): E1Out {
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

/** Gate rules R-G2..R-G5 (R-G1 is handled by the answer path). */
function gateAbstain(pack: E1Pack, view: View): Abstain | null {
  const reads = [view.r1, view.r2, view.r3, ...view.r4].filter((read): read is E1Read => read !== undefined);
  const scopeRef = ["ev:pack#/scope/actor_role"];
  if (DENIED.has(view.r2?.http_status) || DENIED.has(view.r1?.http_status)) {
    return { cls: "abstain_unauthorized", rule: "R-G2", template: "G2", refs: scopeRef };
  }
  if (view.r1?.http_status === 200 && reads.some((read) => DENIED.has(read.http_status))) {
    return { cls: "abstain_unauthorized", rule: "R-G3", template: "G2", refs: scopeRef };
  }
  const incomplete = view.r1 === undefined || view.r2 === undefined || view.r3 === undefined;
  if (incomplete || reads.some((read) => UNREADABLE.has(read.http_status))) {
    return { cls: "abstain_missing", rule: "R-G4", template: "G4", refs: ["ev:pack#/assembled_at"] };
  }
  if (matchesHealthQuestion(pack.question.text)) {
    return { cls: "abstain_missing", rule: "R-G5", template: "G5", refs: GAP_REFS };
  }
  return null;
}

/** Consistency rules R-C1..R-C3: the four reads are not one snapshot (RT-647 F-7). */
function staleAbstain(pack: E1Pack, view: View): Abstain | null {
  const sale = rec(view.r1?.body);
  const summary = rec(sale["summary"]);
  const status = rec(view.r2?.body);
  const timeline = rec(view.r3?.body);
  const saleRef = str(status["saleRef"]) ?? "";
  const statusRef = ref("consoleGetSaleSyncStatus", saleRef, "/saleRef");
  if (summary["saleRef"] !== status["saleRef"] || summary["storeRef"] !== status["storeId"] || timeline["saleRef"] !== status["saleRef"]) {
    return { cls: "abstain_stale", rule: "R-C1", template: "X1", refs: [statusRef] };
  }
  const failed = status["syncStatus"] === "failed-retryable" || status["syncStatus"] === "failed-needs-repair";
  const staleSnapshot =
    summary["syncStatus"] !== status["syncStatus"] ||
    summary["erpPostingState"] !== rec(sale["erpPosting"])["sale"] ||
    pack.max_read_skew_ms > SKEW_LIMIT_MS;
  if (staleSnapshot) return { cls: "abstain_stale", rule: "R-C2", template: "X2", refs: ["ev:pack#/max_read_skew_ms"] };
  const hasDeadLetter = status["deadLetter"] !== null && status["deadLetter"] !== undefined;
  if (failed !== hasDeadLetter) return { cls: "abstain_stale", rule: "R-C3", template: "X2", refs: [statusRef] };
  return null;
}

interface Track {
  readonly state: string;
  readonly rule: string;
  readonly claims: readonly E1Claim[];
  readonly runbooks: readonly string[];
  readonly failed: boolean;
  readonly unknowns: readonly string[];
  readonly backlogClass: string;
}

/** A value that fails its interpolation guard is dropped here, so a hostile string never enters the output. */
function sanitized(params: Params): Params {
  const entries = Object.entries(params).map(([name, value]): [string, string | number | null] => [
    name,
    value === null || value === undefined || isDisplayable(name as ParamName, value) ? (value ?? null) : null,
  ]);
  return Object.fromEntries(entries) as Params;
}

function claim(template_id: E1Claim["template_id"], params: Params, ...refs: string[]): E1Claim {
  return { template_id, params: sanitized(params), evidence_refs: refs };
}

const RUNBOOK_BY_CLASS: Readonly<Record<string, string>> = {
  unmapped_item: "05", unmapped_store: "05", unmapped_account: "05",
  validation: "06", closed_period: "07", retry_budget_exhausted: "08",
  reconciliation_required: "09", other: "10",
};

function processingTrack(view: View, saleRef: string): Track {
  const status = rec(view.r2?.body);
  const summary = rec(rec(view.r1?.body)["summary"]);
  const dead = rec(status["deadLetter"]);
  const op = "consoleGetSaleSyncStatus";
  const state = String(status["syncStatus"]);
  const base = { state, backlogClass: "n/a", unknowns: [] as string[] };
  const reasonRef = ref(op, saleRef, "/deadLetter/reasonCode");
  if (state === "synced") {
    const entries = arr(rec(view.r3?.body)["entries"]);
    const at = entries.findIndex((entry) => rec(entry)["event"] === "repair.resolved");
    const claims = [claim("A1", { processedAt: str(status["processedAt"]) }, ref(op, saleRef, "/processedAt"))];
    if (at >= 0) {
      claims.push(claim("A1R", { resolvedAt: str(rec(entries[at])["at"]) }, ref("consoleGetSaleAuditTimeline", saleRef, `/entries/${at}`)));
    }
    return { ...base, rule: "A1", claims, runbooks: [], failed: false };
  }
  if (state === "captured") {
    const claims = [claim("A2", { receivedAt: str(summary["receivedAt"]) }, ref("consoleGetSale", saleRef, "/summary/receivedAt"))];
    return { ...base, rule: "A2", claims, runbooks: ["01"], failed: false };
  }
  const reasonCode = str(dead["reasonCode"]);
  const quarantinedAt = str(dead["quarantinedAt"]);
  const quarantineRef = ref(op, saleRef, "/deadLetter/quarantinedAt");
  if (state === "failed-retryable") {
    const params: Params = { reasonCode, retryCount: typeof dead["retryCount"] === "number" ? dead["retryCount"] : null, quarantinedAt };
    return { ...base, rule: "A3", claims: [claim("A3", params, reasonRef, quarantineRef)], runbooks: ["02"], failed: true };
  }
  return { ...base, rule: "A4", claims: [claim("A4", { reasonCode, quarantinedAt }, reasonRef, quarantineRef)], runbooks: ["03"], failed: true };
}

/** The matched dead-letter item of the backlog walk, with its id. */
function backlogItem(pack: E1Pack, view: View): Rec | null {
  const wanted = pack.backlog_match.posting_status_id;
  const items = view.r4.flatMap((read) => arr(rec(read.body)["items"])).map(rec);
  return items.find((item) => item["postingStatusId"] === wanted) ?? null;
}

type ErpOutcome = Track | Abstain;

function failedSaleTrack(pack: E1Pack, view: View): ErpOutcome {
  const match = pack.backlog_match;
  const wrapped = (template: "B3" | "B4" | "B5", params: Params, klass: string, refs: string[], runbook: string): Track => ({
    state: "failed", rule: template, claims: [claim(template, params, ...refs)], runbooks: [runbook],
    failed: true, unknowns: template === "B3" ? [] : ["rejection_class"], backlogClass: klass,
  });
  if (match.status === "not_determined_walk_capped") {
    return wrapped("B5", {}, "not_determined", ["ev:pack#/backlog_match/status"], "10");
  }
  if (match.status === "no_match_walk_complete") {
    return { cls: "abstain_stale", rule: "B6", template: "X1", refs: ["ev:pack#/backlog_match/status"] };
  }
  const item = match.status === "matched" ? backlogItem(pack, view) : null;
  if (item === null) return { cls: "abstain_missing", rule: "R-G4", template: "G4", refs: ["ev:pack#/assembled_at"] };
  const klass = str(item["rejectionClass"]);
  const itemRef = ref("consoleListPostingBacklog", String(item["postingStatusId"]), "/rejectionClass");
  if (klass === null || !REJECTION_VOCABULARY.has(klass)) {
    return wrapped("B4", {}, "unrecognised", [itemRef], "10");
  }
  const deadRef = ref("consoleListPostingBacklog", String(item["postingStatusId"]), "/deadLetteredAt");
  const params: Params = { rejectionClass: klass, deadLetteredAt: str(item["deadLetteredAt"]) };
  return wrapped("B3", params, klass, [itemRef, deadRef], RUNBOOK_BY_CLASS[klass] ?? "10");
}

function erpSaleTrack(pack: E1Pack, view: View, saleRef: string): ErpOutcome {
  const posting = rec(rec(view.r1?.body)["erpPosting"]);
  const state = String(posting["sale"]);
  const at = (pointer: string): string => ref("consoleGetSale", saleRef, pointer);
  const simple = (rule: string, template: "B1" | "B2" | "B7", params: Params, refs: string[], runbook: string, unknowns: string[]): Track => ({
    state, rule, claims: [claim(template, params, ...refs)], runbooks: [runbook], failed: false, unknowns, backlogClass: "n/a",
  });
  if (state === "posted") {
    return simple("B1", "B1", { saleDocumentRef: str(posting["saleDocumentRef"]) }, [at("/erpPosting/saleDocumentRef")], "00", []);
  }
  if (state === "pending") return simple("B2", "B2", {}, [at("/erpPosting/sale")], "04", []);
  if (state === "failed") return failedSaleTrack(pack, view);
  return simple("B7", "B7", {}, [at("/erpPosting/sale")], "11", ["erp_sale_state"]);
}

const REVERSAL_RULE: Readonly<Record<string, string>> = { posted: "C1", pending: "C2", failed: "C3", unknown: "C4" };

function reversalTrack(view: View, saleRef: string): Track {
  const sale = rec(view.r1?.body);
  const posting = rec(sale["erpPosting"]);
  const at = (pointer: string): string => ref("consoleGetSale", saleRef, pointer);
  const none = { claims: [] as E1Claim[], runbooks: [] as string[], failed: false, unknowns: [] as string[], backlogClass: "n/a" };
  if (rec(sale["summary"])["voided"] !== true) return { ...none, state: "not_voided", rule: "C0" };
  const state = str(posting["reversal"]) ?? "unknown";
  const rule = REVERSAL_RULE[state] ?? "C4";
  const params: Params = state === "posted" ? { reversalDocumentRef: str(posting["reversalDocumentRef"]) } : {};
  const pointer = state === "posted" ? "/erpPosting/reversalDocumentRef" : "/erpPosting/reversal";
  return {
    state: rule === "C4" ? "unknown" : state, rule,
    claims: [claim(rule as "C1" | "C2" | "C3" | "C4", params, at(pointer))],
    runbooks: rule === "C1" ? [] : ["12"],
    failed: rule === "C3",
    unknowns: rule === "C4" ? ["erp_reversal_state"] : rule === "C3" ? ["reversal_class"] : [],
    backlogClass: "n/a",
  };
}

function boundaryOf(tracks: readonly [Track, Track, Track], unknowns: readonly string[]): E1Boundary {
  const order: readonly E1Boundary[] = ["bc_sale_processing", "erp_sale_posting", "erp_reversal_posting"];
  const failed = tracks.findIndex((track) => track.failed);
  if (failed >= 0) return order[failed] ?? "undetermined";
  return unknowns.length > 0 ? "undetermined" : "none_failed";
}

/** RB-E1-00 means "none required": it is dropped when any other runbook applies. */
function runbooksOf(tracks: readonly Track[]): string[] {
  const codes = [...new Set(tracks.flatMap((track) => track.runbooks))].sort();
  const others = codes.filter((code) => code !== "00");
  return (others.length > 0 ? others : codes).map((code) => `RB-E1-${code}`);
}

function headerClaim(view: View, saleRef: string): E1Claim {
  const summary = rec(rec(view.r1?.body)["summary"]);
  const field = (name: string): string | null => str(summary[name]);
  const at = (name: string): string => ref("consoleGetSale", saleRef, `/summary/${name}`);
  const params: Params = {
    saleNumber: field("saleNumber"), businessDate: field("businessDate"), occurredAt: field("occurredAt"),
    currencyCode: field("currencyCode"), posTotal: field("posTotal"),
  };
  return claim("H0", params, at("businessDate"), at("occurredAt"), at("posTotal"));
}

const isAbstain = (outcome: ErpOutcome): outcome is Abstain => "cls" in outcome;

export function explain(pack: E1Pack): E1Out {
  const view = viewOf(pack);
  const early = gateAbstain(pack, view) ?? staleAbstain(pack, view);
  if (early !== null) return abstainOut(pack, early);

  const saleRef = str(rec(view.r2?.body)["saleRef"]) ?? "";
  const erp = erpSaleTrack(pack, view, saleRef);
  if (isAbstain(erp)) return abstainOut(pack, erp);
  const processing = processingTrack(view, saleRef);
  const reversal = reversalTrack(view, saleRef);

  const returns = arr(rec(view.r1?.body)["returns"]);
  const returnsClaim = returns.length > 0 ? [claim("C5", { n: returns.length }, ref("consoleGetSale", saleRef, "/returns"))] : [];
  const unknowns = [
    ...erp.unknowns, ...reversal.unknowns, ...(returns.length > 0 ? ["refund_reversal_state"] : []),
  ];
  const ordered = ["erp_sale_state", "rejection_class", "erp_reversal_state", "reversal_class", "refund_reversal_state"] as const;
  const action = matchesActionRequest(pack.question.text);
  const refusal = action ? [claim("G1", {}, "ev:pack#/question/lang")] : [];

  return {
    schema_version: "e1-out/1",
    pack_id: pack.pack_id,
    class: action ? "refuse_unsafe" : "answer",
    tracks: {
      processing: { state: processing.state as E1Out["tracks"]["processing"]["state"], rule_id: processing.rule },
      erp_sale: { state: erp.state as E1Out["tracks"]["erp_sale"]["state"], rule_id: erp.rule, backlog_class: erp.backlogClass },
      erp_reversal: { state: reversal.state as E1Out["tracks"]["erp_reversal"]["state"], rule_id: reversal.rule },
    },
    first_failing_boundary: boundaryOf([processing, erp, reversal], unknowns),
    open_unknowns: ordered.filter((name) => unknowns.includes(name)),
    runbook_refs: runbooksOf([processing, erp, reversal]),
    claims: [...refusal, headerClaim(view, saleRef), ...processing.claims, ...erp.claims, ...reversal.claims, ...returnsClaim],
    known_gaps: GAP_ENTRIES,
  };
}
