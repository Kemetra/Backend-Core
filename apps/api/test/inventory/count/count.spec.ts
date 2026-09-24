/**
 * count.spec.ts — 009-US6-COUNT (T080–T083, RED).
 *
 * recordStockCount records a physical count; any variance from the derived
 * on-hand is appended as a `count_correction` movement (signed variance) linked
 * via `stock_count_id`. The movement history is NEVER rewritten (FR-021/SC-005).
 * After the count the derived on-hand equals the counted quantity. Driven over
 * the contract route `POST /api/inventory/v1/stores/{storeId}/counts`.
 *
 *   T080 — count with variance: appends a count_correction = signed variance,
 *           linked via stock_count_id; post-count on-hand == counted.
 *   T081 — no history rewrite (FR-021): the prior movements are untouched; the
 *           correction is an ADDITIONAL append.
 *   T082 — zero-variance count: deterministic — no correction movement,
 *           correctionMovement is null, on-hand unchanged.
 *   T083 — the correction is traceable: it carries movementType
 *           'count_correction' and references the recorded stock count.
 *
 * RED: recordStockCount does not exist on the service/controller yet.
 * Docker-gated (Testcontainers via the shared count harness).
 */
import {
  startCountHarness,
  stopCountHarness,
  resetHarness,
  idempKey,
  onHand,
  countBody,
  countsPath,
  PRODUCT_A_ACTIVE,
  PRODUCT_A_RETIRED,
  STORE_A_X,
  TENANT_A,
  type HarnessHandle,
} from './__count-harness';
import { formatQuantity, parseQuantity } from '../../../src/inventory/decimal-quantity';

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCountHarness());
}, 180_000);
afterAll(async () => {
  await stopCountHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));

async function movementCount(productId: string): Promise<number> {
  const r = await h.harness!.service.listStockMovements({
    tenantId: TENANT_A,
    storeId: STORE_A_X,
    productId,
  });
  return r.items.length;
}

describe('T080 — a count variance appends a signed count_correction (FR-021)', () => {
  it('records the correction = (counted − derived on-hand) and drives on-hand to counted', async () => {
    if (h.dockerSkipped || !h.harness) return;

    // PRODUCT_A_RETIRED has no seeded movements → on-hand 0; count to 5 → +5.
    const before = await onHand(h.harness, PRODUCT_A_RETIRED);

    const res = await h.harness
      .http()
      .post(countsPath())
      .set('Idempotency-Key', idempKey('us6count1'))
      .send(countBody({ countedQuantity: '5.0000' }));

    expect(res.status).toBe(201);
    expect(typeof res.body.stockCountId).toBe('string');
    expect(Number(res.body.countedQuantity)).toBe(5);
    // Signed variance = counted − on-hand-before.
    expect(Number(res.body.variance)).toBe(5 - before);
    // A correction movement was appended (variance != 0).
    expect(res.body.correctionMovement).not.toBeNull();
    expect(res.body.correctionMovement.movementType).toBe('count_correction');
    expect(Number(res.body.correctionMovement.quantity)).toBe(5 - before);

    // Post-count derived on-hand == counted quantity.
    expect(await onHand(h.harness, PRODUCT_A_RETIRED)).toBe(5);
  });
});

describe('T081 — the count never rewrites history (FR-021/SC-005)', () => {
  it('appends the correction as an ADDITIONAL movement, leaving prior movements intact', async () => {
    if (h.dockerSkipped || !h.harness) return;

    // PRODUCT_A_ACTIVE has seeded movements; count it and assert the existing
    // movements still exist + exactly one correction was appended.
    const before = await onHand(h.harness, PRODUCT_A_ACTIVE);
    const movesBefore = await movementCount(PRODUCT_A_ACTIVE);

    const target = before + 3;
    const res = await h.harness
      .http()
      .post(countsPath())
      .set('Idempotency-Key', idempKey('us6count2'))
      .send(countBody({ tenantProductRef: PRODUCT_A_ACTIVE, countedQuantity: `${target}.0000` }));

    expect(res.status).toBe(201);
    // Exactly ONE new movement (the correction) — nothing rewritten/removed.
    expect(await movementCount(PRODUCT_A_ACTIVE)).toBe(movesBefore + 1);
    expect(Number(res.body.variance)).toBe(3);
    expect(await onHand(h.harness, PRODUCT_A_ACTIVE)).toBe(target);
  });
});

describe('T082 — a zero-variance count is deterministic (no correction)', () => {
  it('records the count, appends NO correction movement, and leaves on-hand unchanged', async () => {
    if (h.dockerSkipped || !h.harness) return;

    // Count PRODUCT_A_RETIRED to its CURRENT on-hand → zero variance.
    const before = await onHand(h.harness, PRODUCT_A_RETIRED);
    const movesBefore = await movementCount(PRODUCT_A_RETIRED);

    const res = await h.harness
      .http()
      .post(countsPath())
      .set('Idempotency-Key', idempKey('us6zero'))
      .send(countBody({ countedQuantity: `${before}.0000` }));

    expect(res.status).toBe(201);
    expect(Number(res.body.variance)).toBe(0);
    expect(res.body.correctionMovement).toBeNull();
    // No correction appended; on-hand unchanged.
    expect(await movementCount(PRODUCT_A_RETIRED)).toBe(movesBefore);
    expect(await onHand(h.harness, PRODUCT_A_RETIRED)).toBe(before);
  });
});

describe('T083 — the correction is traceable to the recorded count', () => {
  it('links the count_correction movement to its stock_count via stock_count_id', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const before = await onHand(h.harness, PRODUCT_A_RETIRED);
    const res = await h.harness
      .http()
      .post(countsPath())
      .set('Idempotency-Key', idempKey('us6trace'))
      .send(countBody({ countedQuantity: `${before + 2}.0000` }));
    expect(res.status).toBe(201);

    // The correction movement persists with stock_count_id = the recorded count
    // (verified directly via admin — stock_count_id is not in the wire projection
    // but the biconditional CHECK in 0014 guarantees count_correction ⇒ it is set).
    const row = await h.harness.env.admin.query<{ stock_count_id: string; movement_type: string }>(
      `SELECT stock_count_id, movement_type FROM stock_movements WHERE id = $1`,
      [res.body.correctionMovement.id],
    );
    expect(row.rows[0]?.movement_type).toBe('count_correction');
    expect(row.rows[0]?.stock_count_id).toBe(res.body.stockCountId);
  });
});

describe('exact inventory quantity regression', () => {
  it('preserves a large fractional count and rejects an overflowing input', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const exact = '12345678901234.5678';
    const before = await h.harness.service.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_RETIRED,
    });
    const variance = formatQuantity(parseQuantity(exact) - parseQuantity(before.quantity));
    const accepted = await h.harness
      .http()
      .post(countsPath())
      .set('Idempotency-Key', idempKey('precisecount'))
      .send(countBody({ countedQuantity: exact }));
    expect(accepted.status).toBe(201);
    expect(accepted.body.countedQuantity).toBe(exact);
    expect(accepted.body.variance).toBe(variance);
    expect(accepted.body.correctionMovement.quantity).toBe(variance);

    const rejected = await h.harness
      .http()
      .post(countsPath())
      .set('Idempotency-Key', idempKey('overflowcount'))
      .send(countBody({ countedQuantity: '1000000000000000.0000' }));
    expect(rejected.status).toBe(400);
  });
});
