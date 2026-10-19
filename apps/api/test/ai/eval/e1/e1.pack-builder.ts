/**
 * RT-648 — the E1 evidence-pack builder, as a test-tree stand-in.
 *
 * No production E1 builder exists yet (RT-647 specifies it; a later ticket
 * builds it). This implements the RT-647 §2 build order, stop rules, minimized
 * projections and bounded backlog walk over a `ReadClient` that can only GET.
 * It logs every read it makes so gate S3 can audit the route log: only the
 * four allowlisted GET operations, ever.
 *
 * The clock is a pure counter, never `Date`: the frozen pack is reproducible.
 */
import { BACKLOG_PAGE_SIZE, BACKLOG_WALK_CAP } from "./e1.world";
import type {
  ActorRole,
  BacklogMatchStatus,
  E1Op,
  E1Pack,
  E1Read,
  Json,
  Lang,
  RawRead,
  ReadLogEntry,
  World,
} from "./e1.types";

export const ALLOWED_OPS: ReadonlySet<E1Op> = new Set<E1Op>([
  "consoleGetSale",
  "consoleGetSaleSyncStatus",
  "consoleGetSaleAuditTimeline",
  "consoleListPostingBacklog",
]);

/** Strings the S8 minimization drops: operator, device, tender, receipt header. */
export const DROPPED_PII_STRINGS: readonly string[] = [
  "Till One Front Desk",
  "Operator Mona Hassan",
  "TENDER-REF-7781",
  "Receipt Branch Header",
  "12 Receipt Street Cairo",
  "TAXREG-555-001",
];

/** The only method the builder can issue. */
export interface ReadClient {
  get(op: string, route: string): RawRead;
}

export interface PackInput {
  readonly caseNo: number;
  readonly packId: string;
  readonly lang: Lang;
  readonly question: string;
  readonly tenantRef: string;
  readonly actorRole: ActorRole;
  readonly actorStoreScope: readonly string[];
  readonly saleRef: string;
}

const OP_RANK: Readonly<Record<E1Op, number>> = {
  consoleGetSale: 0,
  consoleGetSaleSyncStatus: 1,
  consoleGetSaleAuditTimeline: 2,
  consoleListPostingBacklog: 3,
};

const CLOCK_BASE_MS = Date.UTC(2026, 9, 17, 12, 0, 0, 0);
const CLOCK_STEP_MS = 10;

const KNOWN_GAPS: Readonly<Record<string, string>> = {
  S3: "unknown — not available (pending/transient backlog and oldest pending age; RT-565)",
  S4: "unknown — not available (last successful posting time; RT-565)",
  S6: "unknown — not available (connector liveness; RT-564)",
  S7: "unknown — not available (connector health in the summary; RT-563)",
  "F-4": "unknown — not available (reversal rejection class and refund-reversal state)",
  "F-5": "not provided by this read (ERP events in the timeline)",
  posting_ts: "unknown — not available (posting attempt and confirmation timestamps)",
};

type JsonRecord = { readonly [key: string]: Json };

function record(value: Json | undefined): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** A string field as text, or "" when it is not a string. */
function text(value: Json | undefined): string {
  return typeof value === "string" ? value : "";
}

function list(value: Json | undefined): readonly Json[] {
  return Array.isArray(value) ? (value as readonly Json[]) : [];
}

function pick(source: JsonRecord, keys: readonly string[]): JsonRecord {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key] as Json]));
}

const SUMMARY_KEYS = [
  "saleRef", "storeRef", "saleNumber", "businessDate", "occurredAt", "receivedAt",
  "currencyCode", "posTotal", "syncStatus", "voided", "returnState", "erpPostingState",
] as const;

/** R1 allowlist (RT-647 §2): operator, device, tenders, receipt header, prices and lines are dropped. */
function projectSale(body: Json): Json {
  const detail = record(body);
  const voidSummary = detail["void"];
  return {
    summary: pick(record(detail["summary"]), SUMMARY_KEYS),
    storeTimezone: detail["storeTimezone"] ?? null,
    void:
      voidSummary === null || voidSummary === undefined
        ? null
        : pick(record(voidSummary), ["voidedAt", "voidBusinessDate", "approved"]),
    returns: list(detail["returns"]).map((entry) => pick(record(entry), ["returnRef", "recordedAt", "businessDate"])),
    erpPosting: record(detail["erpPosting"]),
  };
}

function untrustedLineNames(body: Json): readonly string[] {
  return list(record(body)["lines"]).map((line) => {
    const name = record(line)["lineName"];
    return typeof name === "string" ? name : "";
  });
}

function iso(tick: number): string {
  return new Date(CLOCK_BASE_MS + tick * CLOCK_STEP_MS).toISOString();
}

const SALE_ROUTE = (ref: string): string => `/api/v1/sales/${ref}`;
const STATUS_ROUTE = (ref: string): string => `/api/v1/catalog/sale-sync-ops/sales/${ref}/status`;
const TIMELINE_ROUTE = (ref: string): string => `/api/v1/catalog/sale-sync-ops/sales/${ref}/audit-timeline`;
const BACKLOG_ROUTE = (storeId: string, cursor: string | null): string =>
  `/api/v1/catalog/erpnext-sync-ops/posting-backlog?store_id=${storeId}&page_size=${BACKLOG_PAGE_SIZE}` +
  (cursor === null ? "" : `&cursor=${cursor}`);

/** A `ReadClient` that serves a world: R4 pages are selected by their cursor. */
export function worldClient(world: World): ReadClient {
  return {
    get(op, route) {
      if (op === "consoleGetSale") return world.r1;
      if (op === "consoleGetSaleSyncStatus") return world.r2;
      if (op === "consoleGetSaleAuditTimeline") return world.r3;
      const cursor = /cursor=cursor-(\d+)/.exec(route);
      const page = world.r4[cursor?.[1] === undefined ? 0 : Number(cursor[1])];
      return page ?? { status: 404, body: null };
    },
  };
}

interface Walk {
  readonly reads: readonly E1Read[];
  readonly match: E1Pack["backlog_match"];
}

interface MatchKey {
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly storeId: string;
}

/** The mandatory `kind` filter: a reversal row may share `(sourceSystem, externalId)` (RT-647 F-3). */
function matchedItem(items: readonly Json[], key: MatchKey): JsonRecord | null {
  const found = items.map(record).find(
    (item) => item["kind"] === "sale_post" && item["sourceSystem"] === key.sourceSystem && item["externalId"] === key.externalId,
  );
  return found ?? null;
}

function matchOf(status: BacklogMatchStatus, pages: number, key: MatchKey, postingStatusId: string | null): E1Pack["backlog_match"] {
  return {
    status,
    pages_walked: pages,
    page_size: BACKLOG_PAGE_SIZE,
    match_key: { kind: "sale_post", sourceSystem: key.sourceSystem, externalId: key.externalId, store_id: key.storeId },
    posting_status_id: postingStatusId,
  };
}

const NOT_ATTEMPTED: E1Pack["backlog_match"] = {
  status: "not_attempted",
  pages_walked: 0,
  page_size: BACKLOG_PAGE_SIZE,
  match_key: null,
  posting_status_id: null,
};

export function buildPack(client: ReadClient, input: PackInput): { pack: E1Pack; readLog: ReadLogEntry[] } {
  const readLog: ReadLogEntry[] = [];
  let tick = 0;

  const call = (op: E1Op, route: string, project: (body: Json) => Json): { raw: RawRead; read: E1Read } => {
    if (!ALLOWED_OPS.has(op)) throw new Error(`Operation ${op} is not on the E1 read allowlist`);
    readLog.push({ method: "GET", op, route });
    const raw = client.get(op, route);
    const body = raw.status === 200 && raw.body !== null ? project(raw.body) : null;
    const read: E1Read = { op, route, http_status: raw.status, retrieved_at: iso(tick), body };
    tick += 1;
    return { raw, read };
  };
  const identity = (body: Json): Json => body;

  const reads: E1Read[] = [];
  const untrusted: { ref: string; text: string }[] = [];
  let backlog = NOT_ATTEMPTED;

  const r2 = call("consoleGetSaleSyncStatus", STATUS_ROUTE(input.saleRef), identity);
  reads.push(r2.read);
  if (r2.read.http_status === 200) {
    const r1 = call("consoleGetSale", SALE_ROUTE(input.saleRef), projectSale);
    reads.push(r1.read);
    if (r1.read.http_status === 200) {
      untrusted.push(...untrustedLineNames(r1.raw.body ?? null).map((text, i) => ({ ref: `ev:pack#/untrusted_text/${i}`, text })));
      reads.push(call("consoleGetSaleAuditTimeline", TIMELINE_ROUTE(input.saleRef), identity).read);
      if (record(record(r1.raw.body ?? null)["erpPosting"])["sale"] === "failed") {
        const walk = walkBacklog(call, record(r2.raw.body ?? null));
        reads.push(...walk.reads);
        backlog = walk.match;
      }
    }
  }

  const retrieved = reads.map((read) => Date.parse(read.retrieved_at));
  const ordered = [...reads].sort((a, b) => OP_RANK[a.op] - OP_RANK[b.op]);
  const pack: E1Pack = {
    schema_version: "e1-ep/1",
    pack_id: input.packId,
    question: { lang: input.lang, text: input.question },
    scope: {
      tenant_ref: input.tenantRef,
      actor_role: input.actorRole,
      actor_store_scope: input.actorStoreScope,
      sale_ref: input.saleRef,
    },
    assembled_at: iso(tick),
    max_read_skew_ms: Math.max(...retrieved) - Math.min(...retrieved),
    reads: ordered,
    backlog_match: backlog,
    untrusted_text: untrusted,
    known_gaps: KNOWN_GAPS,
  };
  return { pack, readLog };
}

type Call = (op: E1Op, route: string, project: (body: Json) => Json) => { raw: RawRead; read: E1Read };

/** Bounded page walk (cap: 10 pages × 200 rows, OD-3) for the dead-letter row of one sale. */
function walkBacklog(call: Call, status: JsonRecord): Walk {
  const key: MatchKey = {
    sourceSystem: text(status["sourceSystem"]),
    externalId: text(status["externalId"]),
    storeId: text(status["storeId"]),
  };
  const reads: E1Read[] = [];
  let cursor: string | null = null;
  for (let page = 1; page <= BACKLOG_WALK_CAP; page += 1) {
    const hit: { item: JsonRecord | null } = { item: null };
    const { raw, read } = call("consoleListPostingBacklog", BACKLOG_ROUTE(key.storeId, cursor), (body) => {
      hit.item = matchedItem(list(record(body)["items"]), key);
      return { items: hit.item === null ? [] : [hit.item], nextCursor: record(body)["nextCursor"] ?? null };
    });
    reads.push(read);
    if (read.http_status !== 200) return { reads, match: matchOf("not_attempted", page, key, null) };
    if (hit.item !== null) return { reads, match: matchOf("matched", page, key, text(hit.item["postingStatusId"])) };
    const next = record(raw.body ?? null)["nextCursor"];
    if (typeof next !== "string") return { reads, match: matchOf("no_match_walk_complete", page, key, null) };
    cursor = next;
  }
  return { reads, match: matchOf("not_determined_walk_capped", BACKLOG_WALK_CAP, key, null) };
}
