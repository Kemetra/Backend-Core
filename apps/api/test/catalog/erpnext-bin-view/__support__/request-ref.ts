/**
 * RT-688 — the `requestRef` the bin-view feed offers for a run: bound to the
 * run AND its store's currently active `stock` warehouse map
 * (`binViewRequestRef`). Map ids are minted by the seeds, so tests read the
 * active map id back instead of hard-coding a ref. A run whose store has no
 * active stock map gets a ref under a placeholder map id (it resolves to
 * nothing, like any ref for an unmapped store). `.ts` (not `.spec.ts`) so Jest
 * does not collect it.
 */
import type { Pool } from "pg";

import { binViewRequestRef } from "../../../../src/catalog/erpnext-bin-view/erpnext-bin-view.service";

const NO_ACTIVE_MAP = "00000000-0000-7000-8000-000000000000";

export async function requestRefFor(admin: Pool, runId: string): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `SELECT whm.id
       FROM erpnext_reconciliation_run run
       JOIN erpnext_warehouse_map whm
         ON whm.store_id = run.store_id
        AND whm.purpose = 'stock'
        AND whm.retired_at IS NULL
      WHERE run.id = $1`,
    [runId],
  );
  return binViewRequestRef(runId, r.rows[0]?.id ?? NO_ACTIVE_MAP);
}
