/**
 * ReadDownService — 010 US1-SNAPSHOT (T035).
 *
 * Implements `posGetCatalogSnapshot` from
 * `packages/contracts/openapi/catalog/read-down.yaml`:
 *   GET /api/pos/v1/catalog/snapshot → the Resolved Sellable Store Catalogue
 *   (Tenant Catalog ⊕ Store Override, 003 §6.4) for the device principal's
 *   (tenant_id, store_id), at a server-issued opaque cursor, cursor-paginated.
 *
 * READ-ONLY. The platform stays the catalogue authority (§IX); there is no
 * write surface. The advisory-op DELTA derivation is US2's job — NOT here.
 *
 * Resolver (built fresh — no prior Tenant ⊕ Override read service existed):
 * LEFT JOIN store_product_overrides on (tenant_id, store_id, product_id) and
 * COALESCE each overrideable field (price, currency, is_active, tax_category)
 * over the tenant base. Sellable filter (R5): resolved active AND not retired
 * AND price present AND currency present AND representable in the currency's
 * minor unit. Excluded rows emit the unpriced-issue signal + are absent from
 * the page.
 *
 * Cursor (FR-011): the opaque snapshot cursor IS the change-log head sequence
 * (research R1) — `SELECT max(sequence) FROM catalog_change_log` under the
 * tenant GUC. Encoded opaque (base64) so the mechanism stays invisible. All
 * pages of one snapshot reflect the SAME cursor point (FR-012).
 *
 * Scope comes from the device principal ONLY (never the body) — the controller
 * passes the resolved (tenant_id, store_id); the service runs every query under
 * `runWithTenantContext` so RLS enforces tenant isolation, and an explicit
 * store_id predicate enforces the store boundary.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import { runWithTenantContext } from "@data-pulse-2/db";
import { recordCatalogUnpricedIssue } from "../../observability/metrics/api.metrics";
import {
  encodeCursor,
  decodeCursor,
  isJsonObject,
  ReadDownCursorError,
  type SnapshotCursor,
} from "./read-down.cursor";
import {
  toSellableRow,
  isRepresentable,
  type ResolvedCatalogRow,
  type SellableCatalogRow,
} from "./read-down.toBody";

/** One page of the resolved sellable catalogue (contract CatalogSnapshotPage). */
export interface CatalogSnapshotPage {
  readonly items: ReadonlyArray<SellableCatalogRow>;
  /** The snapshot's opaque server cursor (same across every page — FR-012). */
  readonly cursor: string;
  /** Opaque next-page token; null on the last page. */
  readonly next_page_token: string | null;
}

/** One ordered delta op (contract CatalogDeltaOp). */
export interface CatalogDeltaOp {
  readonly op: "upsert" | "remove_from_sellable";
  readonly product_id: string;
  /** Present for `upsert`; omitted for `remove_from_sellable`. */
  readonly row?: SellableCatalogRow;
  readonly row_cursor: string;
}

/** One page of ordered sellable-stream changes (contract CatalogDeltaPage). */
export interface CatalogDeltaPage {
  readonly ops: ReadonlyArray<CatalogDeltaOp>;
  /** The advanced opaque server cursor — pass as `since` next time. */
  readonly cursor: string;
  readonly next_page_token: string | null;
}

/** Outcome wrapper so the controller can map `snapshot_required` to a 409. */
export type DeltaResult =
  | { kind: "ok"; page: CatalogDeltaPage }
  | { kind: "snapshot_required" };

/** Default + max page size (contract Limit: 1..1000, default 500). */
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

interface ResolvedRow {
  product_id: string;
  sku: string | null;
  aliases: string[] | null;
  name: string;
  resolved_price: string | null;
  resolved_currency: string | null;
  resolved_tax_category: string;
  resolved_active: boolean;
  retired_at: Date | null;
  row_sequence: string | null;
}

@Injectable()
export class ReadDownService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Resolve + page the sellable catalogue snapshot for (tenantId, storeId).
   *
   * `pageToken` (opaque) continues a prior page within the SAME cursor point;
   * `cursorToken` (opaque) pins the snapshot to a consistent change-log head so
   * concurrent mutations after it are not torn into pages (FR-012). The first
   * call (no cursorToken) reads the current head and uses it for all pages.
   */
  async getSnapshot(
    tenantId: string,
    storeId: string,
    opts: {
      limit?: number | undefined;
      pageToken?: string | null | undefined;
      cursorToken?: string | null | undefined;
    } = {},
  ): Promise<CatalogSnapshotPage> {
    const limit = clampLimit(opts.limit);

    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<CatalogSnapshotPage> => {
        // Establish the STORE context: store_product_overrides is RLS'd by
        // tenant_id AND store_id (0008/0009/0011), so without app.current_store
        // the override rows are RLS-hidden and the LEFT JOIN silently yields
        // NULL (falling through to the tenant price). transaction-local
        // (is_local = true) so it does not leak across pool reuse. Mirrors
        // StoreOverrideService — the legitimate way to read store-scoped rows
        // under the device principal's resolved store (NOT a SECURITY-DEFINER /
        // platform-admin bypass, which would break §II store isolation).
        await client.query("SELECT set_config('app.current_store', $1, true)", [
          storeId,
        ]);

        // Pin the snapshot cursor: reuse the caller's pinned head if continuing
        // a page set, else read the current change-log head sequence (FR-011).
        let head: SnapshotCursor;
        if (opts.cursorToken) {
          head = decodeCursor(opts.cursorToken, tenantId, storeId);
        } else {
          const r = await client.query<{ head: string | null }>(
            `SELECT max(sequence)::text AS head FROM catalog_change_log
               WHERE tenant_id = $1`,
            [tenantId],
          );
          head = { tenantId, storeId, sequence: r.rows[0]?.head ?? "0" };
        }
        const cursor = encodeCursor(head);

        // Page boundary: products are ordered by product_id; page_token carries
        // the last product_id SCANNED at this cursor point (sellable or not).
        const afterProductId = opts.pageToken
          ? decodePageToken(opts.pageToken, tenantId, storeId)
          : null;

        // Resolved(store) = Tenant ⊕ Store Override (003 §6.4), paginated by
        // product_id. Over-fetch by 1 to detect a next page.
        const resolved = await this.resolveProducts(client, tenantId, storeId, head.sequence, {
          afterProductId,
          limit: limit + 1,
        });

        // Scan exactly the first `limit` products; the +1 over-fetch row is
        // only the next-page sentinel and is never consumed here. Continuation
        // follows the SCANNED products, not the emitted ones (RT-394): a page
        // may hold fewer than `limit` items — even none, when every scanned
        // product is excluded — yet still carry a token, so excluded products
        // can never end the snapshot before later sellable ones.
        const scanned = resolved.slice(0, limit);
        const items: SellableCatalogRow[] = [];
        for (const row of scanned) {
          const sellable = this.classifySellable(row);
          if (sellable.kind === "excluded") {
            // R5/R6 — absent from the stream + recorded as an unpriced issue.
            // (NEVER on the sellable stream, NEVER to a cashier — FR-043/044.)
            if (sellable.priceRelated) recordCatalogUnpricedIssue();
            continue;
          }
          items.push(toSellableRow(sellable.row, cursor));
        }

        // A next page exists iff the over-fetch returned a row beyond the scan.
        const lastScanned = scanned.at(-1);
        const next_page_token =
          resolved.length > limit && lastScanned
            ? encodePageToken({ tenantId, storeId, afterProductId: lastScanned.product_id })
            : null;

        return { items, cursor, next_page_token };
      },
    );
  }

  /**
   * Advance a terminal's replica from the opaque `since` cursor (US2 / T044).
   *
   * Reads `catalog_change_log` with the R9 union filter
   *   `tenant_id = T AND (store_id = S OR store_id IS NULL) AND sequence > C`
   * to get the changed product_ids after C (the stored `op` is ADVISORY — a
   * change-signal, NOT the wire verdict — data-model §3/§4). For each changed
   * product it RE-RESOLVES Tenant ⊕ Override at read time and DERIVES the wire
   * op from CURRENT sellability: sellable → `upsert` + the resolved row, not →
   * `remove_from_sellable`. This is what makes override-masking a harmless
   * idempotent re-upsert (FR-021) and correctly handles override DELETE (reverts
   * to a still-sellable tenant base → upsert) / override deactivate (→ remove).
   *
   * Idempotent replay (FR-021): the same `since` yields the same logical set.
   * `snapshot_required` (FR-023): `since` older than the retained change-log
   * horizon (the min retained sequence) → re-baseline directive. Foreign-scope
   * cursor → ReadDownCursorError (the controller maps it to a non-disclosing
   * 404, FR-024).
   */
  async getDeltas(
    tenantId: string,
    storeId: string,
    sinceToken: string,
    opts: { limit?: number | undefined } = {},
  ): Promise<DeltaResult> {
    const limit = clampLimit(opts.limit);
    // Decode + scope-validate the opaque since cursor (throws on foreign scope).
    const since = decodeCursor(sinceToken, tenantId, storeId);

    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<DeltaResult> => {
        await client.query("SELECT set_config('app.current_store', $1, true)", [
          storeId,
        ]);

        // snapshot_required: a `since` strictly below the retained horizon (the
        // min sequence still in the log) cannot be served — the consumer missed
        // events that were pruned. With no pruning yet, min is the earliest row;
        // a since of "0" (snapshot of an empty log) is always servable.
        const horizon = await client.query<{ min: string | null }>(
          `SELECT min(sequence)::text AS min FROM catalog_change_log
             WHERE tenant_id = $1`,
          [tenantId],
        );
        const minSeq = horizon.rows[0]?.min;
        if (minSeq !== null && minSeq !== undefined) {
          // since must be >= minSeq - 1 (a cursor at minSeq-1 can still see the
          // first retained row). If since < minSeq - 1, events were pruned.
          if (BigInt(since.sequence) < BigInt(minSeq) - 1n) {
            return { kind: "snapshot_required" };
          }
        }

        // The advanced head + the page's response cursor.
        const headRes = await client.query<{ head: string | null }>(
          `SELECT max(sequence)::text AS head FROM catalog_change_log
             WHERE tenant_id = $1`,
          [tenantId],
        );
        const head = headRes.rows[0]?.head ?? since.sequence;

        // R9 union: distinct product_ids changed after C, in sequence order,
        // bounded to one page. The stored op is ignored — we re-resolve below.
        const changed = await client.query<{ product_id: string; max_seq: string }>(
          `SELECT product_id, max(sequence)::text AS max_seq
             FROM catalog_change_log
            WHERE tenant_id = $1
              AND (store_id = $2 OR store_id IS NULL)
              AND sequence > $3::bigint
            GROUP BY product_id
            ORDER BY max(sequence)
            LIMIT $4`,
          [tenantId, storeId, since.sequence, limit + 1],
        );

        const pageRows = changed.rows.slice(0, limit);
        const hasMore = changed.rows.length > limit;

        // Re-resolve the changed products IDENTICALLY to the snapshot.
        const resolved = await this.resolveProducts(client, tenantId, storeId, head, {
          productIds: pageRows.map((r) => r.product_id),
        });
        const byId = new Map(resolved.map((r) => [r.product_id, r]));

        const ops: CatalogDeltaOp[] = [];
        let lastSeq = since.sequence;
        for (const ch of pageRows) {
          lastSeq = ch.max_seq;
          const rowCursor = encodeCursor({ tenantId, storeId, sequence: ch.max_seq });
          const resolvedRow = byId.get(ch.product_id);
          const sellable = resolvedRow
            ? this.classifySellable(resolvedRow)
            : ({ kind: "excluded", priceRelated: false } as const);
          if (sellable.kind === "sellable") {
            ops.push({
              op: "upsert",
              product_id: ch.product_id,
              row: toSellableRow(sellable.row, rowCursor),
              row_cursor: rowCursor,
            });
          } else {
            // Not currently sellable → tombstone (retired / deactivated /
            // unpriced / hard-deleted). The row is omitted; the consumer drops
            // it by product_id. (A product deleted entirely won't be in `byId`.)
            if (sellable.kind === "excluded" && sellable.priceRelated) {
              recordCatalogUnpricedIssue();
            }
            ops.push({
              op: "remove_from_sellable",
              product_id: ch.product_id,
              row_cursor: rowCursor,
            });
          }
        }

        // Advance the cursor: the last emitted sequence (so the next `since`
        // resumes exactly after this page), or the head if nothing changed.
        const advanced = pageRows.length > 0 ? lastSeq : head;
        const cursor = encodeCursor({ tenantId, storeId, sequence: advanced });
        const next_page_token = hasMore
          ? encodeCursor({ tenantId, storeId, sequence: lastSeq })
          : null;

        return { kind: "ok", page: { ops, cursor, next_page_token } };
      },
    );
  }

  /**
   * Resolve `Tenant ⊕ Store Override` (003 §6.4) for products under the current
   * tenant + store GUC. Two modes (mutually exclusive):
   *   - paginated: `{ afterProductId, limit }` — products ordered by id (snapshot);
   *   - targeted:  `{ productIds }` — exactly these products (delta re-resolution).
   * `headSeq` bounds the per-row `row_sequence` (≤ the response cursor). Returns
   * the raw resolved rows; the caller classifies sellability + projects toBody.
   *
   * Shared by getSnapshot (US1) and getDeltas (US2) — single source of the
   * resolution SQL so the delta op derivation re-resolves IDENTICALLY to the
   * snapshot (the advisory-op model in data-model §3/§4 depends on this).
   */
  private async resolveProducts(
    client: PoolClient,
    tenantId: string,
    storeId: string,
    headSeq: string,
    mode:
      | { afterProductId: string | null; limit: number; productIds?: undefined }
      | { productIds: string[]; afterProductId?: undefined; limit?: undefined },
  ): Promise<ResolvedRow[]> {
    const targeted = mode.productIds !== undefined;
    if (targeted && mode.productIds.length === 0) return [];
    const r = await client.query<ResolvedRow>(
      `
      SELECT
        tp.id AS product_id,
        tp.name AS name,
        COALESCE(spo.price, tp.default_price)::text AS resolved_price,
        COALESCE(spo.currency_code, tp.default_currency_code) AS resolved_currency,
        COALESCE(spo.tax_category, tp.tax_category) AS resolved_tax_category,
        COALESCE(spo.is_active, tp.is_active) AS resolved_active,
        tp.retired_at AS retired_at,
        (
          SELECT pa.value FROM product_aliases pa
          WHERE pa.tenant_id = tp.tenant_id AND pa.product_id = tp.id
            AND pa.identifier_type = 'sku' AND pa.retired_at IS NULL
            AND (pa.store_id IS NULL OR pa.store_id = $2)
          ORDER BY pa.store_id NULLS LAST LIMIT 1
        ) AS sku,
        (
          SELECT array_agg(pa.value ORDER BY pa.value) FROM product_aliases pa
          WHERE pa.tenant_id = tp.tenant_id AND pa.product_id = tp.id
            AND pa.identifier_type <> 'sku' AND pa.retired_at IS NULL
            AND (pa.store_id IS NULL OR pa.store_id = $2)
        ) AS aliases,
        (
          SELECT max(ccl.sequence)::text FROM catalog_change_log ccl
          WHERE ccl.tenant_id = tp.tenant_id AND ccl.product_id = tp.id
            AND (ccl.store_id = $2 OR ccl.store_id IS NULL)
            AND ccl.sequence <= $3::bigint
        ) AS row_sequence
      FROM tenant_products tp
      LEFT JOIN store_product_overrides spo
        ON spo.tenant_id = tp.tenant_id
       AND spo.store_id = $2
       AND spo.product_id = tp.id
       AND spo.retired_at IS NULL
      WHERE tp.tenant_id = $1
        AND (
          ($4::uuid[] IS NOT NULL AND tp.id = ANY($4::uuid[]))         -- targeted
          OR ($4::uuid[] IS NULL AND ($5::uuid IS NULL OR tp.id > $5::uuid)) -- paginated
        )
      ORDER BY tp.id
      ${targeted ? "" : "LIMIT $6"}
      `,
      targeted
        ? // targeted mode omits `LIMIT $6` → the statement references $1–$5
          // only; supplying a 6th param makes Postgres reject the Bind (→ 500).
          [tenantId, storeId, headSeq, mode.productIds, null]
        : [tenantId, storeId, headSeq, null, mode.afterProductId, mode.limit],
    );
    return r.rows;
  }

  /**
   * Classify a resolved row as sellable or excluded (R5). Excluded rows carry
   * a `priceRelated` flag so the caller only counts price/currency/representable
   * issues toward the unpriced-issue signal (a retired/inactive row is excluded
   * but is not an "unpriced issue").
   */
  private classifySellable(
    row: ResolvedRow,
  ):
    | { kind: "sellable"; row: ResolvedCatalogRow }
    | { kind: "excluded"; priceRelated: boolean } {
    const active = row.resolved_active && row.retired_at === null;
    const priced = row.resolved_price !== null && row.resolved_currency !== null;
    if (!priced) {
      // null_price / missing_currency (the latter is unreachable as stored data,
      // but guarded defensively). Price-related only if the row was otherwise
      // active (an inactive unpriced row is excluded for activity, not price).
      return { kind: "excluded", priceRelated: active };
    }
    if (!isRepresentable(row.resolved_price as string, row.resolved_currency as string)) {
      return { kind: "excluded", priceRelated: true }; // non_representable
    }
    if (!active) {
      return { kind: "excluded", priceRelated: false }; // retired / deactivated
    }
    return {
      kind: "sellable",
      row: {
        product_id: row.product_id,
        sku: row.sku ?? row.product_id,
        name: row.name,
        aliases: row.aliases ?? [],
        amount: row.resolved_price as string,
        currency_code: row.resolved_currency as string,
        tax_category: row.resolved_tax_category,
        row_sequence: row.row_sequence,
      },
    };
  }
}

function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// Page token — opaque, scope-bound (distinct from the snapshot cursor)
// ---------------------------------------------------------------------------

interface PageTokenPayload {
  tenantId: string;
  storeId: string;
  afterProductId: string;
}

function encodePageToken(p: PageTokenPayload): string {
  return Buffer.from(
    JSON.stringify({ t: p.tenantId, s: p.storeId, a: p.afterProductId }),
    "utf8",
  ).toString("base64url");
}

function decodePageToken(
  token: string,
  tenantId: string,
  storeId: string,
): string {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new ReadDownCursorError("malformed page_token");
  }
  if (!isJsonObject(payload)) {
    throw new ReadDownCursorError("malformed page_token");
  }
  if (
    payload.t !== tenantId ||
    payload.s !== storeId ||
    typeof payload.a !== "string" ||
    payload.a === ""
  ) {
    // Scope-bound: a page token from another scope is non-disclosingly rejected.
    throw new ReadDownCursorError("page_token scope mismatch");
  }
  return payload.a;
}
