/**
 * RT-539 — the shared types of the POS sale history service and its reprint
 * record (`pos-sales/sale-history.yaml` 1.0.0-draft).
 */
import type { ReprintMark, SaleHistoryItem } from "./sale-history.projections";
import type { SaleHistoryFilters, SaleReprintRequestDto } from "./sale-history.query";

/** Who is asking: the envelope's whole store, or one admitted cashier's own sales. */
export type SaleHistoryVisibility =
  | { readonly kind: "store" }
  | { readonly kind: "own_sales"; readonly userId: string };

export interface SaleHistoryScope {
  readonly tenantId: string;
  readonly storeId: string;
  readonly visibility: SaleHistoryVisibility;
}

export interface ListSaleHistoryInput extends SaleHistoryScope {
  readonly filters: SaleHistoryFilters;
  readonly cursor: string | null;
  readonly pageSize: number;
}

export interface SaleHistoryPage {
  readonly items: ReadonlyArray<SaleHistoryItem>;
  readonly nextCursor: string | null;
  readonly asOf: string;
  readonly storeTimezone: string;
  readonly visibility: SaleHistoryVisibility["kind"];
  readonly from: string;
  readonly to: string;
}

export interface RecordReprintInput extends SaleHistoryScope {
  readonly saleRef: string;
  /** The envelope user or the admitted cashier. */
  readonly actorUserId: string;
  /** The calling terminal (the guard's resolved device). */
  readonly deviceId: string;
  readonly idempotencyKey: string;
  readonly requestId: string | null;
  readonly body: SaleReprintRequestDto;
}

export interface SaleReprintProjection {
  readonly reprintRef: string;
  readonly saleRef: string;
  readonly mode: "authorize" | "record";
  readonly kind: "duplicate" | "sale_record";
  readonly marks: ReadonlyArray<ReprintMark>;
  readonly copyNumber: number;
  readonly recordedAt: string;
}

/** Why a reprint was refused. A closed set, audited and never returned. */
export type ReprintRefusalReason = "not_visible" | "not_capturing_device" | "duplicate_unavailable" | "key_reused";

export type ReprintOutcome =
  /** `replayed`: the reprint was already recorded under this key (an idempotency-cache miss). */
  | { readonly ok: true; readonly projection: SaleReprintProjection; readonly replayed: boolean }
  | { readonly ok: false; readonly reason: ReprintRefusalReason };
