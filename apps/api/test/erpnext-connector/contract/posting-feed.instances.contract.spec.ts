/**
 * posting-feed.instances.contract.spec.ts — RT-86 AC2.
 *
 * The structural spec (`posting-feed.contract.spec.ts`) checks the SCHEMA's own shape, so it
 * cannot notice a projection that emits a malformed work item. This spec validates real
 * `buildWorkItem` OUTPUT (Docker-free, fake PoolClient) against `PostingWorkItem` in
 * `packages/contracts/openapi/erpnext-connector/posting-feed.yaml` with Ajv (JSON Schema
 * 2020-12, the OpenAPI 3.1 dialect — the ReversalRef kind rules use if/then/else + not/anyOf).
 *
 * Negative controls prove the validator is live: `refundTenders: []` (minItems 1) and refund
 * tenders on a void (return-only) must be rejected.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { PoolClient } from "pg";

import { buildWorkItem } from "../../../src/catalog/erpnext-posting/posting-work-item.projection";
import { loadOpenApiContracts } from "../../../src/openapi/loader";

const CONNECTOR_DIR = resolve(__dirname, "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "erpnext-connector");

function workItemValidator(): ValidateFunction {
  const contract = loadOpenApiContracts({ dir: CONNECTOR_DIR }).find((c) => c.id === "posting-feed");
  if (!contract) throw new Error("posting-feed.yaml not found");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(contract.document as object), $id: "posting-feed" });
  return ajv.compile({ $ref: "posting-feed#/components/schemas/PostingWorkItem" });
}

/** A PoolClient stub that returns canned rows per query call, in order. */
function fakeClient(resultsInOrder: Array<{ rows: unknown[] }>): PoolClient {
  let call = 0;
  return {
    query: async () => {
      const r = resultsInOrder[call] ?? { rows: [] };
      call += 1;
      return r;
    },
  } as unknown as PoolClient;
}

const SALE_ROW = {
  id: "00000000-0000-7000-8000-00000000a5e1",
  store_id: "00000000-0000-7000-8000-00000000570e",
  currency_code: "EGP",
  pos_total: "10.0000",
  occurred_at: new Date("2026-06-06T03:58:10.122Z"),
  business_date: "2026-06-06",
  source_system: "pos-pulse",
  external_id: "RT86-SALE-0001",
};
const LINE_ROW = {
  line_ref: "00000000-0000-7000-8000-0000000011e1",
  line_name: "Line 1",
  unit_price: "5.0000",
  currency_code: "EGP",
  quantity: "2.000000",
  line_amount: "10.0000",
  tax_amount: null,
  unit: "each",
  erpnext_item_ref: "ERP-ITEM-AX",
  tenant_product_ref: "00000000-0000-7000-8000-0000000a7e01",
};
const STATUS_ROW = {
  id: "00000000-0000-7000-8000-0000000057a7",
  kind: "sale_post" as const,
  saleId: SALE_ROW.id,
  sourceRefId: SALE_ROW.id,
  sourceSystem: "pos-pulse",
  externalId: "RT86-SALE-0001",
  payloadHash: "a".repeat(64),
  sequence: "1",
};
const REVERSAL_ROW = { ...STATUS_ROW, kind: "reversal" as const, sourceRefId: "00000000-0000-7000-8000-0000000ae7e1" };
const AT = new Date("2026-06-07T10:00:00.000Z");
const RETURN_LINES = { rows: [{ line_ref: LINE_ROW.line_ref, quantity: "1.000000", line_amount: "5.0000", tax_amount: null }] };

async function project(results: Array<{ rows: unknown[] }>, row = REVERSAL_ROW) {
  return buildWorkItem(fakeClient([{ rows: [SALE_ROW] }, { rows: [LINE_ROW] }, ...results]), row);
}

describe("posting-feed.yaml — projected work items validate against PostingWorkItem (RT-86)", () => {
  const validate = workItemValidator();
  const expectValid = (item: unknown): void => {
    const ok = validate(item);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  };

  it("a return with its refund tenders", async () => {
    const item = await project([
      { rows: [{ reversal_kind: "return", recorded_at: AT, business_date: "2026-06-07" }] },
      RETURN_LINES,
      { rows: [{ method: "cash", amount: "5.0000" }] },
    ]);
    expect(item!.reversalOf).toHaveProperty("refundTenders", [{ method: "cash", amount: "5.0000" }]);
    expectValid(item);
  });

  it("a return whose tender rows are missing (field omitted, never [])", async () => {
    const item = await project([
      { rows: [{ reversal_kind: "return", recorded_at: AT, business_date: "2026-06-07" }] },
      RETURN_LINES,
      { rows: [] },
    ]);
    expectValid(item);
  });

  it("a void, a legacy refund and a sale_post (no refund tenders)", async () => {
    expectValid(await project([{ rows: [{ reversal_kind: "void", recorded_at: AT, business_date: "2026-06-07" }] }]));
    expectValid(await project([{ rows: [{ reversal_kind: "refund", recorded_at: AT, business_date: null }] }]));
    expectValid(await project([], STATUS_ROW));
  });

  it("negative controls: an empty refundTenders and refund tenders on a void are rejected", async () => {
    const ret = await project([
      { rows: [{ reversal_kind: "return", recorded_at: AT, business_date: "2026-06-07" }] },
      RETURN_LINES,
      { rows: [{ method: "cash", amount: "5.0000" }] },
    ]);
    expect(validate({ ...ret, reversalOf: { ...ret!.reversalOf, refundTenders: [] } })).toBe(false);
    const voided = await project([{ rows: [{ reversal_kind: "void", recorded_at: AT, business_date: "2026-06-07" }] }]);
    expect(
      validate({ ...voided, reversalOf: { ...voided!.reversalOf, refundTenders: [{ method: "cash", amount: "5.0000" }] } }),
    ).toBe(false);
  });
});
