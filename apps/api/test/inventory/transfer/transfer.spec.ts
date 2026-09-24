/**
 * transfer.spec.ts — 009-US5-TRANSFER (T070–T073, RED).
 *
 * A stock transfer is LINKED movements (FR-020): a `transfer_out` at the source
 * store + a `transfer_in` at the destination, sharing a `transfer_group_id`, so
 * they are mutually discoverable (SC-004). Driven over the contract route
 * `POST /api/inventory/v1/transfers` (operationId createStockTransfer).
 *
 *   T070 — happy path: source on-hand −N, destination +N, both movements share
 *           a transfer group, response is the {transferGroupId, outbound, inbound}
 *           StockTransfer projection.
 *   T071 — both legs discoverable from either store's movement list (SC-004).
 *   T072 — cross-tenant destination → non-disclosing 404 (FR-051); same-store
 *           and zero / negative quantity → 400 (validation).
 *   T073 — allow-and-flag: a transfer-out driving source on-hand below zero is
 *           still recorded as linked movements; source on-hand goes negative,
 *           never rejected (FR-024).
 *
 * RED: createStockTransfer does not exist on the service/controller yet.
 * Docker-gated (Testcontainers via the shared transfer harness).
 */
import {
  startTransferHarness,
  stopTransferHarness,
  resetHarness,
  idempKey,
  onHand,
  transferBody,
  TRANSFERS_PATH,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  type HarnessHandle,
} from './__transfer-harness';

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startTransferHarness());
}, 180_000);
afterAll(async () => {
  await stopTransferHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));

describe('T070 — a transfer appends linked transfer_out + transfer_in (FR-020)', () => {
  it('decrements source on-hand, increments destination, and shares a transfer group', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const srcBefore = await onHand(h.harness, STORE_A_X);
    const dstBefore = await onHand(h.harness, STORE_A_Y);

    const res = await h.harness
      .http()
      .post(TRANSFERS_PATH)
      .set('Idempotency-Key', idempKey('us5xfer1'))
      .send(transferBody({ quantity: '4.0000' }));

    expect(res.status).toBe(201);
    // StockTransfer projection: { transferGroupId, outbound, inbound }.
    expect(typeof res.body.transferGroupId).toBe('string');
    expect(res.body.outbound.movementType).toBe('transfer_out');
    expect(res.body.inbound.movementType).toBe('transfer_in');
    expect(res.body.outbound.storeId).toBe(STORE_A_X);
    expect(res.body.inbound.storeId).toBe(STORE_A_Y);
    // Both legs carry the SAME transfer group id (the linkage).
    expect(res.body.outbound.transferGroupId).toBe(res.body.transferGroupId);
    expect(res.body.inbound.transferGroupId).toBe(res.body.transferGroupId);
    // Outbound is signed negative, inbound positive.
    expect(Number(res.body.outbound.quantity)).toBe(-4);
    expect(Number(res.body.inbound.quantity)).toBe(4);

    // On-hand: source −4, destination +4.
    expect((await onHand(h.harness, STORE_A_X)) - srcBefore).toBe(-4);
    expect((await onHand(h.harness, STORE_A_Y)) - dstBefore).toBe(4);
  });
});

describe('T071 — both legs are discoverable from either store (SC-004)', () => {
  it('lists the counterpart movement at source and destination via the shared group', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const res = await h.harness
      .http()
      .post(TRANSFERS_PATH)
      .set('Idempotency-Key', idempKey('us5xfer2'))
      .send(transferBody({ quantity: '2.0000' }));
    expect(res.status).toBe(201);
    const groupId = res.body.transferGroupId;

    // Read both legs via the service (the default operator is store-A.X-scoped,
    // so a route GET on the A.Y store would be a non-disclosing 404 — the
    // discoverability invariant is at the ledger/service layer, exercised
    // directly here, mirroring the onHand() helper).
    const srcList = await h.harness.service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    const srcLeg = srcList.items.find((m) => m.id === res.body.outbound.id);
    expect(srcLeg?.transferGroupId).toBe(groupId);

    const dstList = await h.harness.service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_Y,
      productId: PRODUCT_A_ACTIVE,
    });
    const dstLeg = dstList.items.find((m) => m.id === res.body.inbound.id);
    expect(dstLeg?.transferGroupId).toBe(groupId);
  });
});

describe('T072 — invalid transfers are rejected', () => {
  it('cross-tenant destination → non-disclosing 404 (FR-051)', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const res = await h.harness
      .http()
      .post(TRANSFERS_PATH)
      .set('Idempotency-Key', idempKey('us5xtenant'))
      .send(transferBody({ destinationStoreId: STORE_B_X }));
    expect(res.status).toBe(404);
  });

  it('same-store transfer → 400 validation error', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const res = await h.harness
      .http()
      .post(TRANSFERS_PATH)
      .set('Idempotency-Key', idempKey('us5same'))
      .send(transferBody({ destinationStoreId: STORE_A_X }));
    expect(res.status).toBe(400);
  });

  it('zero / negative quantity → 400 validation error', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const zero = await h.harness
      .http()
      .post(TRANSFERS_PATH)
      .set('Idempotency-Key', idempKey('us5zero'))
      .send(transferBody({ quantity: '0.0000' }));
    expect(zero.status).toBe(400);

    const neg = await h.harness
      .http()
      .post(TRANSFERS_PATH)
      .set('Idempotency-Key', idempKey('us5neg'))
      .send(transferBody({ quantity: '-1.0000' }));
    expect(neg.status).toBe(400);
  });
});

describe('T073 — allow-and-flag: transfer-out may drive source negative (FR-024)', () => {
  it('records the linked transfer even when source on-hand goes below zero, never rejects', async () => {
    if (h.dockerSkipped || !h.harness) return;

    // Source A.X seed on-hand is small (inbound 10, outbound 3 → 7). Transfer a
    // quantity that drives it negative.
    const srcBefore = await onHand(h.harness, STORE_A_X);

    const res = await h.harness
      .http()
      .post(TRANSFERS_PATH)
      .set('Idempotency-Key', idempKey('us5negbal'))
      .send(transferBody({ quantity: String(srcBefore + 5) + '.0000' }));

    expect(res.status).toBe(201);
    const after = await onHand(h.harness, STORE_A_X);
    expect(after).toBeLessThan(0);
    // The on-hand read flags the negative balance (FR-024).
    const onHandBody = await h.harness.service.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    expect(onHandBody.negativeBalance).toBe(true);
  });
});

describe('exact inventory quantity regression', () => {
  it('writes exact opposite large fractional legs', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const res = await h.harness
      .http()
      .post(TRANSFERS_PATH)
      .set('Idempotency-Key', idempKey('precisetransfer'))
      .send(transferBody({ quantity: '12345678901234.5678' }));
    expect(res.status).toBe(201);
    expect(res.body.outbound.quantity).toBe('-12345678901234.5678');
    expect(res.body.inbound.quantity).toBe('12345678901234.5678');
  });
});
