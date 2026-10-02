/**
 * Applies a request's {@link StoreScope} to the `app.current_store` GUC that
 * the 0011 `unknown_items_select` RLS policy reads (RT-131). Shared by
 * `UnknownItemsService` and `ReconciliationService`, which both touch
 * `unknown_items` inside `runWithTenantContext`.
 *
 * GUC values (0011 sentinel semantics):
 *   - `'*'`    → every store of the current tenant (tenant-wide carve-out)
 *   - `''`     → no store; the policy evaluates FALSE (fail closed)
 *   - `<uuid>` → that store only
 *
 * The RLS policy holds exactly one store, so a multi-store scope (a
 * `'specific'` member with several grants and no active store) is handled
 * per path: a single-item path pins the GUC to the item's own store when that
 * store is granted, so every later statement in the transaction is still
 * RLS-confined to one store; a list path uses `'*'` plus a `store_id = ANY`
 * predicate. An out-of-scope item is simply invisible, so callers keep their
 * existing non-disclosing 404 branches unchanged.
 */
import type { PoolClient } from "pg";

import type { StoreScope } from "../../context/store-scope";

const ALL_STORES = "*";
const NO_STORE = "";

async function setStoreGuc(client: PoolClient, value: string): Promise<void> {
  await client.query("SELECT set_config('app.current_store', $1, true)", [value]);
}

/**
 * Single-item paths (inspect, dismiss, link, create-product, reopen). After
 * this returns, the item is visible only if it is in `scope`.
 */
export async function applyItemStoreScope(
  client: PoolClient,
  scope: StoreScope | undefined,
  itemId: string,
): Promise<void> {
  if (scope?.kind === "tenant") return setStoreGuc(client, ALL_STORES);
  const storeIds = scope?.storeIds ?? [];
  if (storeIds.length === 0) return setStoreGuc(client, NO_STORE);
  if (storeIds.length === 1) return setStoreGuc(client, storeIds[0] as string);

  // Several granted stores: read the item's store under the tenant-wide
  // carve-out (tenant isolation still applies), then pin to it — or to no
  // store when it is not granted.
  await setStoreGuc(client, ALL_STORES);
  const res = await client.query<{ store_id: string }>(
    "SELECT store_id FROM unknown_items WHERE id = $1",
    [itemId],
  );
  const itemStoreId = res.rows[0]?.store_id;
  await setStoreGuc(
    client,
    itemStoreId !== undefined && storeIds.includes(itemStoreId) ? itemStoreId : NO_STORE,
  );
}

/**
 * List path. Returns the store IDs the caller must additionally filter on
 * (`store_id = ANY(...)`), or `null` when the GUC alone is the filter.
 */
export async function applyListStoreScope(
  client: PoolClient,
  scope: StoreScope | undefined,
): Promise<readonly string[] | null> {
  if (scope?.kind === "tenant") {
    await setStoreGuc(client, ALL_STORES);
    return null;
  }
  const storeIds = scope?.storeIds ?? [];
  if (storeIds.length <= 1) {
    await setStoreGuc(client, storeIds[0] ?? NO_STORE);
    return null;
  }
  await setStoreGuc(client, ALL_STORES);
  return storeIds;
}
