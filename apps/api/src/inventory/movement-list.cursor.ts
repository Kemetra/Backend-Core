/**
 * Opaque keyset cursor for `listStockMovements` (RT-731, inventory.yaml
 * 1.5.0-draft).
 *
 * The list is ordered newest first by `(occurred_at DESC, id DESC)`. The repo
 * convention (`console-sales`, `sale-history`): unsigned base64url JSON bound
 * to this operation, the tenant, the store and a digest of every filter
 * (`productId`, `scope`); any other token is refused
 * (`StockMovementCursorError` → 400). It carries only the keyset position. The
 * caller's store scope is never in it: the controller re-checks the scope on
 * every page and the service ANDs the position with the tenant, the store and
 * the filters, so a hand-built token can only reposition the walk inside rows
 * the caller may already read.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

// The keyset-instant / UUID rules are the console-sales cursor's (same wire form).
import { KEY_INSTANT, LOWER_UUID, namesRealInstant } from "../console-sales/console-sales.query";

export class StockMovementCursorError extends Error {
  constructor() {
    super("cursor is not a valid continuation token for this query");
    this.name = "StockMovementCursorError";
  }
}

/** Which movements a listing without `productId` selects. */
export type StockMovementScope = "adhoc" | "all";

/** What a cursor is bound to. `productId` null ⇒ the listing is by `scope`. */
export interface StockMovementCursorBinding {
  readonly tenantId: string;
  readonly storeId: string;
  readonly productId: string | null;
  readonly scope: StockMovementScope | null;
}

/** The last row of a page: `occurredAtKey` is UTC with six fractional digits. */
export interface StockMovementKeyset {
  readonly occurredAtKey: string;
  readonly id: string;
}

const OPERATION = "stock_movements";

/** The SQL that renders `occurred_at` as a cursor key (microsecond, UTC). */
export const MOVEMENT_OCCURRED_AT_KEY_SQL = `to_char(m.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CursorPayload = z
  .object({
    op: z.literal(OPERATION),
    tenant: z.string().regex(LOWER_UUID),
    store: z.string().regex(LOWER_UUID),
    digest: z.string().min(1),
    at: z.string().regex(KEY_INSTANT).refine(namesRealInstant),
    id: z.string().regex(LOWER_UUID),
  })
  .strict();

type CursorPayload = z.infer<typeof CursorPayload>;

function digestOf(binding: StockMovementCursorBinding): string {
  const ordered = [binding.productId?.toLowerCase() ?? null, binding.scope];
  return createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("base64url").slice(0, 22);
}

export function encodeStockMovementCursor(
  binding: StockMovementCursorBinding,
  keyset: StockMovementKeyset,
): string {
  const payload: CursorPayload = {
    op: OPERATION,
    tenant: binding.tenantId.toLowerCase(),
    store: binding.storeId.toLowerCase(),
    digest: digestOf(binding),
    at: keyset.occurredAtKey,
    id: keyset.id.toLowerCase(),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** The keyset position of `cursor`, or StockMovementCursorError when it was not issued for `binding`. */
export function decodeStockMovementCursor(
  binding: StockMovementCursorBinding,
  cursor: string,
): StockMovementKeyset {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new StockMovementCursorError();
  }
  const parsed = CursorPayload.safeParse(decoded);
  if (!parsed.success) throw new StockMovementCursorError();
  const p = parsed.data;
  const boundHere =
    p.tenant === binding.tenantId.toLowerCase() &&
    p.store === binding.storeId.toLowerCase() &&
    p.digest === digestOf(binding);
  if (!boundHere) throw new StockMovementCursorError();
  return { occurredAtKey: p.at, id: p.id };
}
