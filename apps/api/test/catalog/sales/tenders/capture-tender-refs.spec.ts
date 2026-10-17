/**
 * RT-360 — tender-line identity end to end against a real RLS-forced Postgres
 * (contract RT-359; decisions RT-264 D1–D4). Same capture harness as RT-77's
 * capture-tenders.spec.
 *
 *   - a same-method split tender (both gates on) is recorded with its
 *     tenderRef / sequence, and read back in `sequence` order;
 *   - a replay is compared tender by tender, refs included: the same refs in
 *     any order replay (200); a changed ref, or amounts swapped between refs,
 *     is a different payload (409);
 *   - the posting feed carries tenderRef / sequence, ordered by `sequence`;
 *   - a ref-less sale reads back exactly as before (no tenderRef / sequence keys).
 * The capture/read responses are validated against `Sale` in sales.yaml.
 */
import { resolve } from "node:path";

import { runWithTenantContext } from "@data-pulse-2/db";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { buildWorkItem } from "../../../../src/catalog/erpnext-posting/posting-work-item.projection";
import { loadOpenApiContracts } from "../../../../src/openapi/loader";
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  PRODUCT_A_ACTIVE,
  TENANT_A,
  type HarnessHandle,
} from "../capture/__capture-harness";

const TENDERS_FLAG = "POS_SALE_TENDERS_ENABLED";
const SAME_METHOD_FLAG = "POS_SALE_TENDERS_SAME_METHOD_ENABLED";
const h: HarnessHandle = { harness: null, dockerSkipped: false };
const ERP_ITEM_REF = "ERP-ITEM-RT360";

const REF_A = "3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const REF_B = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const REF_C = "9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f";

const SALES_DIR = resolve(__dirname, "..", "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "pos-sales");

function saleValidator(): ValidateFunction {
  const contract = loadOpenApiContracts({ dir: SALES_DIR }).find((c) => c.id === "sales");
  if (!contract) throw new Error("pos-sales/sales.yaml not found");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(contract.document as object), $id: "sales" });
  return ajv.compile({ $ref: "sales#/components/schemas/Sale" });
}
const validateSale = saleValidator();

function expectValidSale(body: unknown): void {
  const ok = validateSale(body);
  expect(validateSale.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
  if (!h.harness) return;
  await h.harness.env.admin.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
        suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', 'manual', $4, now())
     ON CONFLICT DO NOTHING`,
    [TENANT_A, PRODUCT_A_ACTIVE, ERP_ITEM_REF, "01900000-0000-7000-8000-0000000be360"],
  );
}, 180_000);
afterAll(async () => {
  delete process.env[TENDERS_FLAG];
  delete process.env[SAME_METHOD_FLAG];
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  process.env[TENDERS_FLAG] = "true";
  process.env[SAME_METHOD_FLAG] = "true";
});
afterEach(async () => {
  delete process.env[TENDERS_FLAG];
  delete process.env[SAME_METHOD_FLAG];
  if (!h.harness) return;
  const q = (sql: string) => h.harness!.env.admin.query(sql);
  const sales = "SELECT id FROM sales WHERE source_system = 'pos-1'";
  await q(`DELETE FROM sale_voids WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_approval_uses`); // RT-577 (0054): the shared approval-use ledger.
  await q(`DELETE FROM sale_tenders WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_lines WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sales WHERE source_system = 'pos-1'`);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

// captureBody() posts posTotal 12.5000 (USD). Sent out of sequence order on purpose.
const SPLIT_CASH = [
  { method: "cash", amount: "5", tenderRef: REF_B, sequence: 2 },
  { method: "cash", amount: "7.5", tenderRef: REF_A, sequence: 1 },
];
const SPLIT_CASH_OUT = [
  { method: "cash", amount: "7.5000", tenderRef: REF_A, sequence: 1 },
  { method: "cash", amount: "5.0000", tenderRef: REF_B, sequence: 2 },
];

function post(body: Record<string, unknown>, key: string) {
  return h.harness!.http().post("/api/pos/v1/sales").set("Idempotency-Key", idempKey(key)).send(body);
}

async function tenderRows(saleRef: string) {
  return (
    await h.harness!.env.admin.query<{ method: string; tender_ref: string | null; sequence: number | null }>(
      `SELECT method, tender_ref, sequence FROM sale_tenders WHERE sale_id = $1 ORDER BY sequence`,
      [saleRef],
    )
  ).rows;
}

describe("RT-360 — a same-method split tender", () => {
  it("is recorded with its refs and read back in sequence order", async () => {
    if (skip()) return;
    const res = await post(captureBody({ externalId: "rt360-split", tenders: SPLIT_CASH }), "rt360split");
    expect(res.status).toBe(201);
    expect(res.body.tenders).toEqual(SPLIT_CASH_OUT);
    expectValidSale(res.body);
    expect(await tenderRows(res.body.saleRef)).toEqual([
      { method: "cash", tender_ref: REF_A, sequence: 1 },
      { method: "cash", tender_ref: REF_B, sequence: 2 },
    ]);

    const read = await h.harness!.http().get(`/api/pos/v1/sales/${res.body.saleRef}`);
    expect(read.status).toBe(200);
    expect(read.body.tenders).toEqual(SPLIT_CASH_OUT);
    expectValidSale(read.body);
  });

  it("is a 400 while the same-method gate is off, and nothing is recorded", async () => {
    if (skip()) return;
    delete process.env[SAME_METHOD_FLAG];
    const res = await post(captureBody({ externalId: "rt360-off", tenders: SPLIT_CASH }), "rt360off");
    expect(res.status).toBe(400);
    const n = await h.harness!.env.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sales WHERE external_id = 'rt360-off'`,
    );
    expect(n.rows[0]?.n).toBe("0");
  });

  it("a ref-less sale reads back exactly as before (no tenderRef / sequence keys)", async () => {
    if (skip()) return;
    const res = await post(
      captureBody({ externalId: "rt360-legacy", tenders: [{ method: "cash", amount: "12.5" }] }),
      "rt360legacy",
    );
    expect(res.status).toBe(201);
    expect(res.body.tenders).toEqual([{ method: "cash", amount: "12.5000" }]);
  });
});

describe("RT-360 — replay compares tender by tender, refs included", () => {
  it("the same refs in another body order → 200 replay, same sale", async () => {
    if (skip()) return;
    const first = await post(captureBody({ externalId: "rt360-rep", tenders: SPLIT_CASH }), "rt360rep1");
    expect(first.status).toBe(201);
    const again = await post(
      captureBody({ externalId: "rt360-rep", tenders: [SPLIT_CASH[1], SPLIT_CASH[0]] }),
      "rt360rep2",
    );
    expect(again.status).toBe(200);
    expect(again.body.saleRef).toBe(first.body.saleRef);
    expect(again.body.tenders).toEqual(SPLIT_CASH_OUT);
  });

  it.each([
    [
      "changes a tenderRef",
      [
        { method: "cash", amount: "7.5", tenderRef: REF_A, sequence: 1 },
        { method: "cash", amount: "5", tenderRef: REF_C, sequence: 2 },
      ],
    ],
    [
      "swaps the amounts between the refs",
      [
        { method: "cash", amount: "5", tenderRef: REF_A, sequence: 1 },
        { method: "cash", amount: "7.5", tenderRef: REF_B, sequence: 2 },
      ],
    ],
    [
      "swaps the sequences",
      [
        { method: "cash", amount: "7.5", tenderRef: REF_A, sequence: 2 },
        { method: "cash", amount: "5", tenderRef: REF_B, sequence: 1 },
      ],
    ],
  ])("a replay that %s → 409, nothing changes", async (label, tenders) => {
    if (skip()) return;
    const ext = `rt360-conf-${label.replace(/\W+/g, "-")}`;
    const first = await post(captureBody({ externalId: ext, tenders: SPLIT_CASH }), `${ext}a`);
    expect(first.status).toBe(201);
    const replay = await post(captureBody({ externalId: ext, tenders }), `${ext}b`);
    expect(replay.status).toBe(409);
    expect(await tenderRows(first.body.saleRef)).toEqual([
      { method: "cash", tender_ref: REF_A, sequence: 1 },
      { method: "cash", tender_ref: REF_B, sequence: 2 },
    ]);
  });
});

describe("RT-360 — posting feed carries the tender-line identity", () => {
  it("orders the sale_post tenders by sequence, with tenderRef and sequence", async () => {
    if (skip()) return;
    const cap = await post(
      captureBody({
        externalId: "rt360-feed",
        posTotal: "9.0000",
        lines: [
          {
            lineName: "Mapped widget",
            unitPrice: "3.0000",
            currencyCode: "USD",
            quantity: "3",
            lineAmount: "9.0000",
            unit: "ea",
            tenantProductRef: PRODUCT_A_ACTIVE,
          },
        ],
        tenders: [
          { method: "cash", amount: "4", tenderRef: REF_B, sequence: 2 },
          { method: "cash", amount: "5", tenderRef: REF_A, sequence: 1 },
        ],
      }),
      "rt360feed",
    );
    expect(cap.status).toBe(201);
    const saleRef = cap.body.saleRef as string;
    const item = await runWithTenantContext(
      h.harness!.env.app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      (client) =>
        buildWorkItem(client, {
          id: "01900000-0000-7000-8000-0000000b7360",
          kind: "sale_post",
          saleId: saleRef,
          sourceRefId: saleRef,
          sourceSystem: "pos-1",
          externalId: "rt360-provenance",
          payloadHash: "a".repeat(64),
          sequence: "1",
        }),
    );
    expect(item!.sale.tenders).toEqual([
      { method: "cash", amount: "5.0000", tenderRef: REF_A, sequence: 1 },
      { method: "cash", amount: "4.0000", tenderRef: REF_B, sequence: 2 },
    ]);
  });
});
