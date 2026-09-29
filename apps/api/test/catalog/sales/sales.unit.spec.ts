/**
 * sales.unit.spec.ts — 008 US1 Docker-free unit coverage for the capture
 * controller + service branch logic (no Testcontainers).
 *
 * The HTTP/RLS behavior is proven by the Testcontainers capture + sweep suites;
 * this spec exercises the in-process branches those suites can't drive
 * deterministically (the ON CONFLICT loser + defensive throw, the IN-TRANSACTION
 * `sale.captured` outbox emit, the read-projection nullish fallbacks, and the
 * controller's guard / rethrow paths) by mocking the pg client and the
 * tenant-context runner.
 */
import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";

// runWithTenantContext is mocked to invoke its callback with a scripted client,
// so the service runs entirely in-process with no database.
//
// `emit` + `OUTBOX_EVENT_TYPES` are also mocked: the service now imports both
// (the IN-TRANSACTION `sale.captured` emit), so the mock module MUST export
// them or every fresh-capture test throws `Cannot read SALE_CAPTURED of
// undefined`. The fake `emit` issues the real `INSERT INTO outbox_events`
// query against the SAME scripted client, so the scripted INSERT branch fires
// and the in-tx emit is exercised exactly as production runs it (inside the
// transaction callback — a thrown INSERT therefore aborts capture).
let clientQuery: jest.Mock;
jest.mock("@data-pulse-2/db", () => ({
  runWithTenantContext: (
    _pool: unknown,
    _ctx: unknown,
    fn: (c: { query: jest.Mock }) => unknown,
  ) => fn({ query: clientQuery }),
  OUTBOX_EVENT_TYPES: { SALE_CAPTURED: "sale.captured" },
  emit: async (
    client: { query: jest.Mock },
    input: { eventType: string; payload: Record<string, unknown> },
  ): Promise<string> => {
    await client.query(
      `INSERT INTO outbox_events (event_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`,
      ["evt-1", input.eventType, JSON.stringify(input.payload)],
    );
    return "evt-1";
  },
}));

import {
  SalesService,
  SaleNotFoundError,
  TerminalEventProvenanceConflictError,
} from "../../../src/catalog/sales/sales.service";
import { SalesController } from "../../../src/catalog/sales/sales.controller";

const VALID_REF = "0d000000-0000-7000-8000-0000000000a1";

function body(overrides: Record<string, unknown> = {}): any {
  return {
    sourceSystem: "pos-1",
    externalId: "ext-1",
    currencyCode: "USD",
    posTotal: "12.5000",
    occurredAt: "2026-05-01T10:00:00.000Z",
    lines: [
      {
        lineName: "Widget",
        unitPrice: "12.5000",
        currencyCode: "USD",
        quantity: "1",
        lineAmount: "12.5000",
        unit: "ea",
      },
    ],
    ...overrides,
  };
}

/** A `sales` row as the read projection expects it from pg. */
function saleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VALID_REF,
    store_id: "0d000000-0000-7000-8000-0000000000b1",
    currency_code: "USD",
    pos_total: "12.5000",
    occurred_at: new Date("2026-05-01T10:00:00.000Z"),
    received_at: new Date("2026-05-01T10:00:01.000Z"),
    business_date: "2026-05-01",
    processed_at: null,
    source_clock_at: null,
    source_system: "pos-1",
    external_id: "ext-1",
    mismatch_flag: null,
    ...overrides,
  };
}

const CAPTURE = {
  tenantId: "0d000000-0000-7000-8000-0000000000c1",
  storeId: "0d000000-0000-7000-8000-0000000000b1",
  actorUserId: "0d000000-0000-7000-8000-0000000000d1",
};

/**
 * Route a scripted client.query by SQL shape so one mock serves both the
 * capture transaction and the subsequent read-projection transaction.
 */
function scriptClient(opts: {
  mismatchRows?: Array<{ mismatch: boolean }>;
  insertedRows?: Array<{ id: string }>;
  winnerRows?: Array<{ id: string }>;
  saleRows?: Array<Record<string, unknown>>;
  lineRows?: Array<Record<string, unknown>>;
  storeRows?: Array<{ timezone: string }>;
  /** When set, the IN-TRANSACTION outbox INSERT throws this (rollback path). */
  outboxError?: Error;
}): jest.Mock {
  return jest.fn(async (sql: string) => {
    if (/FROM stores WHERE id/.test(sql)) return { rows: opts.storeRows ?? [{ timezone: "UTC" }] };
    if (/SUM\(amt\)/.test(sql)) return { rows: opts.mismatchRows ?? [{ mismatch: false }] };
    if (/INSERT INTO outbox_events/.test(sql)) {
      if (opts.outboxError) throw opts.outboxError;
      return { rows: [] };
    }
    if (/INSERT INTO sales/.test(sql)) return { rows: opts.insertedRows ?? [{ id: VALID_REF }] };
    if (/SELECT id FROM sales/.test(sql)) return { rows: opts.winnerRows ?? [] };
    if (/INSERT INTO sale_lines/.test(sql)) return { rows: [] };
    if (/FROM sales WHERE id/.test(sql)) return { rows: opts.saleRows ?? [saleRow()] };
    // RT-73: the line read joins the cumulative returned quantity per line.
    if (/FROM sale_lines sl/.test(sql)) return { rows: opts.lineRows ?? [] };
    throw new Error(`unscripted query: ${sql}`);
  });
}

describe("SalesService — capture branches (unit)", () => {
  /** True iff the scripted client received the in-tx `sale.captured` INSERT. */
  function emittedOutbox(q: jest.Mock): boolean {
    return q.mock.calls.some(
      (c) =>
        /INSERT INTO outbox_events/.test(String(c[0])) &&
        JSON.stringify(c[1]).includes("sale.captured"),
    );
  }

  it("fresh capture inserts and emits the sale.captured outbox row IN-TRANSACTION, created=true", async () => {
    clientQuery = scriptClient({ insertedRows: [{ id: VALID_REF }] });
    const svc = new SalesService({} as never);

    const res = await svc.captureSale({ ...CAPTURE, body: body() });

    expect(res.created).toBe(true);
    expect(res.projection.saleRef).toBe(VALID_REF);
    // The outbox emit runs inside the SAME scripted client (same transaction) —
    // IDs-only payload (sale_id / store_id), no money / line amounts (FR-042/092).
    expect(emittedOutbox(clientQuery)).toBe(true);
    const outboxCall = clientQuery.mock.calls.find((c) =>
      /INSERT INTO outbox_events/.test(String(c[0])),
    );
    const payload = JSON.parse(String(outboxCall![1][2]));
    // sale_id is the freshly generated id (newId()), store_id is the caller's
    // store. The payload is EXACTLY these two keys — IDs only, no money / lines.
    expect(Object.keys(payload).sort()).toEqual(["sale_id", "store_id"]);
    expect(typeof payload.sale_id).toBe("string");
    expect(payload.store_id).toBe(CAPTURE.storeId);
    expect(JSON.stringify(payload)).not.toMatch(/posTotal|pos_total|line_amount|lineAmount/);
  });

  it("a failing in-tx outbox INSERT aborts the capture (atomic — rolls back)", async () => {
    // The emit is now INSIDE the transaction (replacing the old swallowed,
    // best-effort post-tx enqueue). A failing outbox INSERT must propagate so
    // the surrounding transaction rolls back — the sale and its event commit
    // together or not at all. The old "swallowed failure" semantics are gone.
    clientQuery = scriptClient({ outboxError: new Error("outbox insert failed") });
    const svc = new SalesService({} as never);
    await expect(svc.captureSale({ ...CAPTURE, body: body() })).rejects.toThrow(
      /outbox insert failed/,
    );
  });

  it("ON CONFLICT (zero rows) resolves to the existing row, created=false, does NOT emit", async () => {
    clientQuery = scriptClient({ insertedRows: [], winnerRows: [{ id: VALID_REF }] });
    const svc = new SalesService({} as never);

    const res = await svc.captureSale({ ...CAPTURE, body: body() });

    expect(res.created).toBe(false);
    expect(res.projection.saleRef).toBe(VALID_REF);
    // A dedup re-delivery must NOT emit a second outbox event (no double-emit).
    expect(emittedOutbox(clientQuery)).toBe(false);
  });

  it("ON CONFLICT but the winner row cannot be re-read → throws (defensive)", async () => {
    clientQuery = scriptClient({ insertedRows: [], winnerRows: [] });
    const svc = new SalesService({} as never);
    await expect(svc.captureSale({ ...CAPTURE, body: body() })).rejects.toThrow(
      /dedup conflict/,
    );
  });

  it("an empty comparison result defaults mismatch_flag to false", async () => {
    clientQuery = scriptClient({ mismatchRows: [] });
    const svc = new SalesService({} as never);
    const res = await svc.captureSale({ ...CAPTURE, body: body() });
    expect(res.created).toBe(true);
  });

  it("an unresolvable store timezone → throws (defensive; store always resolves in prod)", async () => {
    clientQuery = scriptClient({ storeRows: [] });
    const svc = new SalesService({} as never);
    await expect(svc.captureSale({ ...CAPTURE, body: body() })).rejects.toThrow(
      /store timezone not resolvable/,
    );
  });
});

describe("SalesService — readSaleProjection branches (unit)", () => {
  it("an absent row is a SaleNotFoundError (non-disclosing)", async () => {
    clientQuery = scriptClient({ saleRows: [] });
    const svc = new SalesService({} as never);
    await expect(
      svc.readSaleProjection(CAPTURE.tenantId, CAPTURE.storeId, VALID_REF),
    ).rejects.toBeInstanceOf(SaleNotFoundError);
  });

  it("maps a fully-populated row (Date business_date, non-null timestamps, mismatch)", async () => {
    clientQuery = scriptClient({
      saleRows: [
        saleRow({
          business_date: new Date("2026-05-01T00:00:00.000Z"),
          processed_at: new Date("2026-05-02T00:00:00.000Z"),
          source_clock_at: new Date("2026-05-01T09:59:00.000Z"),
          mismatch_flag: true,
        }),
      ],
      lineRows: [
        {
          line_name: "Widget",
          unit_price: "12.5000",
          currency_code: "USD",
          quantity: "1",
          line_amount: "12.5000",
          tax_amount: null,
          unit: "ea",
          tenant_product_ref: null,
        },
      ],
    });
    const svc = new SalesService({} as never);
    const p = await svc.readSaleProjection(CAPTURE.tenantId, CAPTURE.storeId, VALID_REF);
    expect(p.businessDate).toBe("2026-05-01");
    expect(p.processedAt).not.toBeNull();
    expect(p.sourceClockAt).not.toBeNull();
    expect(p.mismatchFlag).toBe(true);
    expect(p.lines).toHaveLength(1);
  });

  it("maps a minimal row (string business_date, null timestamps, null mismatch)", async () => {
    clientQuery = scriptClient({ saleRows: [saleRow()] });
    const svc = new SalesService({} as never);
    const p = await svc.readSaleProjection(CAPTURE.tenantId, CAPTURE.storeId, VALID_REF);
    expect(p.businessDate).toBe("2026-05-01");
    expect(p.processedAt).toBeNull();
    expect(p.sourceClockAt).toBeNull();
    expect(p.mismatchFlag).toBe(false);
  });
});

describe("SalesController — guard + status branches (unit)", () => {
  function makeRes(): { status: jest.Mock; setHeader: jest.Mock } {
    return { status: jest.fn(), setHeader: jest.fn() };
  }
  const ctx = { tenantId: CAPTURE.tenantId, storeId: CAPTURE.storeId, userId: CAPTURE.actorUserId };

  it("captureSale: missing context → 401", async () => {
    const c = new SalesController({} as never);
    await expect(
      c.captureSale({ context: undefined } as never, body() as never, makeRes() as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("captureSale: null tenantId → 401", async () => {
    const c = new SalesController({} as never);
    await expect(
      c.captureSale(
        { context: { ...ctx, tenantId: null } } as never,
        body() as never,
        makeRes() as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("captureSale: null userId → 401", async () => {
    const c = new SalesController({} as never);
    await expect(
      c.captureSale(
        { context: { ...ctx, userId: null } } as never,
        body() as never,
        makeRes() as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("captureSale: null storeId → 401 (store_context_required)", async () => {
    const c = new SalesController({} as never);
    await expect(
      c.captureSale(
        { context: { ...ctx, storeId: null } } as never,
        body() as never,
        makeRes() as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("readSale: null tenantId → 401", async () => {
    const c = new SalesController({ readSaleProjection: jest.fn() } as never);
    await expect(
      c.readSale({ context: { ...ctx, tenantId: null } } as never, VALID_REF),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("captureSale: created → 201; replay → 200 + replay header", async () => {
    const svc = {
      captureSale: jest
        .fn()
        .mockResolvedValueOnce({ created: true, projection: { saleRef: VALID_REF } })
        .mockResolvedValueOnce({ created: false, projection: { saleRef: VALID_REF } }),
    };
    const c = new SalesController(svc as never);

    const res1 = makeRes();
    await c.captureSale({ context: ctx } as never, body() as never, res1 as never);
    expect(res1.status).toHaveBeenCalledWith(201);

    const res2 = makeRes();
    await c.captureSale({ context: ctx } as never, body() as never, res2 as never);
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(res2.setHeader).toHaveBeenCalledWith("Idempotent-Replayed", "true");
  });

  it("readSale: missing context → 401, null store → 401, bad ref → 404", async () => {
    const c = new SalesController({ readSaleProjection: jest.fn() } as never);
    await expect(
      c.readSale({ context: undefined } as never, VALID_REF),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      c.readSale({ context: { ...ctx, storeId: null } } as never, VALID_REF),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      c.readSale({ context: ctx } as never, "not-a-uuid"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("readSale: SaleNotFoundError → 404; any other error rethrows", async () => {
    const notFound = new SalesController({
      readSaleProjection: jest.fn().mockRejectedValue(new SaleNotFoundError()),
    } as never);
    await expect(notFound.readSale({ context: ctx } as never, VALID_REF)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const boom = new SalesController({
      readSaleProjection: jest.fn().mockRejectedValue(new Error("db exploded")),
    } as never);
    await expect(boom.readSale({ context: ctx } as never, VALID_REF)).rejects.toThrow(
      /db exploded/,
    );
  });

  const voidBody = { sourceSystem: "pos-1", externalId: "v" };

  it("recordVoid: missing ctx / null tenant / null actor / null store → 401; bad ref → 404", async () => {
    const c = new SalesController({ recordVoid: jest.fn() } as never);
    for (const badCtx of [
      { context: undefined },
      { context: { ...ctx, tenantId: null } },
      { context: { ...ctx, userId: null } },
      { context: { ...ctx, storeId: null } },
    ]) {
      await expect(
        c.recordVoid(badCtx as never, VALID_REF, voidBody as never, makeRes() as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(
      c.recordVoid({ context: ctx } as never, "not-a-uuid", voidBody as never, makeRes() as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("recordVoid: created → 201; replay → 200 + replay header", async () => {
    const projection = { eventRef: "e", saleRef: VALID_REF, kind: "void" };
    const svc = {
      recordVoid: jest
        .fn()
        .mockResolvedValueOnce({ created: true, projection })
        .mockResolvedValueOnce({ created: false, projection }),
    };
    const c = new SalesController(svc as never);

    const r1 = makeRes();
    await c.recordVoid({ context: ctx } as never, VALID_REF, voidBody as never, r1 as never);
    expect(r1.status).toHaveBeenCalledWith(201);

    const r2 = makeRes();
    await c.recordVoid({ context: ctx } as never, VALID_REF, voidBody as never, r2 as never);
    expect(r2.status).toHaveBeenCalledWith(200);
    expect(r2.setHeader).toHaveBeenCalledWith("Idempotent-Replayed", "true");
  });

  it("recordVoid: SaleNotFoundError → 404; ProvenanceConflict → 409; other rethrows", async () => {
    const nf = new SalesController({
      recordVoid: jest.fn().mockRejectedValue(new SaleNotFoundError()),
    } as never);
    await expect(
      nf.recordVoid({ context: ctx } as never, VALID_REF, voidBody as never, makeRes() as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    const conflict = new SalesController({
      recordVoid: jest.fn().mockRejectedValue(new TerminalEventProvenanceConflictError()),
    } as never);
    await expect(
      conflict.recordVoid({ context: ctx } as never, VALID_REF, voidBody as never, makeRes() as never),
    ).rejects.toBeInstanceOf(ConflictException);

    const boom = new SalesController({
      recordVoid: jest.fn().mockRejectedValue(new Error("kaboom")),
    } as never);
    await expect(
      boom.recordVoid({ context: ctx } as never, VALID_REF, voidBody as never, makeRes() as never),
    ).rejects.toThrow(/kaboom/);
  });

  const refundBody = {
    sourceSystem: "pos-1",
    externalId: "r",
    posRefundAmount: "1.0000",
    currencyCode: "USD",
  };

  it("recordRefund: missing ctx / null tenant / null actor / null store → 401; bad ref → 404", async () => {
    const c = new SalesController({ recordRefund: jest.fn() } as never);
    for (const badCtx of [
      { context: undefined },
      { context: { ...ctx, tenantId: null } },
      { context: { ...ctx, userId: null } },
      { context: { ...ctx, storeId: null } },
    ]) {
      await expect(
        c.recordRefund(badCtx as never, VALID_REF, refundBody as never, makeRes() as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(
      c.recordRefund({ context: ctx } as never, "not-a-uuid", refundBody as never, makeRes() as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("recordRefund: created → 201; replay → 200 + replay header", async () => {
    const projection = {
      eventRef: "e",
      saleRef: VALID_REF,
      kind: "refund",
      posRefundAmount: "1.0000",
      currencyCode: "USD",
    };
    const svc = {
      recordRefund: jest
        .fn()
        .mockResolvedValueOnce({ created: true, projection })
        .mockResolvedValueOnce({ created: false, projection }),
    };
    const c = new SalesController(svc as never);

    const r1 = makeRes();
    await c.recordRefund({ context: ctx } as never, VALID_REF, refundBody as never, r1 as never);
    expect(r1.status).toHaveBeenCalledWith(201);

    const r2 = makeRes();
    await c.recordRefund({ context: ctx } as never, VALID_REF, refundBody as never, r2 as never);
    expect(r2.status).toHaveBeenCalledWith(200);
    expect(r2.setHeader).toHaveBeenCalledWith("Idempotent-Replayed", "true");
  });

  it("recordRefund: SaleNotFoundError → 404; ProvenanceConflict → 409; other rethrows", async () => {
    const nf = new SalesController({
      recordRefund: jest.fn().mockRejectedValue(new SaleNotFoundError()),
    } as never);
    await expect(
      nf.recordRefund({ context: ctx } as never, VALID_REF, refundBody as never, makeRes() as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    const conflict = new SalesController({
      recordRefund: jest.fn().mockRejectedValue(new TerminalEventProvenanceConflictError()),
    } as never);
    await expect(
      conflict.recordRefund({ context: ctx } as never, VALID_REF, refundBody as never, makeRes() as never),
    ).rejects.toBeInstanceOf(ConflictException);

    const boom = new SalesController({
      recordRefund: jest.fn().mockRejectedValue(new Error("kaboom")),
    } as never);
    await expect(
      boom.recordRefund({ context: ctx } as never, VALID_REF, refundBody as never, makeRes() as never),
    ).rejects.toThrow(/kaboom/);
  });
});
