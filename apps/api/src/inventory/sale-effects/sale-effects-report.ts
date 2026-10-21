/**
 * After-commit reporting of skipped void / return Inventory Effects (Jira
 * RT-427, owner decision 2).
 *
 * A void or return writes its effects inside its own transaction
 * (`@data-pulse-2/db` `writeVoidEffects` / `writeReturnEffects`). A line whose
 * effect cannot be written exactly is skipped, never fails the reversal; the
 * gap must still be observable. The writer's outcome is collected here inside
 * the transaction and flushed only after it commits, so a rolled-back attempt
 * never reports a skip.
 *
 * One `inventory_sale_effect_skipped_total{event_type, reason}` increment and
 * one `inventory.sale_effect.skipped` warn line per skipped line. Identifiers
 * and closed codes only (§XIV): no quantity, unit, product name or amount.
 */
import type { SaleEffectsOutcome } from "@data-pulse-2/db";
import type { Logger } from "@data-pulse-2/shared";

import { createApiLogger } from "../../common/api-logger";
import { recordInventorySaleEffectSkipped } from "../../observability/metrics/api.metrics";

/** The reversal an outcome belongs to. */
export interface SaleEffectsScope {
  readonly tenantId: string;
  readonly storeId: string;
  readonly saleId: string;
  /** The void or return id. */
  readonly eventRefId: string;
}

let defaultLogger: Pick<Logger, "warn"> | undefined;

function logger(): Pick<Logger, "warn"> {
  defaultLogger ??= createApiLogger("inventory.sale-effects");
  return defaultLogger;
}

export class SaleEffectsReport {
  private readonly pending: Array<{ readonly outcome: SaleEffectsOutcome; readonly scope: SaleEffectsScope }> = [];

  constructor(private readonly log: Pick<Logger, "warn"> = logger()) {}

  /** Collect a writer outcome (inside the transaction). */
  add(outcome: SaleEffectsOutcome, scope: SaleEffectsScope): void {
    if (outcome.skipped.length > 0) this.pending.push({ outcome, scope });
  }

  /** Report every collected skip (after COMMIT); clears the collection. */
  flush(): void {
    for (const { outcome, scope } of this.pending.splice(0)) {
      for (const line of outcome.skipped) {
        recordInventorySaleEffectSkipped(outcome.event, line.reason);
        this.log.warn(
          {
            event: "inventory.sale_effect.skipped",
            event_type: outcome.event,
            event_ref_id: scope.eventRefId,
            reason: line.reason,
            line_id: line.lineId,
            tenant_id: scope.tenantId,
            store_id: scope.storeId,
            sale_id: scope.saleId,
          },
          "reversal line written without an inventory effect",
        );
      }
    }
  }
}
