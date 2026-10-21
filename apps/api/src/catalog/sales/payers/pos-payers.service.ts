/**
 * PosPayersService — RT-802: `posListChargeablePayers`
 * (`pos-payers.openapi.yaml` 1.0.0-draft, RT-570 decision O2).
 *
 * One transaction on the domain pool under the envelope's tenant (RLS):
 *   1. the operator's CURRENT standing: an active owner / tenant_admin /
 *      store_manager with access to the store, the check `captureSale` makes
 *      for `responsibilities[]` (`assertCreditOperatorEligible`), else
 *      `SaleResponsibilityRoleRefusedError` (403). It runs before the query is
 *      validated, so the contract's 403-before-400 order holds;
 *   2. the query (ZodError → the 400 envelope) and the cursor (400);
 *   3. one keyset page of the payers `payerInScopeSql` admits for the
 *      envelope's tenant and store (active, this store or tenant-wide), by
 *      payerRef DESC. Store scope is not in RLS, so it is matched here.
 *
 * `chargeable` is `chargeablePayerSql`, the same fragment capture's refusal 4
 * filters by; `erpCustomerLinked` is its link part. The read locks and writes
 * nothing: capture re-checks under FOR SHARE and stays the authority.
 * Minimum disclosure: no `external_ref`, store, status, version or tenant
 * leaves this service.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../../auth/auth.module";
import type { PayerCategory } from "../../../settlement/dto/payer-account.dto";
import {
  assertCreditOperatorEligible,
  chargeablePayerSql,
  PAYER_LINKED_SQL,
  payerInScopeSql,
} from "../sale-responsibilities";
import {
  decodePosPayersCursor,
  encodePosPayersCursor,
  POS_PAYERS_PAGE_SIZE_DEFAULT,
  PosPayersQuerySchema,
} from "./pos-payers.query";

export interface ListChargeablePayersInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly actorUserId: string;
  /** The raw query string object, validated only after the role check. */
  readonly rawQuery: unknown;
}

/** The contract `PosPayer` wire shape. */
export interface PosPayer {
  readonly payerRef: string;
  readonly displayName: string;
  readonly category: PayerCategory;
  readonly erpCustomerLinked: boolean;
  readonly chargeable: boolean;
}

/** The contract `PosPayerPage` wire shape. */
export interface PosPayerPage {
  readonly items: PosPayer[];
  readonly nextCursor: string | null;
  readonly asOf: string;
}

interface PosPayerRow {
  readonly id: string;
  readonly display_name: string;
  readonly category: PayerCategory;
  readonly erp_customer_linked: boolean;
  readonly chargeable: boolean;
}

/**
 * $1 tenant, $2 store, $3 category (NULL: any), $4 last payerRef (NULL: first
 * page), $5 limit. A NULL `external_ref` makes the predicates NULL, which a
 * WHERE treats as false; the projection must say false too.
 */
const PAGE_SQL = `
  SELECT id::text AS id, display_name, category,
         COALESCE(${PAYER_LINKED_SQL}, false) AS erp_customer_linked,
         COALESCE(${chargeablePayerSql({ tenant: "$1", store: "$2" })}, false) AS chargeable
    FROM payer_account
   WHERE ${payerInScopeSql({ tenant: "$1", store: "$2" })}
     AND ($3::text IS NULL OR category = $3)
     AND ($4::uuid IS NULL OR id < $4::uuid)
   ORDER BY id DESC
   LIMIT $5`;

@Injectable()
export class PosPayersService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  list(input: ListChargeablePayersInput): Promise<PosPayerPage> {
    const { tenantId, storeId } = input;
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      await assertCreditOperatorEligible(client, { tenantId, storeId }, input.actorUserId);

      const query = PosPayersQuerySchema.parse(input.rawQuery);
      const category = query.category ?? null;
      const after = query.cursor === undefined ? null : decodePosPayersCursor({ tenantId, storeId, category, cursor: query.cursor });
      const limit = query.page_size ?? POS_PAYERS_PAGE_SIZE_DEFAULT;

      const asOf = await readTime(client);
      // One row past the page tells whether a next page exists.
      const r = await client.query<PosPayerRow>(PAGE_SQL, [tenantId, storeId, category, after, limit + 1]);
      const rows = r.rows.slice(0, limit);
      const last = rows.at(-1);
      const nextCursor =
        r.rows.length > limit && last !== undefined
          ? encodePosPayersCursor({ tenantId, storeId, category, lastPayerRef: last.id })
          : null;
      return { items: rows.map(toPosPayer), nextCursor, asOf };
    });
  }
}

/** The server time the page is read at (the transaction's `now()`), as UTC ISO-8601. */
async function readTime(client: PoolClient): Promise<string> {
  const r = await client.query<{ as_of: Date | string }>("SELECT now() AS as_of");
  return new Date(r.rows[0]!.as_of).toISOString();
}

function toPosPayer(row: PosPayerRow): PosPayer {
  return {
    payerRef: row.id,
    displayName: row.display_name,
    category: row.category,
    erpCustomerLinked: row.erp_customer_linked,
    chargeable: row.chargeable,
  };
}
