/**
 * hold-move-rules.spec.ts — Jira RT-449 (G7-6; owner rulings H3 / H4, RT-449
 * comment 13434). Pure: which positions a hold command moves, where to, and
 * under which reserved RT-435 Reason Code.
 */
import { placementMoves, releaseMoves } from '../../../src/inventory/safety/hold-move.rules';

describe('placementMoves (G7-6)', () => {
  it('a quality hold moves sellable and return_inspection into quality_hold, reason quality_hold', () => {
    expect(placementMoves('quality_hold')).toEqual({
      fromStatuses: ['sellable', 'return_inspection'],
      toStatus: 'quality_hold',
      reasonCode: 'quality_hold',
    });
  });

  it('a recall hold moves sellable and return_inspection into recall_hold, reason recall', () => {
    expect(placementMoves('recall_hold')).toEqual({
      fromStatuses: ['sellable', 'return_inspection'],
      toStatus: 'recall_hold',
      reasonCode: 'recall',
    });
  });
});

describe('releaseMoves', () => {
  it('H3: a released quality hold of a never-recalled identity returns quality_hold to sellable', () => {
    expect(releaseMoves('quality_hold', { everRecalled: false })).toEqual({
      fromStatuses: ['quality_hold'],
      toStatus: 'sellable',
      reasonCode: 'hold_release',
    });
  });

  it('H3 for an identity ever recalled (ruling B): the quality_hold quantity goes to recall_hold, never sellable', () => {
    expect(releaseMoves('quality_hold', { everRecalled: true })).toEqual({
      fromStatuses: ['quality_hold'],
      toStatus: 'recall_hold',
      reasonCode: 'recall',
    });
  });

  it('H4: releasing a recall hold moves nothing (Gate 8 disposition owns that stock)', () => {
    expect(releaseMoves('recall_hold', { everRecalled: false })).toBeNull();
    expect(releaseMoves('recall_hold', { everRecalled: true })).toBeNull();
  });
});
