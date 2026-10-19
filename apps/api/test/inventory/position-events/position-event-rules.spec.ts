/**
 * position-event-rules.spec.ts — Jira RT-435 (pure rules, no I/O).
 *
 *   - M-5: an event nets to zero per (bucket, product, tracking) ⇒ ERP-neutral;
 *     the same effects split across two buckets do not (the cross-bucket case
 *     fails closed until Gate 8). The V1 resolver maps every location and
 *     status of a store to one bucket.
 *   - D1: the Reason Code → (from, to) table, the reserved hold codes, and the
 *     note required by `correction`.
 *   - D2: the sensitive source statuses and the roles allowed to move out of
 *     them.
 */
import { INVENTORY_REASON_CODES, INVENTORY_STATUSES, type InventoryStatus } from '@data-pulse-2/db';

import {
  PositionEventRuleError,
  assertRelocationAllowed,
  assertStatusMoveAllowed,
  isSensitiveMove,
  maySensitiveMove,
  netsToZeroPerBucket,
  v1MappingBucket,
} from '../../../src/inventory/position-events/position-event.rules';

const STORE = '0a000000-0000-7000-8000-00000000a5a1';
const STORE_2 = '0a000000-0000-7000-8000-00000000a5a2';
const PRODUCT = '0a000000-0000-7000-8000-00000000a401';
const PRODUCT_2 = '0a000000-0000-7000-8000-00000000a402';
const LOT = '0a000000-0000-7000-8000-0000000435c1';

describe('M-5 per-bucket net rule', () => {
  const pair = (fromBucket: string, toBucket: string, overrides: { product?: string; tracking?: string | null } = {}) => [
    { bucket: fromBucket, tenantProductRef: PRODUCT, trackingIdentityId: null, quantity: '-3.0000' },
    {
      bucket: toBucket,
      tenantProductRef: overrides.product ?? PRODUCT,
      trackingIdentityId: overrides.tracking ?? null,
      quantity: '3.0000',
    },
  ];

  it('a pair within one bucket nets to zero (ERP-neutral)', () => {
    expect(netsToZeroPerBucket(pair('b1', 'b1'))).toBe(true);
  });

  it('the same pair across two buckets does not (fails closed until Gate 8)', () => {
    expect(netsToZeroPerBucket(pair('b1', 'b2'))).toBe(false);
  });

  it('nets per product and per tracking identity, not across them', () => {
    expect(netsToZeroPerBucket(pair('b1', 'b1', { product: PRODUCT_2 }))).toBe(false);
    expect(netsToZeroPerBucket(pair('b1', 'b1', { tracking: LOT }))).toBe(false);
  });

  it('nets exactly at numeric(19,4) scale', () => {
    expect(
      netsToZeroPerBucket([
        { bucket: 'b1', tenantProductRef: PRODUCT, trackingIdentityId: null, quantity: '-0.0001' },
        { bucket: 'b1', tenantProductRef: PRODUCT, trackingIdentityId: null, quantity: '0.0001' },
      ]),
    ).toBe(true);
  });

  it('V1 maps every location and status of a store to the store bucket, and stores apart', () => {
    expect(v1MappingBucket(STORE)).toBe(v1MappingBucket(STORE.toUpperCase()));
    expect(v1MappingBucket(STORE)).not.toBe(v1MappingBucket(STORE_2));
  });
});

describe('D1 Reason Codes on a status move', () => {
  const ALLOWED: ReadonlyArray<[string, InventoryStatus, InventoryStatus]> = [
    ['damage', 'sellable', 'damaged'],
    ['expiry', 'sellable', 'expired'],
    ['inspection_restock', 'return_inspection', 'sellable'],
    ['inspection_damage', 'return_inspection', 'damaged'],
    ['hold_release', 'quality_hold', 'sellable'],
  ];

  it('allows exactly the governed pair of each code', () => {
    for (const code of ['damage', 'expiry', 'inspection_restock', 'inspection_damage', 'hold_release'] as const) {
      for (const from of INVENTORY_STATUSES) {
        for (const to of INVENTORY_STATUSES) {
          if (from === to) continue;
          const allowed = ALLOWED.some(([c, f, t]) => c === code && f === from && t === to);
          const run = () => assertStatusMoveAllowed({ fromStatus: from, toStatus: to, reasonCode: code, note: null });
          if (allowed) expect(run).not.toThrow();
          else expect(run).toThrow(PositionEventRuleError);
        }
      }
    }
  });

  it('a recall hold is never released by a status move (G7-6)', () => {
    expect(() =>
      assertStatusMoveAllowed({ fromStatus: 'recall_hold', toStatus: 'sellable', reasonCode: 'hold_release', note: null }),
    ).toThrow(PositionEventRuleError);
  });

  it('correction: any pair outside the hold statuses, with a note', () => {
    expect(() =>
      assertStatusMoveAllowed({ fromStatus: 'damaged', toStatus: 'sellable', reasonCode: 'correction', note: 'n' }),
    ).not.toThrow();
    expect(() =>
      assertStatusMoveAllowed({ fromStatus: 'damaged', toStatus: 'sellable', reasonCode: 'correction', note: null }),
    ).toThrow(/requires a note/);
    for (const hold of ['quality_hold', 'recall_hold'] as const) {
      expect(() =>
        assertStatusMoveAllowed({ fromStatus: 'sellable', toStatus: hold, reasonCode: 'correction', note: 'n' }),
      ).toThrow(PositionEventRuleError);
      expect(() =>
        assertStatusMoveAllowed({ fromStatus: hold, toStatus: 'sellable', reasonCode: 'correction', note: 'n' }),
      ).toThrow(PositionEventRuleError);
    }
  });

  it('the hold codes are reserved for RT-449', () => {
    for (const code of ['quality_hold', 'recall'] as const) {
      expect(() =>
        assertStatusMoveAllowed({ fromStatus: 'sellable', toStatus: 'quality_hold', reasonCode: code, note: null }),
      ).toThrow(/reserved/);
    }
  });

  it('a same-status move is refused before the code is checked', () => {
    expect(() =>
      assertStatusMoveAllowed({ fromStatus: 'sellable', toStatus: 'sellable', reasonCode: 'correction', note: 'n' }),
    ).toThrow(/must differ/);
  });

  it('covers every governed code', () => {
    expect([...INVENTORY_REASON_CODES].sort()).toEqual(
      ['correction', 'damage', 'expiry', 'hold_release', 'inspection_damage', 'inspection_restock', 'quality_hold', 'recall'],
    );
  });
});

describe('D1 relocation codes', () => {
  const LOC_A = '0a000000-0000-7000-8000-0000000435b1';
  const LOC_B = '0a000000-0000-7000-8000-0000000435b2';

  it('needs two different locations; a code is optional', () => {
    expect(() => assertRelocationAllowed({ fromLocationId: LOC_A, toLocationId: LOC_B, reasonCode: null, note: null })).not.toThrow();
    expect(() =>
      assertRelocationAllowed({ fromLocationId: LOC_A, toLocationId: LOC_A.toUpperCase(), reasonCode: null, note: null }),
    ).toThrow(/must differ/);
  });

  it('refuses a reserved code and a correction without a note', () => {
    expect(() => assertRelocationAllowed({ fromLocationId: LOC_A, toLocationId: LOC_B, reasonCode: 'recall', note: null })).toThrow(
      /reserved/,
    );
    expect(() =>
      assertRelocationAllowed({ fromLocationId: LOC_A, toLocationId: LOC_B, reasonCode: 'correction', note: null }),
    ).toThrow(/requires a note/);
  });
});

describe('D2 sensitivity', () => {
  it('a move out of damaged, expired or a hold is sensitive', () => {
    expect(INVENTORY_STATUSES.filter(isSensitiveMove).sort()).toEqual(['damaged', 'expired', 'quality_hold', 'recall_hold']);
  });

  it('only owner, tenant_admin or a platform admin may make one', () => {
    expect(maySensitiveMove('owner', false)).toBe(true);
    expect(maySensitiveMove('tenant_admin', false)).toBe(true);
    expect(maySensitiveMove('store_manager', false)).toBe(false);
    expect(maySensitiveMove(null, false)).toBe(false);
    expect(maySensitiveMove(null, true)).toBe(true);
  });
});
