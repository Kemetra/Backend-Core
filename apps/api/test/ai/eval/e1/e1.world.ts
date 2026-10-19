/**
 * RT-648 — the synthetic "world" a scenario describes: contract-conformant
 * bodies for the four E1 reads (RT-647 §1.1). The dataset spec validates each
 * body against the real OpenAPI schemas, so a fixture cannot drift from the
 * contract. Everything is a pure function of the `Scenario`.
 */
import {
  deviceRefOf,
  lineRefOf,
  postingStatusIdOf,
  returnRefOf,
  saleRefOf,
  STORE_TIMEZONE,
  storeId,
  TENANT_B_SALE_REF,
  USER_A,
} from "./e1.ids";
import type { Json, RawRead, Scenario, World } from "./e1.types";

export const SOURCE_SYSTEM = "pos-core";
export const BACKLOG_PAGE_SIZE = 200;
export const BACKLOG_WALK_CAP = 10;

const T_OCCURRED = "2026-10-17T08:59:00.000Z";
const T_RECEIVED = "2026-10-17T09:00:05.000Z";
const T_PROCESSED = "2026-10-17T09:00:30.000Z";
const T_QUARANTINED = "2026-10-17T09:01:00.000Z";
const T_DEAD_LETTERED = "2026-10-17T09:05:00.000Z";
const T_VOIDED = "2026-10-17T10:00:00.000Z";
const T_REPAIRED = "2026-10-17T09:30:00.000Z";

const ok = (body: Json): RawRead => ({ status: 200, body });

function statusOf(s: Scenario, key: "r1" | "r2" | "r3" | "r4"): RawRead | null {
  const status = s.status?.[key];
  return status === undefined || status === 200 ? null : { status, body: null };
}

export function externalIdOf(n: number): string {
  return `ext-${n}`;
}

function summaryOf(s: Scenario): Json {
  const store = s.store ?? "A1";
  return {
    saleRef: saleRefOf(s.n),
    storeRef: s.summaryStoreRef ?? storeId(store),
    saleNumber: `S-${s.n}`,
    businessDate: s.businessDate ?? "2026-10-17",
    occurredAt: s.occurredAt ?? T_OCCURRED,
    receivedAt: T_RECEIVED,
    device: { deviceRef: deviceRefOf(s.n), label: "Till One Front Desk", labelSource: "snapshot" },
    operator: { userRef: USER_A, displayName: "Operator Mona Hassan", nameSource: "snapshot" },
    currencyCode: "EGP",
    posTotal: "120.0000",
    syncStatus: s.summarySyncStatus ?? s.sync,
    voided: s.voided === true,
    returnState: s.returns === true ? "partial" : "none",
    erpPostingState: s.erp,
  };
}

function returnsOf(s: Scenario): Json[] {
  if (s.returns !== true) return [];
  return [
    {
      returnRef: returnRefOf(s.n),
      recordedAt: "2026-10-17T11:00:00.000Z",
      businessDate: "2026-10-17",
      returnTotal: "10.0000",
      lines: [{ lineRef: lineRefOf(s.n), quantity: "1", lineAmount: "10.0000" }],
    },
  ];
}

function erpPostingOf(s: Scenario): Json {
  const reversal = s.voided === true ? (s.reversal ?? "unknown") : null;
  return {
    sale: s.erp,
    saleDocumentRef: s.erp === "posted" ? (s.docRef ?? `SINV-${s.n}`) : null,
    reversal,
    reversalDocumentRef: reversal === "posted" ? `SINV-RET-${s.n}` : null,
  };
}

function saleDetailOf(s: Scenario): Json {
  const store = s.store ?? "A1";
  return {
    summary: summaryOf(s),
    storeTimezone: STORE_TIMEZONE[store],
    lines: [
      {
        lineRef: lineRefOf(s.n),
        sequence: 1,
        lineName: s.lineName ?? "Milk 1L",
        unitPrice: "120.0000",
        currencyCode: "EGP",
        quantity: "1",
        lineAmount: "120.0000",
        taxAmount: null,
        unit: "pc",
        returnedQuantity: s.returns === true ? "1" : "0",
      },
    ],
    lineOrder: "recorded",
    tenderState: "recorded",
    tenders: [{ method: "cash", amount: "120.0000", reference: "TENDER-REF-7781", sequence: 1 }],
    changeGiven: "0",
    settledAt: null,
    receiptNumber: `S-${s.n}`,
    receiptHeader: {
      branchName: "Receipt Branch Header",
      branchAddress: "12 Receipt Street Cairo",
      taxRegistrationId: "TAXREG-555-001",
    },
    void:
      s.voided === true
        ? { voidedAt: T_VOIDED, voidBusinessDate: "2026-10-17", approved: true, approverRole: "owner" }
        : null,
    returns: returnsOf(s),
    erpPosting: erpPostingOf(s),
  };
}

function syncStatusOf(s: Scenario): Json {
  const failed = s.sync === "failed-retryable" || s.sync === "failed-needs-repair";
  return {
    saleRef: saleRefOf(s.n),
    storeId: storeId(s.store ?? "A1"),
    syncStatus: s.sync,
    sourceSystem: SOURCE_SYSTEM,
    externalId: externalIdOf(s.n),
    processedAt: s.sync === "synced" ? T_PROCESSED : null,
    deadLetter: failed
      ? {
          classification: s.sync === "failed-retryable" ? "retryable" : "needs-repair",
          reasonCode: s.reasonCode ?? "db_timeout",
          retryCount: s.retryCount ?? 0,
          quarantinedAt: T_QUARANTINED,
          resolvedAt: null,
        }
      : null,
  };
}

const TIMELINE_EVENT: Readonly<Record<Scenario["sync"], string>> = {
  captured: "sale.captured",
  synced: "sync.synced",
  "failed-retryable": "sync.retryable",
  "failed-needs-repair": "sync.needs_repair",
};

function timelineOf(s: Scenario): Json {
  const entries: Json[] = [{ at: T_RECEIVED, event: "sale.captured" }];
  if (s.sync !== "captured") {
    entries.push({ at: s.sync === "synced" ? T_PROCESSED : T_QUARANTINED, event: TIMELINE_EVENT[s.sync] });
  }
  if (s.repairResolved === true) entries.push({ at: T_REPAIRED, event: "repair.resolved" });
  return { saleRef: saleRefOf(s.n), entries };
}

function backlogRow(
  kind: "sale_post" | "reversal",
  postingStatusId: string,
  externalId: string,
  rejectionClass: string | null,
): Json {
  return {
    postingStatusId,
    kind,
    sourceSystem: SOURCE_SYSTEM,
    externalId,
    status: "permanently_rejected",
    rejectionClass,
    deadLetteredAt: T_DEAD_LETTERED,
  };
}

function fillerRows(page: number): Json[] {
  return Array.from({ length: BACKLOG_PAGE_SIZE }, (_unused, i) =>
    backlogRow("sale_post", postingStatusIdOf(0x80 + ((page * 7 + i) % 0x70)), `filler-${page}-${i}`, "validation"),
  );
}

function backlogPagesOf(s: Scenario): RawRead[] {
  const mode = s.backlog ?? "match";
  const own = (kind: "sale_post" | "reversal", rejection: string | null, idNo: number): Json =>
    backlogRow(kind, postingStatusIdOf(idNo), externalIdOf(s.n), rejection);
  if (mode === "capped") {
    return Array.from({ length: BACKLOG_WALK_CAP }, (_unused, page) =>
      ok({ items: fillerRows(page), nextCursor: `cursor-${page + 1}` }),
    );
  }
  if (mode === "none") return [ok({ items: [backlogRow("sale_post", postingStatusIdOf(0x90), "other-sale", "validation")], nextCursor: null })];
  const items: Json[] = s.collision === true ? [own("reversal", "closed_period", s.n + 0x40)] : [];
  items.push(own("sale_post", s.backlogClass === undefined ? "validation" : s.backlogClass, s.n));
  return [ok({ items, nextCursor: null })];
}

/** Bodies for a scenario. A non-200 override replaces a body with `null`. */
export function buildWorld(s: Scenario): World {
  const unreachable = { status: 404, body: null } as const;
  return {
    r1: statusOf(s, "r1") ?? ok(saleDetailOf(s)),
    r2: statusOf(s, "r2") ?? ok(syncStatusOf(s)),
    r3: statusOf(s, "r3") ?? ok(timelineOf(s)),
    r4: statusOf(s, "r4") !== null ? [statusOf(s, "r4") ?? unreachable] : s.erp === "failed" ? backlogPagesOf(s) : [],
  };
}

/** The path value of a cross-tenant probe: a sale ref that belongs to tenant B. */
export function probeSaleRef(s: Scenario): string {
  return s.crossTenant === true ? TENANT_B_SALE_REF : saleRefOf(s.n);
}

