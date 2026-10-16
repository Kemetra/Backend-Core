/**
 * RT-418 — payer responsibility lines on the posting feed (contract RT-417,
 * `erpnext-connector/posting-feed.yaml` 1.8.0-draft), against a real
 * RLS-forced Postgres through the real `ErpnextPostingService`.
 *
 *   - the ROLLOUT ORDER hold: a responsibility-bearing `sale_post` is not
 *     offered until `ERPNEXT_FEED_RESPONSIBILITIES_ENABLED` is on (a deploy
 *     step after the Connector supports RT-419);
 *   - the reversal hold: a `reversal` of such a sale is never offered in this
 *     version, and its `sale_post` is held while a void / refund / return of
 *     the sale exists (a credit sale voided before posting never posts alone);
 *   - when offered: `sale.responsibilities[{payerExternalRef, amount, sequence}]`,
 *     `payerExternalRef` from the FROZEN resolution (not the live payer row),
 *     `payloadHash` unchanged, every re-pull identical, the work item valid
 *     against `PostingWorkItem`;
 *   - an unlinked payer is offered with `payerExternalRef: null` (the Connector
 *     fails closed): never omitted, never the store Customer;
 *   - a sale without responsibilities is unchanged (no `responsibilities` key);
 *   - fail closed (coordinator condition): a sale whose
 *     `responsibility_count` says it has responsibilities the feed cannot see
 *     (RLS, grant or a missing row) stays HELD, never offered as cash; the
 *     projection keeps a second guard that throws;
 *   - regression: a sale without responsibilities produces the same work item
 *     with the gate on or off, with exactly the pre-RT-418 keys.
 *
 * Docker policy mirrors posting-feed.spec: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { ErpnextPostingService } from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import { buildWorkItem, type PostingWorkItem } from "../../../../src/catalog/erpnext-posting/posting-work-item.projection";
import { SaleResponsibilitiesNotVisibleError } from "../../../../src/catalog/sales/sale-responsibilities";
import { loadOpenApiContracts } from "../../../../src/openapi/loader";
import { runWithTenantContext } from "@data-pulse-2/db";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../../_helpers/postgres-container";
import { ACTOR_A, seedCatalogIsolationFixture, STORE_A_X, TENANT_A } from "../../__support__/isolation-harness";

const FLAG = "ERPNEXT_FEED_RESPONSIBILITIES_ENABLED";

/** A stable hex payload hash per sale provenance. */
const hashOf = (externalId: string): string => createHash("sha256").update(externalId).digest("hex");

const P_LINKED = "0a000000-0000-7000-8000-0000004188a1";
const P_UNLINKED = "0a000000-0000-7000-8000-0000004188a2";

const S_CASH = "0a000000-0000-7000-8000-0000004189a1";
const S_CREDIT = "0a000000-0000-7000-8000-0000004189a2";
const S_VOIDED = "0a000000-0000-7000-8000-0000004189a3";
const S_RETURNED = "0a000000-0000-7000-8000-0000004189a4";
const S_UNLINKED = "0a000000-0000-7000-8000-0000004189a5";
const S_HIDDEN = "0a000000-0000-7000-8000-0000004189a6";

const VOID_ID = "0a000000-0000-7000-8000-000000418aa1";
const RETURN_ID = "0a000000-0000-7000-8000-000000418aa2";

// Posting rows, in sequence order (the insertion order below).
const W_CREDIT = "0a000000-0000-7000-8000-000000418ba1";
const W_VOIDED_POST = "0a000000-0000-7000-8000-000000418ba2";
const W_VOIDED_REVERSAL = "0a000000-0000-7000-8000-000000418ba3";
const W_RETURNED_POST = "0a000000-0000-7000-8000-000000418ba4";
const W_UNLINKED = "0a000000-0000-7000-8000-000000418ba5";
const W_CASH = "0a000000-0000-7000-8000-000000418ba6";
const W_HIDDEN = "0a000000-0000-7000-8000-000000418ba7";

let env: PgTestEnv | null = null;
let skip = false;

const FEED_DIR = resolve(__dirname, "..", "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "erpnext-connector");

function workItemValidator(): ValidateFunction {
  const contract = loadOpenApiContracts({ dir: FEED_DIR }).find((c) => c.id === "posting-feed");
  if (!contract) throw new Error("erpnext-connector/posting-feed.yaml not found");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(contract.document as object), $id: "feed" });
  return ajv.compile({ $ref: "feed#/components/schemas/PostingWorkItem" });
}
const validateWorkItem = workItemValidator();

async function seedSale(id: string, externalId: string, opts: { responsibilities: number }): Promise<string> {
  const a = env!.admin;
  await a.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by, responsibility_count)
     VALUES ($1, $2, $3, 'EGP', 10, '2026-10-16T10:00:00Z', '2026-10-16', 'pos-418', $4, $5, $6, $7)`,
    [id, TENANT_A, STORE_A_X, externalId, hashOf(externalId), ACTOR_A, opts.responsibilities],
  );
  const line = await a.query<{ id: string }>(
    `INSERT INTO sale_lines
       (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity, line_amount, unit)
     VALUES (gen_random_uuid(), $1, $2, $3, 'Widget', 10, 'EGP', 1, 10, 'ea') RETURNING id`,
    [id, TENANT_A, STORE_A_X],
  );
  return line.rows[0]!.id;
}

async function seedResponsibility(saleId: string, payerId: string): Promise<void> {
  await env!.admin.query(
    `INSERT INTO sale_responsibilities (tenant_id, store_id, sale_id, payer_id, amount, sequence)
     VALUES ($1, $2, $3, $4, 10, 1)`,
    [TENANT_A, STORE_A_X, saleId, payerId],
  );
}

async function seedPosting(
  id: string,
  saleId: string,
  externalId: string,
  opts: { kind?: "sale_post" | "reversal"; sourceRefId?: string; lineId: string; frozenPayerRef?: string | null; frozen?: boolean },
): Promise<void> {
  const a = env!.admin;
  await a.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id, payload_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pos-418', $7, $8, 'pending')`,
    [id, TENANT_A, STORE_A_X, saleId, opts.kind ?? "sale_post", opts.sourceRefId ?? saleId, externalId, hashOf(externalId)],
  );
  if (opts.frozen === false) return;
  await a.query(
    `INSERT INTO erpnext_posting_resolution
       (tenant_id, intent_id, resolution_version, sale_line_id, erpnext_item_ref, item_map_id,
        warehouse_ref, warehouse_map_id, resolved_by, payer_external_ref)
     VALUES ($1, $2, 1, $3, 'ERP-ITEM-418', gen_random_uuid(), 'ERP-WH-418', gen_random_uuid(), 'system', $4)`,
    [TENANT_A, id, opts.lineId, opts.frozenPayerRef ?? null],
  );
  await a.query(`UPDATE erpnext_posting_status SET current_resolution_version = 1 WHERE id = $1`, [id]);
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    const a = env.admin;
    // The live link differs from the frozen one: the feed must read the frozen value.
    await a.query(
      `INSERT INTO payer_account (id, tenant_id, store_id, category, display_name, external_ref) VALUES
         ($1, $3, NULL, 'credit_customer', 'House', 'CUST-LIVE'),
         ($2, $3, NULL, 'insurer',         'Unlinked', NULL)`,
      [P_LINKED, P_UNLINKED, TENANT_A],
    );
    const lCredit = await seedSale(S_CREDIT, "rt418-credit", { responsibilities: 1 });
    await seedResponsibility(S_CREDIT, P_LINKED);
    const lVoided = await seedSale(S_VOIDED, "rt418-voided", { responsibilities: 1 });
    await seedResponsibility(S_VOIDED, P_LINKED);
    await a.query(
      `INSERT INTO sale_voids (id, sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, $4, '2026-10-16', 'pos-418', 'rt418-void', $5, $6)`,
      [VOID_ID, S_VOIDED, TENANT_A, STORE_A_X, "v".repeat(64), ACTOR_A],
    );
    const lReturned = await seedSale(S_RETURNED, "rt418-returned", { responsibilities: 1 });
    await seedResponsibility(S_RETURNED, P_LINKED);
    await a.query(
      `INSERT INTO sale_returns
         (id, sale_id, tenant_id, store_id, return_seq, business_date, currency_code, return_total,
          source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, $4, 1, '2026-10-16', 'EGP', 10, 'pos-418', 'rt418-return', $5, $6)`,
      [RETURN_ID, S_RETURNED, TENANT_A, STORE_A_X, "r".repeat(64), ACTOR_A],
    );
    const lUnlinked = await seedSale(S_UNLINKED, "rt418-unlinked", { responsibilities: 1 });
    await seedResponsibility(S_UNLINKED, P_UNLINKED);
    const lCash = await seedSale(S_CASH, "rt418-cash", { responsibilities: 0 });

    await seedPosting(W_CREDIT, S_CREDIT, "rt418-credit", { lineId: lCredit, frozenPayerRef: "CUST-FROZEN" });
    await seedPosting(W_VOIDED_POST, S_VOIDED, "rt418-voided", { lineId: lVoided, frozenPayerRef: "CUST-FROZEN" });
    await seedPosting(W_VOIDED_REVERSAL, S_VOIDED, "rt418-void", {
      kind: "reversal",
      sourceRefId: VOID_ID,
      lineId: lVoided,
      frozenPayerRef: "CUST-FROZEN",
    });
    await seedPosting(W_RETURNED_POST, S_RETURNED, "rt418-returned", { lineId: lReturned, frozenPayerRef: "CUST-FROZEN" });
    // A pre-0049-style row with no frozen resolution: the live (null) link is read.
    await seedPosting(W_UNLINKED, S_UNLINKED, "rt418-unlinked", { lineId: lUnlinked, frozen: false });
    await a.query(
      `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       SELECT gen_random_uuid(), $1, tp.id, 'ERP-ITEM-LIVE', 'confirmed', 'manual', $2, now()
         FROM tenant_products tp WHERE tp.tenant_id = $1 LIMIT 1`,
      [TENANT_A, ACTOR_A],
    );
    await a.query(
      `UPDATE sale_lines SET tenant_product_ref = (SELECT tenant_product_id FROM erpnext_item_map WHERE erpnext_item_ref = 'ERP-ITEM-LIVE')
        WHERE sale_id = $1`,
      [S_UNLINKED],
    );
    await seedPosting(W_CASH, S_CASH, "rt418-cash", { lineId: lCash });
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-feed-responsibilities.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 240_000);

afterAll(async () => {
  delete process.env[FLAG];
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(() => {
  delete process.env[FLAG];
});

async function pull(): Promise<{ items: PostingWorkItem[]; cursor: string | null }> {
  const page = await new ErpnextPostingService(env!.app).pullPostings({ tenantId: TENANT_A, since: null, limit: 500 });
  return { items: [...page.items], cursor: page.cursor };
}

const refs = (items: readonly PostingWorkItem[]): string[] => items.map((i) => i.workItemRef);
const byRef = (items: readonly PostingWorkItem[], ref: string): PostingWorkItem | undefined =>
  items.find((i) => i.workItemRef === ref);

describe("RT-418 — the posting feed holds (gate off, the default)", () => {
  it("offers the cash sale and holds every responsibility-bearing work item", async () => {
    if (skip) return;
    const { items } = await pull();
    expect(refs(items)).toEqual([W_CASH]);
    expect(Object.hasOwn(byRef(items, W_CASH)!.sale, "responsibilities")).toBe(false);
    validateWorkItem(byRef(items, W_CASH));
    expect(validateWorkItem.errors ?? []).toEqual([]);
  });
});

describe("RT-418 — the posting feed with the Connector gate on", () => {
  beforeEach(() => {
    process.env[FLAG] = "true";
  });

  it("offers the credit sale with its frozen payerExternalRef and an unchanged payloadHash", async () => {
    if (skip) return;
    const { items } = await pull();
    const credit = byRef(items, W_CREDIT);
    expect(credit).toBeDefined();
    expect(credit!.sale.responsibilities).toEqual([{ payerExternalRef: "CUST-FROZEN", amount: "10.0000", sequence: 1 }]);
    expect(credit!.payloadHash).toBe(hashOf("rt418-credit"));
    const ok = validateWorkItem(credit);
    expect(validateWorkItem.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("offers an unlinked payer's sale with payerExternalRef null: never omitted, never the store Customer", async () => {
    if (skip) return;
    const { items } = await pull();
    const unlinked = byRef(items, W_UNLINKED);
    expect(unlinked).toBeDefined();
    expect(unlinked!.sale.responsibilities).toEqual([{ payerExternalRef: null, amount: "10.0000", sequence: 1 }]);
    validateWorkItem(unlinked);
    expect(validateWorkItem.errors ?? []).toEqual([]);
  });

  it("still holds a reversal of a credit sale, and the sale_post of a voided or returned credit sale", async () => {
    if (skip) return;
    const { items } = await pull();
    expect(refs(items)).toEqual([W_CREDIT, W_UNLINKED, W_CASH]);
  });

  it("every re-pull is identical", async () => {
    if (skip) return;
    const first = await pull();
    const second = await pull();
    expect(second).toEqual(first);
  });

  describe("a responsibility the feed cannot see (count 1, no visible row)", () => {
    let hiddenLine = "";
    beforeAll(async () => {
      if (skip) return;
      hiddenLine = await seedSale(S_HIDDEN, "rt418-hidden", { responsibilities: 1 });
      await seedPosting(W_HIDDEN, S_HIDDEN, "rt418-hidden", { lineId: hiddenLine, frozenPayerRef: "CUST-FROZEN" });
    });
    afterAll(async () => {
      if (skip) return;
      await env!.admin.query(`DELETE FROM erpnext_posting_resolution WHERE intent_id = $1`, [W_HIDDEN]);
      await env!.admin.query(`DELETE FROM erpnext_posting_status WHERE id = $1`, [W_HIDDEN]);
      await env!.admin.query(`DELETE FROM sale_lines WHERE sale_id = $1`, [S_HIDDEN]);
      await env!.admin.query(`DELETE FROM sales WHERE id = $1`, [S_HIDDEN]);
    });

    it("stays HELD: the pull excludes it, never offers it as cash, and still offers the rest", async () => {
      if (skip) return;
      const { items } = await pull();
      expect(refs(items)).toEqual([W_CREDIT, W_UNLINKED, W_CASH]);
      expect(byRef(items, W_HIDDEN)).toBeUndefined();
    });

    it("the projection's second guard throws rather than build it without its responsibilities", async () => {
      if (skip) return;
      const build = runWithTenantContext(env!.app, { tenantId: TENANT_A, isPlatformAdmin: false }, (client) =>
        buildWorkItem(client, {
          id: W_HIDDEN,
          kind: "sale_post",
          saleId: S_HIDDEN,
          sourceRefId: S_HIDDEN,
          sourceSystem: "pos-418",
          externalId: "rt418-hidden",
          payloadHash: hashOf("rt418-hidden"),
          sequence: "1",
          currentResolutionVersion: 1,
        }),
      );
      await expect(build).rejects.toBeInstanceOf(SaleResponsibilitiesNotVisibleError);
    });
  });

  it("regression: a sale without responsibilities is the same work item with the gate on or off", async () => {
    if (skip) return;
    const on = byRef((await pull()).items, W_CASH);
    delete process.env[FLAG];
    const off = byRef((await pull()).items, W_CASH);
    expect(on).toEqual(off);
    expect(Object.keys(on!.sale).sort()).toEqual(
      ["saleRef", "storeId", "currencyCode", "posTotal", "occurredAt", "businessDate", "sourceSystem", "externalId", "lines", "warehouseRef"].sort(),
    );
  });
});

describe("RT-418 — the hold-lift re-head (docs/operations/sql/sale-responsibilities-feed-rehead.sql)", () => {
  const REHEAD = resolve(__dirname, "..", "..", "..", "..", "..", "..", "docs", "operations", "sql", "sale-responsibilities-feed-rehead.sql");

  /** The script without its psql meta-commands (\set, \echo), run as the superuser like the migration owner. */
  async function runRehead(): Promise<void> {
    const sql = readFileSync(REHEAD, "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("\\"))
      .join("\n");
    await env!.admin.query(sql);
  }

  async function sequenceOf(id: string): Promise<bigint> {
    const r = await env!.admin.query<{ s: string }>(`SELECT sequence::text AS s FROM erpnext_posting_status WHERE id = $1`, [id]);
    return BigInt(r.rows[0]!.s);
  }

  it("re-heads only the gate-held credit sale_post rows, so a Connector past them sees them again", async () => {
    if (skip) return;
    process.env[FLAG] = "true";
    // A Connector whose cursor already moved past every seeded row (the cash sale is last).
    const cursor = await sequenceOf(W_CASH);
    const before = (await new ErpnextPostingService(env!.app).pullPostings({ tenantId: TENANT_A, since: cursor, limit: 500 })).items;
    expect(refs(before)).toEqual([]);
    const reversalBefore = await sequenceOf(W_VOIDED_REVERSAL);
    const voidedPostBefore = await sequenceOf(W_VOIDED_POST);

    await runRehead();

    const after = (await new ErpnextPostingService(env!.app).pullPostings({ tenantId: TENANT_A, since: cursor, limit: 500 })).items;
    expect(refs(after)).toEqual([W_CREDIT, W_UNLINKED]);
    // Rows still held for another reason (a reversal, a reversed sale) keep their place.
    expect(await sequenceOf(W_VOIDED_REVERSAL)).toBe(reversalBefore);
    expect(await sequenceOf(W_VOIDED_POST)).toBe(voidedPostBefore);
    // Idempotent in effect: a second run re-offers the same set, nothing else.
    const cursor2 = await sequenceOf(W_UNLINKED);
    await runRehead();
    const again = (await new ErpnextPostingService(env!.app).pullPostings({ tenantId: TENANT_A, since: cursor2, limit: 500 })).items;
    expect(refs(again)).toEqual([W_CREDIT, W_UNLINKED]);
  });
});
