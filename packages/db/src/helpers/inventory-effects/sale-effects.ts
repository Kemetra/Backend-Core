/**
 * Sale / void / return Inventory Effects — the in-transaction writers (Jira
 * RT-427; RT-289 DC-1, DC-2, DC-6, DC-8, Q5, Q7; RT-290 G4-6).
 *
 * Every function runs on the CALLER's tenant-context client, inside the
 * transaction that emits the event's `erpnext.posting.requested` intent, so
 * the effects and the intent commit or roll back together (DC-2, 769):
 *   - sale:   `SaleProcessingProcessor` (worker), before its `sale_post` emit;
 *   - void:   `recordVoid` and the credit-sale reversal (api);
 *   - return: `SaleReturnsService` and the credit-sale reversal (api).
 * The API and the worker both call this module, so the SQL has one home.
 *
 * Integration state (owner decision 1, option A). The `erpnext_posting_status`
 * row does not exist yet in these transactions: the worker's
 * `PostingRequestedConsumer` creates it later. Each effect therefore starts
 * `not_posted` (`state_reason = 'awaiting_posting_intent'`), and the consumer
 * links the event's effects in the SAME transaction that inserts the posting
 * row ({@link linkEffectsToPostingIntent}): `pending`, or `rejected` when the
 * creation verdict is `permanently_rejected`. From there only ERP posting
 * outcomes move them (RT-426).
 *
 * Positions (G4-6): a sale line leaves the store's primary location as
 * `sellable`; a void compensates at the exact position of the sale-line
 * effect it compensates (`compensates_effect_id`); a return line lands at the
 * store's primary location in the tenant's return landing status. Tracking
 * stays NULL (Gate 7 / RT-451). A refund has no effect (847, 851).
 *
 * Flag (Q4): nothing is written unless the tenant's
 * `sale_effects_activated_at` is set — except a void or return of a sale that
 * already has effects, so turning the flag off can never leave a sale's
 * decrement without its restore. The flag is read under a SHARED advisory lock
 * on the tenant's settings key; activation takes it EXCLUSIVE, so it
 * serializes with every in-flight writer.
 *
 * Exactly once (DC-1): each effect's `(source_system, external_id)` is
 * deterministic from its business line and protected by
 * `uq_stock_movements_tenant_source_external`; a replay writes nothing.
 * A line that cannot be written exactly is SKIPPED, never rounded or failed
 * (owner decision 2, `effect-lines.ts`); the caller reports it.
 *
 * Effects are never updated or deleted here (774, 775): `stock_movements` has
 * no UPDATE / DELETE policy.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { emit, OUTBOX_EVENT_TYPES } from "../../outbox";
import {
  decideEffectLine,
  returnLineEffectKey,
  saleLineEffectKey,
  voidEffectKey,
  type EffectLineFacts,
  type SaleEffectEvent,
  type SkippedEffectReason,
} from "./effect-lines";

/** The caller's tenant-context transaction client (the outbox `emit` needs a PoolClient). */
type Client = PoolClient;

/** The settings advisory-lock key prefix (shared with the RT-435 policy writer). */
export const INVENTORY_SETTINGS_LOCK_NAMESPACE = "tenant_inventory_settings";

/** `state_reason` of an effect whose posting row is not created yet. */
export const AWAITING_POSTING_INTENT = "awaiting_posting_intent";

export interface SkippedEffectLine {
  readonly lineId: string;
  readonly reason: SkippedEffectReason;
}

export interface SaleEffectsOutcome {
  readonly event: SaleEffectEvent;
  /** Ids of the effects this call wrote (empty on a replay or when OFF). */
  readonly written: readonly string[];
  readonly skipped: readonly SkippedEffectLine[];
}

/**
 * Whether sale effects are active for the tenant. Takes the tenant settings
 * key SHARED for the rest of the transaction first, so activation (EXCLUSIVE)
 * waits for this transaction and this one sees a committed activation.
 */
export async function readSaleEffectsActivation(client: Client, tenantId: string): Promise<boolean> {
  await client.query(
    `SELECT pg_advisory_xact_lock_shared(hashtextextended($1 || ':' || $2::text, 0))`,
    [INVENTORY_SETTINGS_LOCK_NAMESPACE, tenantId],
  );
  const r = await client.query<{ active: boolean }>(
    `SELECT sale_effects_activated_at IS NOT NULL AS active
       FROM tenant_inventory_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0]?.active === true;
}

// ---------------------------------------------------------------------------
// Shared write path
// ---------------------------------------------------------------------------

/** One effect to append. A NULL location means the store's primary location. */
interface EffectRow {
  readonly externalId: string;
  readonly movementType: "outbound" | "inbound";
  /** Signed exact decimal text. */
  readonly quantity: string;
  readonly unit: string;
  readonly tenantProductRef: string;
  readonly saleLineId: string;
  readonly compensatesEffectId: string | null;
  readonly stockLocationId: string | null;
  readonly inventoryStatus: string;
}

/** The owning Business Event of a batch of effects. */
interface EventHeader {
  readonly tenantId: string;
  readonly storeId: string;
  readonly saleId: string;
  readonly event: SaleEffectEvent;
  readonly eventRefId: string;
  /** The void / return row; NULL for a sale. */
  readonly terminalEventRef: string | null;
  readonly sourceSystem: string;
  readonly occurredAt: Date;
  readonly createdBy: string;
}

/** Common line facts, with the sale effect of the line (if any). */
interface LineFactsRow {
  line_id: string;
  sale_line_id: string;
  quantity: string;
  unit: string;
  tenant_product_ref: string | null;
  tracking_mode: string | null;
  established_unit: string | null;
  sale_effect_id: string | null;
  sale_effect_restore: string | null;
  sale_effect_unit: string | null;
  sale_effect_location: string | null;
  sale_effect_status: string | null;
}

/**
 * Line facts for `source` — a subquery `l(line_id, quantity, sale_line_ref)`
 * over a sale's lines or a return's lines. Each is joined to its sale line and
 * sale ($1 sale, $2 store). The established unit is read per (store,
 * product); the sale effect is the line's `sale` effect, located through
 * idx_stock_movements_tenant_event.
 */
function lineFactsSql(source: string, order: string): string {
  return `SELECT l.line_id, sl.id AS sale_line_id, l.quantity::text AS quantity, sl.unit,
                 sl.tenant_product_ref, tp.tracking_mode,
                 (SELECT m.stocking_unit FROM stock_movements m
                   WHERE m.tenant_id = s.tenant_id AND m.store_id = s.store_id
                     AND m.tenant_product_ref = sl.tenant_product_ref
                   LIMIT 1) AS established_unit,
                 e.id AS sale_effect_id, (-e.quantity)::text AS sale_effect_restore,
                 e.stocking_unit AS sale_effect_unit, e.stock_location_id AS sale_effect_location,
                 e.inventory_status AS sale_effect_status
            FROM ${source} l
            JOIN sale_lines sl ON sl.id = l.sale_line_ref
            JOIN sales s ON s.id = sl.sale_id
            LEFT JOIN tenant_products tp ON tp.id = sl.tenant_product_ref
            LEFT JOIN stock_movements e
              ON e.tenant_id = s.tenant_id AND e.event_type = 'sale'
             AND e.event_ref_id = s.id AND e.sale_line_id = sl.id
           WHERE s.id = $1 AND s.store_id = $2
           ORDER BY ${order}`;
}

/** A sale's own lines as the facts source, in capture order. */
const SALE_LINES_SOURCE = `(SELECT id AS line_id, quantity, id AS sale_line_ref FROM sale_lines WHERE sale_id = $1)`;
const SALE_LINES_ORDER = `sl.line_seq NULLS LAST, sl.id`;

/**
 * Decide every line in order. The unit a written line uses becomes the
 * product's established unit for the lines after it, so two lines of one
 * product in two units never both reach the 0016 guard.
 */
function decideLines(
  rows: readonly LineFactsRow[],
  build: (row: LineFactsRow) => Omit<EffectRow, "quantity" | "unit" | "tenantProductRef" | "saleLineId">,
  sign: 1 | -1,
): { effects: EffectRow[]; skipped: SkippedEffectLine[] } {
  const established = new Map<string, string>();
  const effects: EffectRow[] = [];
  const skipped: SkippedEffectLine[] = [];
  for (const row of rows) {
    const product = row.tenant_product_ref;
    const facts: EffectLineFacts = {
      tenantProductRef: product,
      quantity: row.quantity,
      unit: row.unit,
      trackingMode: row.tracking_mode,
      establishedUnit: (product !== null ? established.get(product) : undefined) ?? row.established_unit,
    };
    const decision = decideEffectLine(facts);
    if (decision.kind === "skip") skipped.push({ lineId: row.line_id, reason: decision.reason });
    if (decision.kind !== "write" || product === null) continue;
    established.set(product, row.unit);
    effects.push({
      ...build(row),
      quantity: sign < 0 ? `-${row.quantity}` : row.quantity,
      unit: row.unit,
      tenantProductRef: product,
      saleLineId: row.sale_line_id,
    });
  }
  return { effects, skipped };
}

/**
 * Append the effects, their `not_posted` integration records and one
 * `inventory.movement.created` event. Returns the ids actually written: a row
 * whose provenance key already exists is a DC-1 replay and is left alone.
 */
async function appendEffects(client: Client, h: EventHeader, rows: readonly EffectRow[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref,
        occurred_at, source_system, external_id, sale_id, sale_line_id, terminal_event_ref,
        created_by, origin, event_type, event_ref_id, compensates_effect_id,
        stock_location_id, inventory_status)
     SELECT r.id, $1, $2, r.movement_type, r.quantity, r.unit, r.product,
            $3, $4, r.external_id, $5, r.sale_line_id, $6,
            $7, 'retail', $8, $9, r.compensates,
            COALESCE(r.location,
                     (SELECT id FROM stock_locations WHERE store_id = $2 AND kind = 'primary')),
            r.status
       FROM unnest($10::uuid[], $11::text[], $12::numeric[], $13::text[], $14::uuid[],
                   $15::text[], $16::uuid[], $17::uuid[], $18::uuid[], $19::text[])
            AS r(id, movement_type, quantity, unit, product, external_id, sale_line_id,
                 compensates, location, status)
     ON CONFLICT (tenant_id, source_system, external_id)
       WHERE source_system IS NOT NULL AND external_id IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      h.tenantId,
      h.storeId,
      h.occurredAt,
      h.sourceSystem,
      h.saleId,
      h.terminalEventRef,
      h.createdBy,
      h.event,
      h.eventRefId,
      // UUIDv4, as the outbox producer (this package has no UUIDv7 dependency).
      rows.map(() => randomUUID()),
      rows.map((r) => r.movementType),
      rows.map((r) => r.quantity),
      rows.map((r) => r.unit),
      rows.map((r) => r.tenantProductRef),
      rows.map((r) => r.externalId),
      rows.map((r) => r.saleLineId),
      rows.map((r) => r.compensatesEffectId),
      rows.map((r) => r.stockLocationId),
      rows.map((r) => r.inventoryStatus),
    ],
  );
  const ids = inserted.rows.map((r) => r.id);
  if (ids.length === 0) return ids;
  await client.query(
    `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, state_reason)
     SELECT effect_id, $1, 'not_posted', $3 FROM unnest($2::uuid[]) AS effect_id`,
    [h.tenantId, ids, AWAITING_POSTING_INTENT],
  );
  await emit(client, {
    eventType: OUTBOX_EVENT_TYPES.INVENTORY_MOVEMENT_CREATED,
    tenantId: h.tenantId,
    storeId: h.storeId,
    payload: {
      movementIds: ids,
      movementType: rows[0]!.movementType,
      tenantProductRef: null,
      eventType: h.event,
      eventRefId: h.eventRefId,
    },
    correlationId: null,
  });
  return ids;
}

// ---------------------------------------------------------------------------
// Sale
// ---------------------------------------------------------------------------

export interface SaleEffectsInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly saleId: string;
}

/**
 * One `outbound` effect per sale line (`-q`, primary / sellable,
 * `sale_line:<id>`). Call it once, when the sale first becomes processed, in
 * the transaction that emits its `sale_post` intent.
 */
export async function writeSaleLineEffects(client: Client, input: SaleEffectsInput): Promise<SaleEffectsOutcome> {
  const none: SaleEffectsOutcome = { event: "sale", written: [], skipped: [] };
  if (!(await readSaleEffectsActivation(client, input.tenantId))) return none;
  const header = await client.query<{ source_system: string; occurred_at: Date; created_by: string }>(
    `SELECT source_system, occurred_at, created_by FROM sales WHERE id = $1 AND store_id = $2`,
    [input.saleId, input.storeId],
  );
  const sale = header.rows[0];
  if (!sale) return none;
  const facts = await client.query<LineFactsRow>(
    lineFactsSql(SALE_LINES_SOURCE, SALE_LINES_ORDER),
    [input.saleId, input.storeId],
  );
  const { effects, skipped } = decideLines(
    facts.rows,
    (row) => ({
      externalId: saleLineEffectKey(row.sale_line_id),
      movementType: "outbound",
      compensatesEffectId: null,
      stockLocationId: null,
      inventoryStatus: "sellable",
    }),
    -1,
  );
  const written = await appendEffects(
    client,
    {
      tenantId: input.tenantId,
      storeId: input.storeId,
      saleId: input.saleId,
      event: "sale",
      eventRefId: input.saleId,
      terminalEventRef: null,
      sourceSystem: sale.source_system,
      occurredAt: sale.occurred_at,
      createdBy: sale.created_by,
    },
    effects,
  );
  return { event: "sale", written, skipped };
}

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

export interface VoidEffectsInput extends SaleEffectsInput {
  readonly voidId: string;
}

/**
 * A void restores every sale-line effect of the sale exactly once: `+q` at
 * the position of the effect it compensates (`void:<voidId>:<saleLineId>`,
 * `compensates_effect_id`). A sale with no effect yet (processed before
 * activation, or not processed yet) is restored per line at primary /
 * sellable, without a compensated effect. Both effect sets always stand;
 * nothing is netted (DC-6, Q5).
 */
export async function writeVoidEffects(client: Client, input: VoidEffectsInput): Promise<SaleEffectsOutcome> {
  const none: SaleEffectsOutcome = { event: "sale_void", written: [], skipped: [] };
  const active = await readSaleEffectsActivation(client, input.tenantId);
  const header = await client.query<{ source_system: string; voided_at: Date; created_by: string }>(
    `SELECT source_system, voided_at, created_by FROM sale_voids WHERE id = $1 AND sale_id = $2`,
    [input.voidId, input.saleId],
  );
  const voidRow = header.rows[0];
  if (!voidRow) return none;
  const facts = await client.query<LineFactsRow>(
    lineFactsSql(SALE_LINES_SOURCE, SALE_LINES_ORDER),
    [input.saleId, input.storeId],
  );
  const compensated = facts.rows.filter((r) => r.sale_effect_id !== null);
  let effects: EffectRow[];
  let skipped: SkippedEffectLine[] = [];
  if (compensated.length > 0) {
    effects = compensated.map((r) => ({
      externalId: voidEffectKey(input.voidId, r.sale_line_id),
      movementType: "inbound",
      quantity: r.sale_effect_restore!,
      unit: r.sale_effect_unit!,
      tenantProductRef: r.tenant_product_ref!,
      saleLineId: r.sale_line_id,
      compensatesEffectId: r.sale_effect_id,
      stockLocationId: r.sale_effect_location,
      inventoryStatus: r.sale_effect_status!,
    }));
  } else if (active) {
    ({ effects, skipped } = decideLines(
      facts.rows,
      (row) => ({
        externalId: voidEffectKey(input.voidId, row.sale_line_id),
        movementType: "inbound",
        compensatesEffectId: null,
        stockLocationId: null,
        inventoryStatus: "sellable",
      }),
      1,
    ));
  } else {
    return none;
  }
  const written = await appendEffects(
    client,
    {
      tenantId: input.tenantId,
      storeId: input.storeId,
      saleId: input.saleId,
      event: "sale_void",
      eventRefId: input.voidId,
      terminalEventRef: input.voidId,
      sourceSystem: voidRow.source_system,
      occurredAt: voidRow.voided_at,
      createdBy: voidRow.created_by,
    },
    effects,
  );
  return { event: "sale_void", written, skipped };
}

// ---------------------------------------------------------------------------
// Return
// ---------------------------------------------------------------------------

export interface ReturnEffectsInput extends SaleEffectsInput {
  readonly returnId: string;
  /** The tenant's return landing status (RT-435 `resolveReturnLandingStatus`). */
  readonly landingStatus: string;
}

/**
 * One `+q` effect per return line, at the store's primary location in the
 * tenant's return landing status (`return_line:<id>`; Q6 / Q7). Written when
 * the tenant is active, or for a line whose sale line has an effect.
 */
export async function writeReturnEffects(client: Client, input: ReturnEffectsInput): Promise<SaleEffectsOutcome> {
  const none: SaleEffectsOutcome = { event: "sale_return", written: [], skipped: [] };
  const active = await readSaleEffectsActivation(client, input.tenantId);
  const header = await client.query<{ source_system: string; returned_at: Date; created_by: string }>(
    `SELECT source_system, returned_at, created_by FROM sale_returns WHERE id = $1 AND sale_id = $2`,
    [input.returnId, input.saleId],
  );
  const returnRow = header.rows[0];
  if (!returnRow) return none;
  const facts = await client.query<LineFactsRow>(
    lineFactsSql(
      `(SELECT id AS line_id, quantity, sale_line_id AS sale_line_ref
          FROM sale_return_lines WHERE return_id = $3)`,
      `l.line_id`,
    ),
    [input.saleId, input.storeId, input.returnId],
  );
  const eligible = active ? facts.rows : facts.rows.filter((r) => r.sale_effect_id !== null);
  const { effects, skipped } = decideLines(
    eligible,
    (row) => ({
      externalId: returnLineEffectKey(row.line_id),
      movementType: "inbound",
      compensatesEffectId: null,
      stockLocationId: null,
      inventoryStatus: input.landingStatus,
    }),
    1,
  );
  const written = await appendEffects(
    client,
    {
      tenantId: input.tenantId,
      storeId: input.storeId,
      saleId: input.saleId,
      event: "sale_return",
      eventRefId: input.returnId,
      terminalEventRef: input.returnId,
      sourceSystem: returnRow.source_system,
      occurredAt: returnRow.returned_at,
      createdBy: returnRow.created_by,
    },
    effects,
  );
  return { event: "sale_return", written, skipped };
}

// ---------------------------------------------------------------------------
// Link at posting-intent creation (worker consumer)
// ---------------------------------------------------------------------------

export interface LinkEffectsInput {
  readonly tenantId: string;
  readonly kind: "sale_post" | "reversal";
  /** The posting row's `source_ref_id`: the sale, void, refund or return id. */
  readonly sourceRefId: string;
  readonly postingStatusId: string;
  readonly verdict:
    | { readonly status: "pending" }
    | { readonly status: "permanently_rejected"; readonly rejectionCategory: string };
}

/**
 * Owner decision 1 (option A): link the event's `not_posted` effects to the
 * posting row created in the caller's transaction — `pending`, or `rejected`
 * (with the rejection category as reason) for a creation-time rejection.
 * Only effects still awaiting their intent move; a refund has none. Returns
 * the number of effects linked.
 */
export async function linkEffectsToPostingIntent(client: Client, input: LinkEffectsInput): Promise<number> {
  const events = input.kind === "sale_post" ? ["sale"] : ["sale_void", "sale_return"];
  const rejected = input.verdict.status === "permanently_rejected";
  const r = await client.query(
    `UPDATE inventory_effect_integration i
        SET state = $3, posting_status_id = $4, state_reason = $5, updated_at = now()
       FROM stock_movements m
      WHERE m.id = i.effect_id AND m.tenant_id = $1 AND i.tenant_id = $1
        AND i.state = 'not_posted'
        AND m.event_ref_id = $2 AND m.event_type = ANY($6::text[])`,
    [
      input.tenantId,
      input.sourceRefId,
      rejected ? "rejected" : "pending",
      input.postingStatusId,
      input.verdict.status === "permanently_rejected" ? input.verdict.rejectionCategory : null,
      events,
    ],
  );
  return r.rowCount ?? 0;
}
