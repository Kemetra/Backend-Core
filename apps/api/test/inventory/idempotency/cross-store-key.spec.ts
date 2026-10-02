/**
 * cross-store-key.spec.ts — Jira RT-155 AC3 (RT-82 K1).
 *
 * createStockMovement has no second dedup layer, so a replay across stores was
 * a silent lost write and a re-run a double-post. The Idempotency-Key is now
 * bound to the resolved `:storeId`: the same key + body on another store posts
 * that store's own movement exactly once, and does not replay the first
 * store's movement. A tenant-wide principal (no bound store) addresses both.
 *
 * Docker-gated.
 */
import {
  startMovementHarness,
  stopMovementHarness,
  resetHarness,
  idempKey,
  movementsPath,
  movementBody,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  TENANT_A,
  type HarnessHandle,
} from './__movement-harness';
import { STORE_A_Y } from '../../catalog/__support__/isolation-harness';
import { InventoryService } from '../../../src/inventory/inventory.service';

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startMovementHarness());
}, 180_000);
afterAll(async () => {
  await stopMovementHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));

async function onHand(storeId: string): Promise<number> {
  const svc = new InventoryService(h.harness!.env.app as never);
  const r = await svc.getOnHand({ tenantId: TENANT_A, storeId, productId: PRODUCT_A_ACTIVE });
  return Number(r.quantity);
}

describe('RT-155 AC3 — movement keys are scoped to the path storeId', () => {
  it('same key + same body on another store posts once per store, with no cross-store replay', async () => {
    if (h.dockerSkipped || !h.harness) return;
    h.harness.contextGuard.storeId = null; // tenant-wide principal
    const key = idempKey('rt155store');
    const body = movementBody({ movementType: 'inbound', quantity: '4.0000' });
    const beforeX = await onHand(STORE_A_X);
    const beforeY = await onHand(STORE_A_Y);

    const onX = await h.harness.http().post(movementsPath(STORE_A_X)).set('Idempotency-Key', key).send(body);
    expect(onX.status).toBe(201);
    const onY = await h.harness.http().post(movementsPath(STORE_A_Y)).set('Idempotency-Key', key).send(body);
    expect(onY.status).toBe(201);
    expect(onY.headers['idempotent-replayed']).toBeUndefined();
    expect(onY.body.id).not.toBe(onX.body.id);

    // Same-store retries replay; neither store is double-posted.
    const retryX = await h.harness.http().post(movementsPath(STORE_A_X)).set('Idempotency-Key', key).send(body);
    const retryY = await h.harness.http().post(movementsPath(STORE_A_Y)).set('Idempotency-Key', key).send(body);
    expect(retryX.headers['idempotent-replayed']).toBe('true');
    expect(retryX.body.id).toBe(onX.body.id);
    expect(retryY.headers['idempotent-replayed']).toBe('true');
    expect(retryY.body.id).toBe(onY.body.id);

    expect((await onHand(STORE_A_X)) - beforeX).toBe(4);
    expect((await onHand(STORE_A_Y)) - beforeY).toBe(4);
  });
});
