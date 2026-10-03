/**
 * __returns-support.ts — shared helpers for the RT-73 return specs. NOT a spec
 * (`__`-prefixed). Builds on the 008 capture harness.
 */
import {
  captureBody,
  DEVICE_USER_ID,
  idempKey,
  STORE_A_X,
  TENANT_A,
  type HarnessHandle,
} from "../capture/__capture-harness";
import { sha256CanonicalHex } from "../../../../src/catalog/sales/payload-hash";

/** Enable the RT-73 deployment gate for a suite (read per request). */
export function enableReturns(): void {
  process.env["POS_RETURNS_ENABLED"] = "true";
}

export function disableReturns(): void {
  delete process.env["POS_RETURNS_ENABLED"];
}

export interface OneLineSale {
  readonly saleRef: string;
  readonly lineRef: string;
}

/**
 * RT-105: the unit price of a line whose amount A divides exactly by quantity Q
 * (A ÷ Q at 4 decimals), so the capture meets the line price invariant. A line
 * that does not divide cannot be captured any more; seed it with
 * `seedPreInvariantSale` instead.
 */
function exactUnitPrice(lineAmount: string, quantity: string): string {
  const scaled = (v: string, scale: number): bigint => {
    const [whole, frac = ""] = v.split(".");
    return BigInt(whole! + frac.padEnd(scale, "0"));
  };
  const amount = scaled(lineAmount, 4) * 1_000_000n;
  const qty = scaled(quantity, 6);
  if (amount % qty !== 0n) {
    throw new Error(`captureOneLine: ${lineAmount} ÷ ${quantity} is not exact; seed it as a pre-RT-105 sale`);
  }
  const unit = (amount / qty).toString().padStart(5, "0");
  return `${unit.slice(0, -4)}.${unit.slice(-4)}`;
}

/** Capture a one-line sale (quantity Q, amount A, optional tax T) and return its refs. */
export async function captureOneLine(
  h: HarnessHandle,
  opts: { externalId: string; quantity: string; lineAmount: string; taxAmount?: string },
): Promise<OneLineSale> {
  const harness = h.harness!;
  const res = await harness
    .http()
    .post("/api/pos/v1/sales")
    .set("Idempotency-Key", idempKey(`cap${opts.externalId.toLowerCase()}`))
    .send(
      captureBody({
        externalId: opts.externalId,
        posTotal: opts.lineAmount,
        lines: [
          {
            lineName: "Widget",
            unitPrice: exactUnitPrice(opts.lineAmount, opts.quantity),
            currencyCode: "USD",
            quantity: opts.quantity,
            lineAmount: opts.lineAmount,
            ...(opts.taxAmount === undefined ? {} : { taxAmount: opts.taxAmount }),
            unit: "ea",
          },
        ],
      }),
    );
  if (res.status !== 201) {
    throw new Error(`capture failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { saleRef: res.body.saleRef, lineRef: res.body.lines[0].lineRef };
}

/** A recordReturn body for the given lines, paid out in one cash tender. */
export function returnBody(
  externalId: string,
  lines: ReadonlyArray<{ lineRef: string; quantity: string }>,
  cashAmount: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId,
    lines,
    refundTenders: [{ method: "cash", amount: cashAmount }],
    ...extra,
  };
}

/**
 * RT-105: store a one-line return the way `recordReturn` did BEFORE the
 * whole-quantity rule (so it may carry a fractional q on a whole line), with
 * the payload hash a re-delivery of `body` will present. Not a capture path:
 * rows are written directly, as `seedPreInvariantSale` does for sales.
 */
export async function seedPreRuleReturn(
  h: HarnessHandle,
  sale: OneLineSale,
  body: Record<string, unknown>,
  priced: { quantity: string; lineAmount: string; returnedAfter: string },
): Promise<void> {
  const admin = h.harness!.env.admin;
  const ret = await admin.query<{ id: string }>(
    `INSERT INTO sale_returns
       (id, sale_id, tenant_id, store_id, return_seq, business_date, currency_code,
        return_total, reason, source_system, external_id, payload_hash, created_by)
     VALUES (gen_random_uuid(), $1, $2, $3, 1, (now() AT TIME ZONE 'UTC')::date, 'USD',
             $4::numeric, NULL, $5, $6, $7, $8)
     RETURNING id::text AS id`,
    [sale.saleRef, TENANT_A, STORE_A_X, priced.lineAmount, body["sourceSystem"], body["externalId"],
      sha256CanonicalHex(body), DEVICE_USER_ID],
  );
  const returnId = ret.rows[0]!.id;
  await admin.query(
    `INSERT INTO sale_return_lines
       (id, return_id, sale_line_id, tenant_id, store_id, quantity, line_amount,
        tax_amount, returned_quantity_after)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::numeric, $6::numeric, NULL, $7::numeric)`,
    [returnId, sale.lineRef, TENANT_A, STORE_A_X, priced.quantity, priced.lineAmount, priced.returnedAfter],
  );
  await admin.query(
    `INSERT INTO sale_return_tenders (id, return_id, tenant_id, store_id, ordinal, method, amount)
     VALUES (gen_random_uuid(), $1, $2, $3, 0, 'cash', $4::numeric)`,
    [returnId, TENANT_A, STORE_A_X, priced.lineAmount],
  );
}

/** POST a return. */
export function postReturn(
  h: HarnessHandle,
  saleRef: string,
  body: Record<string, unknown>,
  key: string,
) {
  return h
    .harness!.http()
    .post(`/api/pos/v1/sales/${saleRef}/returns`)
    .set("Idempotency-Key", idempKey(key))
    .send(body);
}

/** Remove every row the return specs create (children first). */
export async function cleanReturnsFixtures(h: HarnessHandle): Promise<void> {
  if (!h.harness) return;
  const q = (sql: string) => h.harness!.env.admin.query(sql);
  const sales = "SELECT id FROM sales WHERE source_system = 'pos-1'";
  await q(`DELETE FROM sale_return_tenders WHERE return_id IN
           (SELECT id FROM sale_returns WHERE sale_id IN (${sales}))`);
  await q(`DELETE FROM sale_return_lines WHERE return_id IN
           (SELECT id FROM sale_returns WHERE sale_id IN (${sales}))`);
  await q(`DELETE FROM sale_returns WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_voids WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_tenders WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_lines WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sales WHERE source_system = 'pos-1'`);
}
