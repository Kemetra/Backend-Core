/**
 * RT-77 — sale tenders + device attribution, end to end against a real
 * RLS-forced Postgres (the capture harness: real SalesController/Service,
 * real IdempotencyInterceptor, `env.app` under RLS).
 *
 * Acceptance criteria covered:
 *   - the default-off gate: tenders are refused exactly as before RT-77;
 *   - Σ mismatch → 422 `sale_tender_mismatch`, nothing recorded;
 *   - a duplicate method, and a reference on cash → 400, nothing recorded;
 *   - absent tenders = legacy behaviour (tenders [], tender_count 0);
 *   - idempotent replay, and a tender-changing replay → 409;
 *   - the device comes from the guard, never the body;
 *   - RLS: another tenant cannot see the tender rows;
 *   - the posting-feed projection for the sale and for its void, from real rows.
 * The capture/read responses are also validated against `Sale` in sales.yaml.
 */
import { resolve } from "node:path";

import { runWithTenantContext } from "@data-pulse-2/db";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { buildWorkItem } from "../../../../src/catalog/erpnext-posting/posting-work-item.projection";
import { loadOpenApiContracts } from "../../../../src/openapi/loader";
import { APP_ROLE_NAME } from "../../../_helpers/postgres-container";
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  HARNESS_DEVICE_ID,
  PRODUCT_A_ACTIVE,
  TENANT_A,
  TENANT_B,
  type HarnessHandle,
} from "../capture/__capture-harness";

const FLAG = "POS_SALE_TENDERS_ENABLED";
const h: HarnessHandle = { harness: null, dockerSkipped: false };
const ERP_ITEM_REF = "ERP-ITEM-RT77";

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
    [TENANT_A, PRODUCT_A_ACTIVE, ERP_ITEM_REF, "01900000-0000-7000-8000-0000000be077"],
  );
}, 180_000);
afterAll(async () => {
  delete process.env[FLAG];
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  process.env[FLAG] = "true";
});
afterEach(async () => {
  delete process.env[FLAG];
  if (!h.harness) return;
  const q = (sql: string) => h.harness!.env.admin.query(sql);
  const sales = "SELECT id FROM sales WHERE source_system = 'pos-1'";
  await q(`DELETE FROM sale_voids WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_tenders WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_lines WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sales WHERE source_system = 'pos-1'`);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

// captureBody() posts posTotal 12.5000 (USD).
const SPLIT = [
  { method: "cash", amount: "2.5" },
  { method: "card_external", amount: "10.0000", reference: "A1B2C3" },
];

function post(body: Record<string, unknown>, key: string) {
  return h.harness!.http().post("/api/pos/v1/sales").set("Idempotency-Key", idempKey(key)).send(body);
}

async function counts(externalId: string): Promise<{ sales: number; tenders: number }> {
  const r = await h.harness!.env.admin.query<{ sales: string; tenders: string }>(
    `SELECT (SELECT count(*) FROM sales WHERE external_id = $1)::text AS sales,
            (SELECT count(*) FROM sale_tenders t JOIN sales s ON s.id = t.sale_id
              WHERE s.external_id = $1)::text AS tenders`,
    [externalId],
  );
  return { sales: Number(r.rows[0]!.sales), tenders: Number(r.rows[0]!.tenders) };
}

describe("RT-77 — POS_SALE_TENDERS_ENABLED off (the default)", () => {
  it("a body carrying tenders is a 400, exactly as before RT-77, and nothing is recorded", async () => {
    if (skip()) return;
    delete process.env[FLAG];
    const res = await post(captureBody({ externalId: "rt77-off", tenders: SPLIT }), "rt77off");
    expect(res.status).toBe(400);
    expect(await counts("rt77-off")).toEqual({ sales: 0, tenders: 0 });
  });

  it("a legacy body still captures, and reads back tender-unknown", async () => {
    if (skip()) return;
    delete process.env[FLAG];
    const res = await post(captureBody({ externalId: "rt77-off-legacy" }), "rt77offl");
    expect(res.status).toBe(201);
    expect(res.body.tenders).toEqual([]);
  });
});

describe("RT-77 — capture with tenders (gate on)", () => {
  it("records a split tender in the capture transaction and returns it (method order)", async () => {
    if (skip()) return;
    const res = await post(captureBody({ externalId: "rt77-split", tenders: SPLIT }), "rt77split");
    expect(res.status).toBe(201);
    expect(res.body.tenders).toEqual([
      { method: "card_external", amount: "10.0000", reference: "A1B2C3" },
      { method: "cash", amount: "2.5000" },
    ]);
    expectValidSale(res.body);

    const stored = await h.harness!.env.admin.query<{
      method: string;
      currency_code: string;
      tender_count: number;
      device_id: string;
    }>(
      `SELECT t.method, t.currency_code, s.tender_count, s.device_id
         FROM sale_tenders t JOIN sales s ON s.id = t.sale_id
        WHERE s.id = $1 ORDER BY t.method`,
      [res.body.saleRef],
    );
    expect(stored.rows).toEqual([
      { method: "card_external", currency_code: "USD", tender_count: 2, device_id: HARNESS_DEVICE_ID },
      { method: "cash", currency_code: "USD", tender_count: 2, device_id: HARNESS_DEVICE_ID },
    ]);

    const read = await h.harness!.http().get(`/api/pos/v1/sales/${res.body.saleRef}`);
    expect(read.status).toBe(200);
    expect(read.body.tenders).toEqual(res.body.tenders);
    expectValidSale(read.body);
  });

  it("Σ tenders ≠ posTotal → 422 sale_tender_mismatch, nothing recorded", async () => {
    if (skip()) return;
    const res = await post(
      captureBody({ externalId: "rt77-sigma", tenders: [{ method: "cash", amount: "12.4999" }] }),
      "rt77sigma",
    );
    expect(res.status).toBe(422);
    expect(res.body.error?.code ?? res.body.code).toBe("sale_tender_mismatch");
    expect(await counts("rt77-sigma")).toEqual({ sales: 0, tenders: 0 });
  });

  it("a duplicate method → 400, nothing recorded", async () => {
    if (skip()) return;
    const res = await post(
      captureBody({
        externalId: "rt77-dup",
        tenders: [
          { method: "cash", amount: "6.25" },
          { method: "cash", amount: "6.25" },
        ],
      }),
      "rt77dup",
    );
    expect(res.status).toBe(400);
    expect(await counts("rt77-dup")).toEqual({ sales: 0, tenders: 0 });
  });

  it("a reference is card_external only → a reference on cash is 400", async () => {
    if (skip()) return;
    const res = await post(
      captureBody({
        externalId: "rt77-cashref",
        tenders: [{ method: "cash", amount: "12.5", reference: "A1B2C3" }],
      }),
      "rt77cashref",
    );
    expect(res.status).toBe(400);
    expect(await counts("rt77-cashref")).toEqual({ sales: 0, tenders: 0 });
  });

  it("absent tenders = legacy behaviour: tender-unknown, tender_count 0, device still attributed", async () => {
    if (skip()) return;
    const res = await post(captureBody({ externalId: "rt77-legacy" }), "rt77legacy");
    expect(res.status).toBe(201);
    expect(res.body.tenders).toEqual([]);
    expectValidSale(res.body);
    const s = await h.harness!.env.admin.query<{ tender_count: number; device_id: string }>(
      `SELECT tender_count, device_id FROM sales WHERE id = $1`,
      [res.body.saleRef],
    );
    expect(s.rows[0]).toEqual({ tender_count: 0, device_id: HARNESS_DEVICE_ID });
  });
});

describe("RT-77 — idempotent replay and the tender conflict", () => {
  it("a same-provenance replay (new Idempotency-Key) with the same tenders → 200 replay, same sale", async () => {
    if (skip()) return;
    const first = await post(captureBody({ externalId: "rt77-rep", tenders: SPLIT }), "rt77rep1");
    expect(first.status).toBe(201);
    // "2.5000" and "10" are the same numeric amounts in a different order.
    const again = await post(
      captureBody({
        externalId: "rt77-rep",
        tenders: [
          { method: "card_external", amount: "10", reference: "A1B2C3" },
          { method: "cash", amount: "2.5000" },
        ],
      }),
      "rt77rep2",
    );
    expect(again.status).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body.saleRef).toBe(first.body.saleRef);
    expect(again.body.tenders).toEqual(first.body.tenders);
    expect(await counts("rt77-rep")).toEqual({ sales: 1, tenders: 2 });
  });

  it.each([
    ["changes an amount", [{ method: "cash", amount: "12.5" }]],
    ["drops the tenders", undefined],
    ["changes the reference", [
      { method: "cash", amount: "2.5" },
      { method: "card_external", amount: "10", reference: "ZZZ999" },
    ]],
  ])("a same-provenance replay that %s → 409, nothing changes", async (label, tenders) => {
    if (skip()) return;
    const ext = `rt77-conf-${label.replace(/\W+/g, "-")}`;
    const first = await post(captureBody({ externalId: ext, tenders: SPLIT }), `${ext}a`);
    expect(first.status).toBe(201);
    const replay = await post(
      captureBody({ externalId: ext, ...(tenders === undefined ? {} : { tenders }) }),
      `${ext}b`,
    );
    expect(replay.status).toBe(409);
    expect(replay.body.error?.code ?? replay.body.code).toBe("idempotency_key_conflict");
    expect(await counts(ext)).toEqual({ sales: 1, tenders: 2 });
  });

  it("a replay that adds tenders to a tender-unknown sale → 409", async () => {
    if (skip()) return;
    const first = await post(captureBody({ externalId: "rt77-add" }), "rt77add1");
    expect(first.status).toBe(201);
    const replay = await post(captureBody({ externalId: "rt77-add", tenders: SPLIT }), "rt77add2");
    expect(replay.status).toBe(409);
    expect(await counts("rt77-add")).toEqual({ sales: 1, tenders: 0 });
  });

  it("a tender-unknown replay of a tender-unknown sale is still a 200 (legacy replay unchanged)", async () => {
    if (skip()) return;
    expect((await post(captureBody({ externalId: "rt77-lrep" }), "rt77lrep1")).status).toBe(201);
    const again = await post(captureBody({ externalId: "rt77-lrep" }), "rt77lrep2");
    expect(again.status).toBe(200);
  });
});

describe("RT-77 — device attribution is the guard's, never the body's", () => {
  it("a deviceId in the body is rejected (strict body, mass-assignment ban)", async () => {
    if (skip()) return;
    const res = await post(
      captureBody({ externalId: "rt77-devbody", deviceId: "0d000000-0000-7000-8000-0000000007ff" }),
      "rt77devbody",
    );
    expect(res.status).toBe(400);
    expect(await counts("rt77-devbody")).toEqual({ sales: 0, tenders: 0 });
  });

  it("a request the guard resolved to no device → 401, nothing recorded", async () => {
    if (skip()) return;
    h.harness!.contextGuard.deviceId = null;
    const res = await post(captureBody({ externalId: "rt77-nodev" }), "rt77nodev");
    expect(res.status).toBe(401);
    expect(await counts("rt77-nodev")).toEqual({ sales: 0, tenders: 0 });
  });
});

describe("RT-77 — the legacy path does not depend on the sale_tenders grant", () => {
  // Production grants the domain role on new tables outside migrations. Until
  // that grant lands, a tender-unknown capture / read / replay / feed pull must
  // work exactly as before RT-77: they short-circuit on sales.tender_count = 0.
  it("with no privilege on sale_tenders: legacy capture, read, replay and feed projection still work", async () => {
    if (skip()) return;
    delete process.env[FLAG];
    const admin = h.harness!.env.admin;
    await admin.query(`REVOKE ALL ON sale_tenders FROM ${APP_ROLE_NAME}`);
    try {
      const mapped = captureBody({
        externalId: "rt77-nogrant",
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
      });
      const first = await post(mapped, "rt77ng1");
      expect(first.status).toBe(201);
      expect(first.body.tenders).toEqual([]);
      const replay = await post(mapped, "rt77ng2");
      expect(replay.status).toBe(200);
      const read = await h.harness!.http().get(`/api/pos/v1/sales/${first.body.saleRef}`);
      expect(read.status).toBe(200);
      const item = await runWithTenantContext(
        h.harness!.env.app,
        { tenantId: TENANT_A, isPlatformAdmin: false },
        (client) =>
          buildWorkItem(client, {
            id: "01900000-0000-7000-8000-0000000b7e78",
            kind: "sale_post",
            saleId: first.body.saleRef,
            sourceRefId: first.body.saleRef,
            sourceSystem: "pos-1",
            externalId: "rt77-nogrant",
            payloadHash: "a".repeat(64),
            sequence: "1",
          }),
      );
      expect(item).not.toBeNull();
      expect(item!.sale).not.toHaveProperty("tenders");
    } finally {
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON sale_tenders TO ${APP_ROLE_NAME}`);
    }
  });
});

describe("RT-77 — RLS: tender rows are tenant-isolated", () => {
  it("another tenant's GUC sees none of the tender rows; the owner's sees them", async () => {
    if (skip()) return;
    const res = await post(captureBody({ externalId: "rt77-rls", tenders: SPLIT }), "rt77rls");
    expect(res.status).toBe(201);
    const visible = (tenantId: string) =>
      runWithTenantContext(h.harness!.env.app, { tenantId, isPlatformAdmin: false }, async (c) => {
        const r = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM sale_tenders WHERE sale_id = $1`,
          [res.body.saleRef],
        );
        return Number(r.rows[0]!.n);
      });
    expect(await visible(TENANT_B)).toBe(0);
    expect(await visible(TENANT_A)).toBe(2);
  });
});

describe("RT-77 — posting-feed projection from real rows", () => {
  function project(saleRef: string, kind: "sale_post" | "reversal", sourceRefId: string) {
    return runWithTenantContext(
      h.harness!.env.app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      (client) =>
        buildWorkItem(client, {
          id: "01900000-0000-7000-8000-0000000b7e77",
          kind,
          saleId: saleRef,
          sourceRefId,
          sourceSystem: "pos-1",
          externalId: "rt77-provenance",
          payloadHash: "a".repeat(64),
          sequence: "1",
        }),
    );
  }

  function mappedBody(externalId: string, tenders?: unknown[]): Record<string, unknown> {
    return captureBody({
      externalId,
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
      ...(tenders === undefined ? {} : { tenders }),
    });
  }

  const FEED_TENDERS = [
    { method: "card_external", amount: "5.0000", reference: "Q7" },
    { method: "cash", amount: "4.0000" },
  ];

  it("the sale_post carries sale.tenders; its void carries the ORIGINAL tenders for mirroring", async () => {
    if (skip()) return;
    const cap = await post(
      mappedBody("rt77-feed", [
        { method: "cash", amount: "4" },
        { method: "card_external", amount: "5", reference: "Q7" },
      ]),
      "rt77feed",
    );
    expect(cap.status).toBe(201);
    const saleRef = cap.body.saleRef as string;

    const salePost = await project(saleRef, "sale_post", saleRef);
    expect(salePost!.sale.tenders).toEqual(FEED_TENDERS);
    expect(await project(saleRef, "sale_post", saleRef)).toEqual(salePost);

    const v = await h
      .harness!.http()
      .post(`/api/pos/v1/sales/${saleRef}/void`)
      .set("Idempotency-Key", idempKey("rt77feedvoid"))
      .send({ sourceSystem: "pos-1", externalId: "rt77-feed-void" });
    expect(v.status).toBe(201);
    const voided = await project(saleRef, "reversal", v.body.eventRef);
    expect(voided!.reversalOf!.reversalKind).toBe("void");
    expect(voided!.reversalOf).not.toHaveProperty("refundTenders");
    expect(voided!.sale.tenders).toEqual(FEED_TENDERS);
  });

  it("a tender-unknown sale omits sale.tenders (the pre-RT-77 work item, unchanged)", async () => {
    if (skip()) return;
    const cap = await post(mappedBody("rt77-feed-unknown"), "rt77feedu");
    expect(cap.status).toBe(201);
    const item = await project(cap.body.saleRef, "sale_post", cap.body.saleRef);
    expect(item!.sale).not.toHaveProperty("tenders");
  });
});
