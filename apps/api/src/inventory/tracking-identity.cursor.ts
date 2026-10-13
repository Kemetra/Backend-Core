/**
 * Opaque keyset cursor for `listTrackingIdentities` (RT-448).
 *
 * The list is ordered by `(kind, expiry_date NULLS LAST, code, id)`. The cursor
 * is the last row's sort key as base64url JSON, bound to the product it was
 * issued for: a cursor presented for another product, or a malformed one, is
 * rejected (`TrackingIdentityCursorError` → 400). A missing expiry date is
 * encoded as `infinity`, which sorts after every real date, so the keyset
 * predicate matches the NULLS LAST order.
 */
import { z } from "zod";

export class TrackingIdentityCursorError extends Error {}

export interface TrackingIdentityCursor {
  readonly productId: string;
  readonly kind: string;
  /** `YYYY-MM-DD`, or `infinity` for no expiry date. */
  readonly expiry: string;
  readonly code: string;
  readonly id: string;
}

const PayloadSchema = z
  .object({
    p: z.string().uuid(),
    k: z.enum(["batch", "serial"]),
    e: z.union([z.literal("infinity"), z.string().refine(isCalendarDate)]),
    c: z.string().min(1).max(128),
    i: z.string().uuid(),
  })
  .strict();

/**
 * `YYYY-MM-DD` naming a real day in years 0001–9999 — values the DB `::date`
 * cast accepts (rejects e.g. `2026-02-31` and `0000-01-01`, which would 500).
 */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function encodeTrackingIdentityCursor(c: TrackingIdentityCursor): string {
  return Buffer.from(
    JSON.stringify({ p: c.productId.toLowerCase(), k: c.kind, e: c.expiry, c: c.code, i: c.id }),
    "utf8",
  ).toString("base64url");
}

export function decodeTrackingIdentityCursor(
  token: string,
  productId: string,
): TrackingIdentityCursor {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new TrackingIdentityCursorError("malformed cursor");
  }
  const parsed = PayloadSchema.safeParse(raw);
  // UUIDs compare case-insensitively: the same product may arrive in either case.
  if (!parsed.success || parsed.data.p !== productId.toLowerCase()) {
    throw new TrackingIdentityCursorError("malformed cursor");
  }
  const d = parsed.data;
  return { productId: d.p, kind: d.k, expiry: d.e, code: d.c, id: d.i };
}
